"""Run orchestration: targets in, rows in Postgres out.

The runner is the seam between the network side (adapter/client/session) and the
storage side (store/db). It owns:

* resolving CLI arguments into a concrete list of targets;
* looping targets **continue-on-error** — one dead keyword or renamed shop must
  never abort the remaining targets (the one exception is
  :data:`MAX_CONSECUTIVE_BLOCKED_TARGETS` back-to-back blocks, which stops the
  invocation rather than keep hammering a marketplace that has stopped serving
  us);
* keeping transactions off the network path: per target, one short transaction
  commits the RUNNING audit row, the fetch runs with **no** transaction open, and
  a second transaction persists the items and closes the run. Holding one open
  across the fetch left the connection ``idle in transaction`` for the whole
  scrape, which a timeout or a transaction pooler kills;
* isolating each item in a SAVEPOINT, so a row Postgres rejects costs that row
  and not its 599 siblings;
* writing exactly one :class:`~scraper.models.ScrapeRun` row per target.

Persistence order per scraped item is fixed by the foreign keys::

    upsert_store   -> shop_ref
    upsert_product(..., shop_ref) -> product_ref
    insert_snapshot(..., product_ref)

Failure taxonomy, and what each does to the run:

======================================  =================================================
:class:`~scraper.client.BlockedError`   Target -> FAILED. Runner continues to the next
                                        target (the client already retried once after a
                                        re-bootstrap).
``LookupError``                         Shop does not exist. Target -> FAILED, continue.
Per-item parse errors                   Swallowed inside the adapter; the target can
                                        still finish SUCCESS with a lower item_count.
Per-item write errors                   Rolled back to that item's SAVEPOINT. The target
                                        finishes PARTIAL with the surviving items and an
                                        ``error`` naming the count and first cause.
Adapter reports schema drift            Raw entries returned but none parseable -> the
                                        target finishes PARTIAL, never SUCCESS/0.
Any other exception                     Target -> FAILED with ``error`` set to the repr,
                                        continue.
``KeyboardInterrupt``                   Propagates. The in-flight target's transaction
                                        rolls back; already-committed targets stand.
======================================  =================================================

Two public entry points, same engine underneath:

* the module-level :func:`run` / :func:`run_target` / :func:`resolve_targets`
  functions, which the CLI calls;
* :class:`ScrapeRunner`, a stateful object holding one adapter, one shop cache
  and one progress reporter for a whole invocation. ``run_keywords`` and
  ``run_stores`` are its two verbs and both return a :class:`RunSummary`.

Shop caching. Within one invocation the runner remembers
``(marketplace, shop_id) -> stores.id`` and ``-> username``, so a shop seen on
target 1 is neither re-requested (no second ``adapter.get_shop``) nor re-upserted
on targets 2..n. Cache entries are staged per target and only promoted to the
invocation-wide cache once that target's transaction **commits** — a ``stores.id``
minted inside a transaction that later rolled back would be a dangling reference.

The runner does not de-duplicate items within a target: adapters are contractually
required to return one :class:`~scraper.adapters.ScrapedItem` per ``item_id``, and
silently collapsing repeats here would hide an adapter bug while still corrupting
the time series. It does de-duplicate *across* targets of one invocation, which is
a different thing: two overlapping keywords legitimately returning the same listing
is one observation, and snapshotting it twice milliseconds apart puts duplicate
points on the price chart and makes any sold-delta velocity divide by ~0.
"""

from __future__ import annotations

import logging
import sys
import time
from collections.abc import Callable, Iterable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Protocol

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
from sqlalchemy.orm import Session

from scraper import db
from scraper import store as store_repo
from scraper.adapters import MarketplaceAdapter, ScrapedItem, get_adapter
from scraper.config import (
    Settings,
    dedupe,
    get_settings,
    load_keywords,
    normalise_store_entry,
)
from scraper.models import Marketplace, RunMode, RunStatus, ScrapeRun, Store, utcnow
from scraper.shops import load_shop_entries

__all__ = [
    "RunResult",
    "RunSummary",
    "ScrapeRunner",
    "ProgressReporter",
    "NullProgressReporter",
    "RichProgressReporter",
    "resolve_targets",
    "run_target",
    "run",
]

log = logging.getLogger(__name__)

#: ``scrape_runs.error`` is a text column, but a multi-megabyte traceback repr in
#: an audit row helps nobody. Truncate to something a human will actually read.
ERROR_MAX_CHARS = 4000

#: How many targets may fail back-to-back with a block before the invocation
#: gives up on the rest. Working through a 40-shop list one block at a time
#: after the marketplace has clearly stopped serving us is just more traffic
#: aimed at a site that is already refusing it — and the client-side breaker
#: means those requests cannot even recover a session any more.
MAX_CONSECUTIVE_BLOCKED_TARGETS = 3

#: Sentinel distinguishing "not looked up yet" from a genuine None result.
_UNSET = object()


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


@dataclass
class RunResult:
    """Aggregate outcome of one CLI invocation across all targets.

    Attributes:
        marketplace: Marketplace scraped.
        mode: keyword or store.
        targets: Targets attempted, in order.
        runs: One :class:`ScrapeRun` per target, in the same order, each already
            closed by ``store.finish_run``.
        item_count: Total snapshots persisted across all targets.
        failed_targets: Targets whose run ended FAILED.
        elapsed: Wall-clock seconds for the whole invocation.
    """

    marketplace: Marketplace
    mode: RunMode
    targets: list[str] = field(default_factory=list)
    runs: list[ScrapeRun] = field(default_factory=list)
    item_count: int = 0
    failed_targets: list[str] = field(default_factory=list)
    elapsed: float = 0.0

    @property
    def ok(self) -> bool:
        """Whether every target succeeded.

        Returns:
            True when ``failed_targets`` is empty. The CLI maps False to a
            non-zero exit code.
        """
        return not self.failed_targets

    @property
    def status(self) -> RunStatus:
        """Roll the per-target statuses up into one verdict.

        Returns:
            SUCCESS when nothing failed, FAILED when nothing succeeded, and
            PARTIAL when the invocation was a mix of the two.
        """
        if not self.failed_targets:
            return RunStatus.SUCCESS
        if len(self.failed_targets) == len(self.targets):
            return RunStatus.FAILED
        return RunStatus.PARTIAL

    def summary(self) -> "RunSummary":
        """Project this result onto the compact :class:`RunSummary`.

        Returns:
            A RunSummary carrying the counts plus a back-reference to ``self``.
        """
        return RunSummary(
            targets=len(self.targets),
            ok=len(self.targets) - len(self.failed_targets),
            failed=len(self.failed_targets),
            total_items=self.item_count,
            elapsed=self.elapsed,
            result=self,
        )


@dataclass
class RunSummary:
    """Compact, printable tally of one invocation.

    Attributes:
        targets: How many targets were attempted.
        ok: How many finished SUCCESS.
        failed: How many finished FAILED.
        total_items: Snapshots persisted across every target.
        elapsed: Wall-clock seconds for the whole invocation.
        result: The full :class:`RunResult` this was projected from, so a caller
            that wants per-target detail does not need a second return value.
    """

    targets: int = 0
    ok: int = 0
    failed: int = 0
    total_items: int = 0
    elapsed: float = 0.0
    result: RunResult | None = None

    @property
    def success(self) -> bool:
        """Whether every target succeeded.

        Returns:
            True when ``failed`` is zero.
        """
        return self.failed == 0


# ---------------------------------------------------------------------------
# Progress reporting
# ---------------------------------------------------------------------------


class ProgressReporter(Protocol):
    """Where the runner sends live progress. Injected so tests stay silent."""

    def start(self, total_targets: int) -> None:
        """Begin reporting for an invocation of ``total_targets`` targets."""
        ...

    def start_target(self, index: int, total: int, target: str) -> None:
        """Announce that target ``index`` of ``total`` is starting."""
        ...

    def set_phase(self, phase: str) -> None:
        """Note what the current target is doing, e.g. ``fetching``/``saving``."""
        ...

    def advance(self, items: int = 1) -> None:
        """Report that ``items`` more items have been persisted."""
        ...

    def finish_target(self, run: ScrapeRun, elapsed: float) -> None:
        """Announce the terminal state of the current target."""
        ...

    def close(self) -> None:
        """Release any resources (a live Rich display). Must be idempotent."""
        ...


class NullProgressReporter:
    """A :class:`ProgressReporter` that prints nothing. Default under ``quiet``."""

    def start(self, total_targets: int) -> None:
        """No-op."""

    def start_target(self, index: int, total: int, target: str) -> None:
        """No-op."""

    def set_phase(self, phase: str) -> None:
        """No-op."""

    def advance(self, items: int = 1) -> None:
        """No-op."""

    def finish_target(self, run: ScrapeRun, elapsed: float) -> None:
        """No-op."""

    def close(self) -> None:
        """No-op."""


class RichProgressReporter:
    """Live Rich spinner per target plus one durable log line per finished target.

    The spinner is transient — it erases itself when the target ends — so what
    is left on screen afterwards is a clean, greppable log rather than a wall of
    half-finished bars.
    """

    def __init__(self, console: Console | None = None) -> None:
        """Build the reporter around a Rich console.

        Args:
            console: Console to draw on. Defaults to a fresh one, which is what
                the module-level :func:`run` uses.
        """
        self.console = console or Console()
        self._progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold cyan]{task.fields[target]}"),
            TextColumn("[dim]{task.fields[phase]}"),
            TextColumn("[green]{task.completed} items"),
            TimeElapsedColumn(),
            console=self.console,
            transient=True,
        )
        self._task_id: int | None = None
        self._live = False

    def start(self, total_targets: int) -> None:
        """Start the live display.

        Args:
            total_targets: Number of targets in this invocation, for the banner.
        """
        if not self._live:
            self._progress.start()
            self._live = True
        noun = "target" if total_targets == 1 else "targets"
        self.console.log(f"[bold]scraping {total_targets} {noun}[/bold]")

    def start_target(self, index: int, total: int, target: str) -> None:
        """Add a fresh spinner row for this target.

        Args:
            index: 1-based position of this target.
            total: Total target count.
            target: The keyword or shop username.
        """
        self._task_id = self._progress.add_task(
            "", total=None, target=f"[{index}/{total}] {target}", phase="starting"
        )

    def set_phase(self, phase: str) -> None:
        """Update the phase label on the current row.

        Args:
            phase: Short verb, e.g. ``fetching`` or ``saving``.
        """
        if self._task_id is not None:
            self._progress.update(self._task_id, phase=phase)

    def advance(self, items: int = 1) -> None:
        """Bump the persisted-item counter on the current row.

        Args:
            items: How many items to add.
        """
        if self._task_id is not None:
            self._progress.update(self._task_id, advance=items)

    def finish_target(self, run: ScrapeRun, elapsed: float) -> None:
        """Erase the spinner row and log the target's terminal state.

        Args:
            run: The closed ScrapeRun for the target.
            elapsed: Wall-clock seconds the target took.
        """
        if self._task_id is not None:
            with suppress(KeyError):
                self._progress.remove_task(self._task_id)
            self._task_id = None
        if run.status is RunStatus.SUCCESS:
            noun = "item" if run.item_count == 1 else "items"
            self.console.log(
                f"[green]OK[/green]      {run.target} — "
                f"{run.item_count} {noun} in {elapsed:.1f}s"
            )
        else:
            detail = (run.error or "").splitlines()[0] if run.error else "unknown error"
            self.console.log(
                f"[red]FAILED[/red]  {run.target} — after {elapsed:.1f}s: {detail}"
            )

    def close(self) -> None:
        """Stop the live display. Safe to call twice."""
        if self._live:
            self._progress.stop()
            self._live = False


# ---------------------------------------------------------------------------
# Shop cache
# ---------------------------------------------------------------------------


class _ShopCache:
    """In-memory ``(marketplace, shop_id)`` memo for one invocation.

    Two things are memoised, with deliberately different lifetimes:

    * ``store_ref`` — a ``stores.id``. Only valid once the transaction that
      created it committed, so it is staged in a per-target child cache and
      promoted with :meth:`promote` after the commit.
    * ``shop`` — the enriched :class:`~scraper.models.Store` returned by
      ``adapter.get_shop``. That is a network result, not database state, so it
      is written straight through to the invocation-wide cache and survives a
      failed target.
    """

    def __init__(self, parent: "_ShopCache | None" = None) -> None:
        """Create a cache, optionally as a staging child of ``parent``.

        Args:
            parent: Invocation-wide cache to read through to and promote into.
        """
        self._parent = parent
        self.store_ref: dict[tuple[str, int], int] = {}
        self.username: dict[tuple[str, int], str] = {}
        self.shop: dict[tuple[str, int], Store] = {}
        #: Shops ``adapter.get_shop`` has already been spent on, successfully or
        #: not. Kept separate from ``shop`` so a failed enrichment is remembered
        #: as "attempted" and not retried once per item of the same seller.
        self.shop_attempted: set[tuple[str, int]] = set()

    @staticmethod
    def key(marketplace: Marketplace | str, shop_id: int) -> tuple[str, int]:
        """Build the composite cache key.

        Args:
            marketplace: Marketplace enum member or its value.
            shop_id: Marketplace's numeric shop id.

        Returns:
            A hashable ``(marketplace_value, shop_id)`` tuple.
        """
        value = marketplace.value if isinstance(marketplace, Marketplace) else str(marketplace)
        return (value, int(shop_id))

    def child(self) -> "_ShopCache":
        """Open a per-target staging cache over this one.

        Returns:
            A new cache that reads through to ``self`` but writes locally.
        """
        return _ShopCache(parent=self)

    def get_ref(self, key: tuple[str, int]) -> int | None:
        """Look up a cached ``stores.id``.

        Args:
            key: Key from :meth:`key`.

        Returns:
            The database ref, or None when this shop has not been upserted yet.
        """
        if key in self.store_ref:
            return self.store_ref[key]
        if self._parent is not None:
            return self._parent.get_ref(key)
        return None

    def get_username(self, key: tuple[str, int]) -> str | None:
        """Look up the best-known username for a shop id.

        Args:
            key: Key from :meth:`key`.

        Returns:
            The username, or None when unknown.
        """
        if key in self.username:
            return self.username[key]
        if self._parent is not None:
            return self._parent.get_username(key)
        return None

    def get_shop(self, key: tuple[str, int]) -> Store | None:
        """Look up a previously enriched Store.

        Args:
            key: Key from :meth:`key`.

        Returns:
            The enriched Store, or None when ``adapter.get_shop`` has not run for
            this shop.
        """
        if key in self.shop:
            return self.shop[key]
        if self._parent is not None:
            return self._parent.get_shop(key)
        return None

    def was_attempted(self, key: tuple[str, int]) -> bool:
        """Whether ``adapter.get_shop`` has already been spent on this shop.

        Args:
            key: Key from :meth:`key`.

        Returns:
            True when enrichment was tried, whatever its outcome.
        """
        if key in self.shop_attempted:
            return True
        if self._parent is not None:
            return self._parent.was_attempted(key)
        return False

    def mark_attempted(self, key: tuple[str, int]) -> None:
        """Record that enrichment was tried for this shop, writing through.

        Args:
            key: Key from :meth:`key`.
        """
        target = self._parent if self._parent is not None else self
        target.shop_attempted.add(key)

    def drop_refs(self, keys: Iterable[tuple[str, int]]) -> None:
        """Forget staged ``stores.id`` values whose insert was rolled back.

        A per-item SAVEPOINT rollback undoes the shop insert too, so any ref
        cached during that item now points at a row that does not exist. Leaving
        it in the cache would make every later item of the same seller fail on a
        foreign-key violation.

        Args:
            keys: Cache keys to forget.
        """
        for key in keys:
            self.store_ref.pop(key, None)

    def put_ref(self, key: tuple[str, int], ref: int, username: str | None) -> None:
        """Record a freshly upserted shop.

        Args:
            key: Key from :meth:`key`.
            ref: ``stores.id`` returned by ``store.upsert_store``.
            username: Best-known username, stored when truthy.
        """
        self.store_ref[key] = ref
        if username:
            self.username[key] = username

    def put_shop(self, key: tuple[str, int], shop: Store) -> None:
        """Record an enriched Store, writing through to the invocation cache.

        Args:
            key: Key from :meth:`key`.
            shop: The Store returned by ``adapter.get_shop``.
        """
        target = self._parent if self._parent is not None else self
        target.shop[key] = shop
        if shop.username:
            target.username[key] = shop.username

    def promote(self) -> None:
        """Merge this staging cache into its parent. Call only after a commit."""
        if self._parent is None:
            return
        self._parent.store_ref.update(self.store_ref)
        self._parent.username.update(self.username)
        self._parent.shop.update(self.shop)
        self.store_ref.clear()
        self.username.clear()
        self.shop.clear()


def _is_block_exception(exc: BaseException) -> bool:
    """Whether an exception means "the marketplace refused us", not "bad target".

    Classified by walking the exception's MRO for a class named ``BlockedError``
    rather than by importing :class:`scraper.client.BlockedError`, so the runner
    keeps its promise of knowing nothing about any one marketplace's transport
    and a future adapter's own block exception is covered by the same convention.
    Matching on the MRO rather than on the concrete class name is what makes it
    work for subclasses — the naive ``"BlockedError" in repr(exc)`` misses a
    subclass called anything else.

    Args:
        exc: The exception that ended a target.

    Returns:
        True when this was a block.
    """
    return any(base.__name__ == "BlockedError" for base in type(exc).__mro__)


def _is_thin(store: Store) -> bool:
    """Whether a Store carries nothing but identity.

    A search-results payload gives ``shopid`` and little else; a
    ``get_shop_base`` payload gives name, location, followers and rating. Only
    the former is worth spending a request to enrich.

    Args:
        store: Candidate store.

    Returns:
        True when every descriptive field is None.
    """
    return (
        store.name is None
        and store.location is None
        and store.follower_count is None
        and store.rating_star is None
    )


def _placeholder_checker(adapter: object) -> Callable[[str | None], bool] | None:
    """Find the adapter's "is this username synthetic?" predicate, if it has one.

    ``Store.username`` is a required field, so an adapter parsing a payload that
    carries no slug has to invent one. Adapters that do this publish a predicate
    for recognising their own inventions — either as an attribute on the adapter
    or as ``is_placeholder_username`` in the module the adapter class is defined
    in. Looking it up by convention keeps the runner free of any concrete
    adapter import while still letting it avoid a guaranteed-useless request.

    Args:
        adapter: The adapter in use.

    Returns:
        The predicate, or None when the adapter publishes none.
    """
    checker = getattr(adapter, "is_placeholder_username", None)
    if callable(checker):
        return checker
    module = sys.modules.get(type(adapter).__module__)
    checker = getattr(module, "is_placeholder_username", None)
    return checker if callable(checker) else None


def _looks_like_slug(
    username: str | None,
    shop_id: int,
    is_placeholder: Callable[[str | None], bool] | None = None,
) -> bool:
    """Whether ``username`` is a real URL slug worth passing to ``get_shop``.

    Keyword-search payloads do not carry a shop username, so adapters fall back
    to a synthetic placeholder. Sending that to ``get_shop`` would burn a delayed
    request on a guaranteed ``LookupError``.

    Args:
        username: The username on the thin Store.
        shop_id: The shop's numeric id.
        is_placeholder: The adapter's own predicate from :func:`_placeholder_checker`.

    Returns:
        True when the username is non-empty, not purely numeric, not just the
        shop id stringified, and not one the adapter admits it invented.
    """
    if not username:
        return False
    candidate = username.strip()
    if not candidate or candidate.isdigit() or candidate == str(shop_id):
        return False
    if is_placeholder is not None:
        try:
            if is_placeholder(candidate):
                return False
        except Exception:  # noqa: BLE001 — a broken predicate must not fail a run
            log.debug("placeholder predicate raised for %r; treating as a real slug", candidate)
    return True


def _merge_store(thin: Store, rich: Store) -> Store:
    """Overlay an enriched Store on a thin one without losing known values.

    Identity is pinned to ``thin``: ``marketplace`` and ``shop_id`` come from the
    item payload, which is authoritative for the item we are about to write, and
    are the key the row is cached and upserted under. Everything else prefers the
    enriched value and falls back to the thin one.

    Args:
        thin: Store derived from the item payload.
        rich: Store returned by ``adapter.get_shop``.

    Returns:
        A new Store carrying ``thin``'s identity and ``rich``'s detail.
    """
    merged = rich.model_dump()
    for name, value in thin.model_dump().items():
        if merged.get(name) is None and value is not None:
            merged[name] = value
    merged["marketplace"] = thin.marketplace
    merged["shop_id"] = thin.shop_id
    return Store.model_validate(merged)


# ---------------------------------------------------------------------------
# Target resolution
# ---------------------------------------------------------------------------


def resolve_targets(
    mode: RunMode,
    *,
    keywords_file: Path | None = None,
    stores_file: Path | None = None,
    inline: list[str] | None = None,
) -> list[str]:
    """Turn CLI options into the ordered list of targets to scrape.

    Precedence: ``inline`` wins outright when non-empty; otherwise the file for
    the given mode is read via :func:`scraper.config.load_keywords` or
    :func:`scraper.shops.load_shop_entries`, defaulting to
    ``config/keywords.txt`` / ``config/stores.txt``. Store mode keeps only the
    Shopee entries, because that is the only adapter this path has. Duplicates
    are removed while preserving first-seen order, so a repeated keyword is not
    scraped twice in one invocation.

    Args:
        mode: Which kind of target to resolve.
        keywords_file: Override path for keyword mode.
        stores_file: Override path for store mode.
        inline: Targets passed directly on the command line.

    Returns:
        Ordered, de-duplicated, non-empty target list.

    Raises:
        FileNotFoundError: If the needed file is missing and no inline targets
            were given.
        ValueError: If the resolved list is empty — running with zero targets is
            an error, not a no-op.
    """
    mode = RunMode(mode)

    if inline:
        cleaned = [item.strip() for item in inline]
        if mode is RunMode.STORE:
            cleaned = [normalise_store_entry(item) for item in cleaned]
        targets = dedupe([item for item in cleaned if item])
    elif mode is RunMode.KEYWORD:
        targets = load_keywords(keywords_file) if keywords_file else load_keywords()
    else:
        # Shopee entries only. The file is shared with the extension, which walks
        # both marketplaces; this path has a Shopee adapter and nothing else, and
        # handing it a Tokopedia slug would scrape a Shopee shop of that name if
        # one happened to exist and fail confusingly if it did not.
        entries = load_shop_entries(stores_file) if stores_file else load_shop_entries()
        targets = [
            entry.slug for entry in entries if entry.marketplace is Marketplace.SHOPEE
        ]

    targets = dedupe([target for target in targets if target])
    if not targets:
        source = "--target/--keyword/--store" if inline else "the target file"
        raise ValueError(f"no targets to scrape for mode={mode.value}: {source} yielded nothing")
    return targets


# ---------------------------------------------------------------------------
# The runner
# ---------------------------------------------------------------------------


class ScrapeRunner:
    """Stateful orchestrator for one invocation: one adapter, one cache, one report.

    Typical use is via the two verbs::

        with ScrapeRunner(settings) as runner:
            summary = runner.run_keywords(["sepatu pria"], pages=2)

    The object is reusable — calling :meth:`run_keywords` twice performs two
    independent invocations — but the shop cache is reset at the start of each
    so that a second invocation refreshes ``stores.last_seen`` rather than
    silently skipping the upsert.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        marketplace: Marketplace = Marketplace.SHOPEE,
        adapter: MarketplaceAdapter | None = None,
        database_url: str | None = None,
        quiet: bool = False,
        console: Console | None = None,
        progress: ProgressReporter | None = None,
        enrich_shops: bool = True,
    ) -> None:
        """Wire up the runner without touching the network or the database.

        Args:
            settings: Configuration. Defaults to ``config.get_settings()``.
            marketplace: Which marketplace to scrape. Used to build the adapter
                when one is not injected, and stamped onto every row.
            adapter: Pre-built adapter. When None the adapter is built lazily on
                first use via ``adapters.get_adapter`` and closed by
                :meth:`close`; when injected, the caller keeps ownership.
            database_url: Override DB URL. Defaults to ``settings.database_url``.
            quiet: Suppress progress output entirely.
            console: Rich console for the default reporter.
            progress: Inject a :class:`ProgressReporter`. Overrides ``quiet``.
            enrich_shops: Spend one ``adapter.get_shop`` call per never-before-seen
                shop whose item payload carried a usable username but no
                descriptive fields. Set False to keep keyword runs strictly to
                search requests.
        """
        self.settings = settings or get_settings()
        self.marketplace = Marketplace(marketplace)
        self.database_url = database_url or self.settings.database_url
        self.enrich_shops = enrich_shops
        self._adapter = adapter
        self._owns_adapter = adapter is None
        if progress is not None:
            self.progress: ProgressReporter = progress
        elif quiet:
            self.progress = NullProgressReporter()
        else:
            self.progress = RichProgressReporter(console=console)
        self._cache = _ShopCache()
        self._placeholder_check: Callable[[str | None], bool] | None | object = _UNSET
        #: ``(marketplace, item_id)`` already snapshotted in this invocation.
        #: Reset per invocation in :meth:`run_targets`.
        self._snapshotted: set[tuple[str, int]] = set()
        #: Text of the first per-item persist failure of the current target.
        self._persist_error: str | None = None
        #: Whether the target just executed ended in a marketplace block. Drives
        #: the consecutive-block abort in :meth:`run_targets`.
        self._last_block = False
        self._closed = False

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> "ScrapeRunner":
        """Enter the context manager.

        Returns:
            ``self``. The adapter is still built lazily.
        """
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        """Close the adapter (if owned) and the progress display."""
        self.close()

    def close(self) -> None:
        """Release the adapter this runner built and stop progress.

        Idempotent, and **terminal for an owned adapter**: once closed, touching
        :attr:`adapter` raises instead of silently building a second adapter —
        and with it a second ``httpx.Client`` and cookie session — that nothing
        would ever close. An injected adapter is untouched and stays usable.
        """
        if self._owns_adapter:
            self._closed = True
        if self._owns_adapter and self._adapter is not None:
            closer = getattr(self._adapter, "close", None)
            if callable(closer):
                with suppress(Exception):
                    closer()
            self._adapter = None
        with suppress(Exception):
            self.progress.close()

    @property
    def adapter(self) -> MarketplaceAdapter:
        """The adapter for this invocation, built on first access.

        Returns:
            A ready adapter satisfying :class:`~scraper.adapters.MarketplaceAdapter`.

        Raises:
            NotImplementedError: If the marketplace has no adapter yet.
            RuntimeError: If :meth:`close` has already released an owned adapter.
        """
        if self._adapter is None and self._closed:
            raise RuntimeError(
                "ScrapeRunner is closed; build a new one rather than reopening a "
                "cookie session on attribute access"
            )
        if self._adapter is None:
            self._adapter = get_adapter(self.marketplace)
        return self._adapter

    # -- verbs -------------------------------------------------------------

    def run_keywords(self, keywords: Sequence[str], pages: int = 1) -> RunSummary:
        """Scrape every keyword, continuing past any that fail.

        Args:
            keywords: Search phrases, in order. De-duplicated first-seen-wins.
            pages: Result pages to walk per keyword, >= 1.

        Returns:
            The invocation's :class:`RunSummary`; ``summary.result`` carries the
            per-target :class:`ScrapeRun` rows.

        Raises:
            ValueError: If ``keywords`` is empty or ``pages`` < 1.
        """
        return self.run_targets(RunMode.KEYWORD, keywords, pages=pages)

    def run_stores(self, usernames: Sequence[str], pages: int = 1) -> RunSummary:
        """Scrape every shop, continuing past any that fail.

        Args:
            usernames: Shop URL slugs, in order. A pasted profile URL or a
                leading ``@`` is normalised away. De-duplicated first-seen-wins.
            pages: Listing pages to walk per shop, >= 1.

        Returns:
            The invocation's :class:`RunSummary`.

        Raises:
            ValueError: If ``usernames`` is empty or ``pages`` < 1.
        """
        return self.run_targets(RunMode.STORE, usernames, pages=pages)

    def run_targets(self, mode: RunMode, targets: Sequence[str], pages: int = 1) -> RunSummary:
        """Scrape an explicit target list in one mode. Backs both verbs.

        Every target gets its own transaction and its own ``scrape_runs`` row.
        An exception raised while handling one target is recorded against that
        target and the loop moves on; only ``KeyboardInterrupt`` and
        ``SystemExit`` stop the invocation.

        Args:
            mode: keyword or store.
            targets: Targets to scrape, in order.
            pages: Pages to walk per target, >= 1.

        Returns:
            The invocation's :class:`RunSummary`.

        Raises:
            ValueError: If ``targets`` is empty or ``pages`` < 1.
        """
        mode = RunMode(mode)
        if pages < 1:
            raise ValueError(f"pages must be >= 1, got {pages}")
        ordered = dedupe([str(target).strip() for target in targets if str(target).strip()])
        if not ordered:
            raise ValueError(f"no targets to scrape for mode={mode.value}")

        self._cache = _ShopCache()
        self._snapshotted = set()
        result = RunResult(marketplace=self.marketplace, mode=mode, targets=list(ordered))
        started = time.monotonic()

        self.progress.start(len(ordered))
        consecutive_blocks = 0
        try:
            for index, target in enumerate(ordered, start=1):
                self.progress.start_target(index, len(ordered), target)
                target_started = time.monotonic()
                run = self._execute_target(mode, target, pages=pages)
                target_elapsed = time.monotonic() - target_started
                self.progress.finish_target(run, target_elapsed)

                result.runs.append(run)
                result.item_count += run.item_count
                if run.status is not RunStatus.SUCCESS:
                    result.failed_targets.append(target)

                consecutive_blocks = consecutive_blocks + 1 if self._last_block else 0
                if consecutive_blocks >= MAX_CONSECUTIVE_BLOCKED_TARGETS:
                    remaining = ordered[index:]
                    if remaining:
                        log.error(
                            "aborting after %d consecutive blocked targets; %d target(s) "
                            "not attempted: %s",
                            consecutive_blocks,
                            len(remaining),
                            ", ".join(repr(name) for name in remaining),
                        )
                        result.failed_targets.extend(remaining)
                    break
        finally:
            result.elapsed = time.monotonic() - started
            with suppress(Exception):
                self.progress.close()

        log.info(
            "invocation finished: mode=%s targets=%d ok=%d failed=%d items=%d elapsed=%.1fs",
            mode.value,
            len(result.targets),
            len(result.targets) - len(result.failed_targets),
            len(result.failed_targets),
            result.item_count,
            result.elapsed,
        )
        return result.summary()

    # -- one target --------------------------------------------------------

    def _execute_target(self, mode: RunMode, target: str, *, pages: int) -> ScrapeRun:
        """Scrape and persist one target. Never raises.

        Three short transactions, deliberately, rather than one long one:

        1. Insert the RUNNING audit row and **commit** it. A flushed-but-
           uncommitted row is invisible to every other connection and vanishes on
           rollback, so committing here is what makes ``start_run``'s "a crashed
           process leaves evidence" contract actually true.
        2. Fetch with **no transaction open**. The network phase is minutes long
           (paced 2-5s per request, 30s timeouts, a possible Playwright cookie
           re-bootstrap); holding a transaction across it leaves the connection
           ``idle in transaction`` for the whole scrape, which any
           ``idle_in_transaction_session_timeout`` or transaction-pooling proxy
           (PgBouncer, Supabase, Neon) kills — discarding a target's entire
           harvest — and which pins ``xmin`` against VACUUM meanwhile.
        3. Persist the items and close the run in a fresh transaction.

        Args:
            mode: keyword or store.
            target: The keyword or shop username.
            pages: Pages to walk.

        Returns:
            The closed ScrapeRun — SUCCESS/PARTIAL with a count, or FAILED with
            an error.
        """
        started_at = utcnow()
        staged = self._cache.child()
        self._last_block = False

        run = self._open_run(mode, target, started_at=started_at)

        try:
            self.progress.set_phase("fetching")
            items = self._fetch(mode, target, pages=pages)
            # Shop enrichment is network work, so it belongs here with the rest
            # of the fetch phase, not inside the write transaction below.
            self._prefetch_shops(items, staged=staged)
            # Stamp the shared observation clock AFTER the fetch. One clock per
            # target keeps a batch diffable as a unit, but taking it up front
            # would label every snapshot with a time that precedes the actual
            # observation by the full duration of the scrape — minutes on a
            # multi-page walk — which poisons any sold-delta velocity metric.
            observed_at = utcnow()
            with db.session_scope(self.database_url) as session:
                self.progress.set_phase("saving")
                count, failed = self._persist(session, items, staged=staged, now=observed_at)
                status = RunStatus.PARTIAL if failed else RunStatus.SUCCESS
                error = (
                    f"{failed} of {count + failed} items could not be persisted; "
                    f"first: {self._persist_error}"
                    if failed
                    else None
                )
                drift = self._drift_error(target)
                if drift is not None:
                    # A payload full of entries that none of them parse is a
                    # schema change, not an empty result. Reporting SUCCESS/0
                    # for it lets a nightly cron stay green while collecting
                    # nothing, indefinitely.
                    status = RunStatus.PARTIAL
                    error = f"{error}; {drift}" if error else drift
                run = self._close_run(
                    session,
                    run,
                    mode,
                    target,
                    started_at=started_at,
                    status=status,
                    item_count=count,
                    error=error,
                )
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:  # noqa: BLE001 — continue-on-error is the contract
            # The CLI already renders the error per target, so keep the default
            # stderr line to one line and put the traceback behind DEBUG.
            log.warning("target %r failed: %r", target, exc)
            log.debug("traceback for target %r", target, exc_info=True)
            self._last_block = _is_block_exception(exc)
            return self._record_failure(
                mode, target, started_at=started_at, exc=exc, run=run
            )

        # Committed: the staged stores.id values are now real.
        staged.promote()
        return run

    def _open_run(self, mode: RunMode, target: str, *, started_at: datetime) -> ScrapeRun | None:
        """Insert and commit the RUNNING audit row in its own short transaction.

        Args:
            mode: keyword or store.
            target: The keyword or shop username.
            started_at: Value for ``started_at``.

        Returns:
            The open ScrapeRun, or None when the audit write itself failed — a
            missing audit row must not stop us from scraping, and the persist
            phase will open one from scratch.
        """
        try:
            with db.session_scope(self.database_url) as session:
                return store_repo.start_run(
                    session, self.marketplace, mode, target, now=started_at
                )
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("could not open RUNNING audit row for %r: %r", target, exc)
            return None

    def _close_run(
        self,
        session: Session,
        run: ScrapeRun | None,
        mode: RunMode,
        target: str,
        *,
        started_at: datetime,
        status: RunStatus,
        item_count: int,
        error: str | None = None,
    ) -> ScrapeRun:
        """Move an audit row to its terminal state inside ``session``.

        The RUNNING row lives in an already-committed transaction, so this simply
        updates it. When :meth:`_open_run` could not write one — or when it was
        written by a process that has since died — a terminal row is created here
        instead, so a run is never silently unrecorded.

        Args:
            session: The open session owning this transaction.
            run: The row from :meth:`_open_run`, or None.
            mode: keyword or store.
            target: The keyword or shop username.
            started_at: Value for ``started_at`` on a re-created row.
            status: Terminal status to write.
            item_count: Snapshots persisted.
            error: Error text, or None.

        Returns:
            The closed ScrapeRun.
        """
        if run is None or run.id is None:
            run = store_repo.start_run(session, self.marketplace, mode, target, now=started_at)
        return store_repo.finish_run(
            session,
            run,
            status=status,
            item_count=item_count,
            error=error,
            now=utcnow(),
        )

    def _fetch(self, mode: RunMode, target: str, *, pages: int) -> list[ScrapedItem]:
        """Ask the adapter for this target's items.

        Args:
            mode: keyword or store.
            target: The keyword or shop username.
            pages: Pages to walk.

        Returns:
            The adapter's items, in marketplace order.
        """
        if mode is RunMode.KEYWORD:
            return list(self.adapter.search_keyword(target, pages))
        return list(self.adapter.search_shop(target, pages))

    def _persist(
        self,
        session: Session,
        items: Iterable[ScrapedItem],
        *,
        staged: _ShopCache,
        now: datetime,
    ) -> tuple[int, int]:
        """Write every item through the fixed store -> product -> snapshot chain.

        Each item is written inside its own SAVEPOINT. Postgres rejects a whole
        transaction on the first error, so without this one un-persistable
        listing — a title carrying a NUL byte, an id past ``bigint`` — would roll
        back every other listing of the target and record it FAILED with zero
        items. The adapter contract promises "one bad entry in a page of 60 must
        not lose the other 59"; that promise has to hold at write time too, not
        only at parse time. Items that fail are counted and surfaced as
        ``RunStatus.PARTIAL`` rather than swallowed.

        Args:
            session: The open SQLAlchemy session owned by ``_execute_target``.
            items: Items to persist.
            staged: Per-target shop cache.
            now: One shared timestamp for the whole target, so a batch has a
                coherent clock.

        Returns:
            ``(persisted, failed)`` — snapshots inserted, and items rejected.
            The first rejection's text is left on ``self._persist_error`` so the
            audit row can name a cause rather than only a count.
        """
        count = 0
        failed = 0
        self._persist_error = None
        for item in items:
            store, product, snapshot = item
            key = (product.marketplace.value, int(product.item_id))
            if key in self._snapshotted:
                # Two targets of one invocation can legitimately return the same
                # listing (overlapping keywords, a shop that also ranks for a
                # keyword). Snapshotting it twice milliseconds apart puts
                # duplicate points on the price chart and makes any
                # "sold since last snapshot / elapsed" velocity divide by ~0.
                log.debug("item %s already snapshotted this invocation; skipping", key[1])
                continue
            refs_before = set(staged.store_ref)
            try:
                with session.begin_nested():
                    # ScrapedItem.store is `Store | None` by contract: a keyword hit
                    # whose payload carried no resolvable shop still has to be
                    # persisted, with a null shop_ref for a later store-mode scrape
                    # to backfill.
                    shop_ref = (
                        self._resolve_shop(session, store, staged=staged, now=now)
                        if store is not None
                        else None
                    )
                    product_ref = store_repo.upsert_product(session, product, shop_ref, now=now)
                    store_repo.insert_snapshot(session, snapshot, product_ref, now=now)
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as exc:  # noqa: BLE001 — one bad row must not cost the rest
                failed += 1
                staged.drop_refs(set(staged.store_ref) - refs_before)
                if self._persist_error is None:
                    self._persist_error = f"{type(exc).__name__}: {exc}"
                log.warning(
                    "skipping item %s: could not persist (%s: %s)",
                    key[1],
                    type(exc).__name__,
                    exc,
                )
                log.debug("traceback for item %s", key[1], exc_info=True)
                continue
            self._snapshotted.add(key)
            count += 1
            self.progress.advance(1)
        return count, failed

    def _resolve_shop(
        self,
        session: Session,
        store: Store,
        *,
        staged: _ShopCache,
        now: datetime,
    ) -> int | None:
        """Return the ``stores.id`` for ``store``, upserting it at most once per run.

        A shop already handled in this invocation short-circuits here: no
        ``adapter.get_shop`` request and no second upsert. A never-before-seen
        thin shop is optionally enriched with one ``get_shop`` call before being
        written.

        Args:
            session: The open session.
            store: The (possibly thin) Store from the item payload.
            staged: Per-target shop cache.
            now: Shared timestamp for this target.

        Returns:
            ``stores.id``, or None when the shop could not be persisted (the
            product is still written with a null ``shop_ref`` for a later run to
            backfill).
        """
        key = _ShopCache.key(store.marketplace, store.shop_id)

        cached_ref = staged.get_ref(key)
        if cached_ref is not None:
            return cached_ref

        resolved = store
        if self.enrich_shops and _is_thin(store):
            # Enrichment itself happens in _prefetch_shops, before the write
            # transaction opens — a paced get_shop call inside it would put the
            # network back on the critical path this method's caller works hard
            # to keep it off. Anything not already cached stays thin.
            enriched = staged.get_shop(key)
            if enriched is not None:
                resolved = _merge_store(store, enriched)

        shop_ref = store_repo.upsert_store(
            session,
            resolved,
            now=now,
            username_is_synthetic=self._is_synthetic_username(resolved.username),
        )
        staged.put_ref(key, shop_ref, resolved.username)
        return shop_ref

    def _prefetch_shops(self, items: Iterable[ScrapedItem], *, staged: _ShopCache) -> None:
        """Resolve every unknown thin shop's detail before the write transaction.

        Runs one ``adapter.get_shop`` per never-before-seen thin shop and caches
        the result on ``staged``, so :meth:`_resolve_shop` is pure database work.
        Enrichment is best effort throughout: a failure is remembered as
        "attempted" so it is not retried once per item of the same seller.

        Args:
            items: The target's items.
            staged: Per-target shop cache.
        """
        if not self.enrich_shops:
            return
        predicate = self._placeholder_predicate()
        for item in items:
            store = item.store
            if store is None or not _is_thin(store):
                continue
            key = _ShopCache.key(store.marketplace, store.shop_id)
            if staged.get_ref(key) is not None or staged.get_shop(key) is not None:
                continue
            if staged.was_attempted(key):
                continue
            if not _looks_like_slug(store.username, store.shop_id, predicate):
                continue
            staged.mark_attempted(key)
            fetched = self._fetch_shop(store.username)
            if fetched is not None and fetched.shop_id != store.shop_id:
                # The slug resolved to a different shop, so its name, follower
                # count and rating describe someone else. Writing them against
                # our shop_id would be worse than staying thin.
                log.warning(
                    "shop enrichment discarded: %r resolved to shop_id=%s, expected %s",
                    store.username,
                    fetched.shop_id,
                    store.shop_id,
                )
                fetched = None
            if fetched is not None:
                staged.put_shop(key, fetched)

    def _drift_error(self, target: str) -> str | None:
        """Describe a suspected marketplace schema change, if the adapter reports one.

        Adapters may publish a ``last_parse_stats`` object with a ``drifted``
        flag (see :class:`scraper.adapters.shopee.ParseStats`). It is read
        duck-typed so the runner stays free of any concrete adapter import and
        an adapter without one simply never trips this.

        Args:
            target: The target being closed, for the message.

        Returns:
            A message for ``scrape_runs.error``, or None when nothing drifted.
        """
        stats = getattr(self._adapter, "last_parse_stats", None)
        if stats is None or not getattr(stats, "drifted", False):
            return None
        message = (
            f"payload shape may have changed: {stats.raw_seen} entries returned for "
            f"{target!r}, none of them parseable"
        )
        log.error("%s", message)
        return message

    def _is_synthetic_username(self, username: str | None) -> bool:
        """Whether ``username`` is one the adapter invented rather than scraped.

        ``stores.username`` is NOT NULL, so a placeholder cannot be signalled to
        the repository as None; :func:`scraper.store.upsert_store` needs this flag
        to stop a keyword-mode placeholder overwriting a real slug.

        Args:
            username: The username about to be written.

        Returns:
            True only when the adapter's own predicate says so.
        """
        predicate = self._placeholder_predicate()
        if predicate is None or not username:
            return False
        try:
            return bool(predicate(username))
        except Exception:  # noqa: BLE001 — a broken predicate must not fail a run
            log.debug("placeholder predicate raised for %r; treating as real", username)
            return False

    def _placeholder_predicate(self) -> Callable[[str | None], bool] | None:
        """The current adapter's synthetic-username predicate, looked up once.

        Returns:
            The predicate, or None when this adapter publishes none.
        """
        if self._placeholder_check is _UNSET:
            self._placeholder_check = _placeholder_checker(self.adapter)
        return self._placeholder_check

    def _fetch_shop(self, username: str) -> Store | None:
        """Best-effort ``adapter.get_shop``. Enrichment must never fail a target.

        Args:
            username: Shop slug to resolve.

        Returns:
            The enriched Store, or None when the adapter could not resolve it.
        """
        getter = getattr(self.adapter, "get_shop", None)
        if not callable(getter):
            return None
        try:
            return getter(username)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:  # noqa: BLE001 — enrichment is optional by design
            log.info("shop enrichment for %r skipped: %r", username, exc)
            return None

    def _record_failure(
        self,
        mode: RunMode,
        target: str,
        *,
        started_at: datetime,
        exc: BaseException,
        run: ScrapeRun | None = None,
    ) -> ScrapeRun:
        """Move this target's audit row to FAILED in its own committed transaction.

        The persist transaction has rolled back, so the terminal state has to be
        written on a connection of its own. The RUNNING row itself was committed
        before the fetch started, so this normally *updates* it rather than
        inserting a second row; a row is only created when :meth:`_open_run`
        could not write one. If even this write fails (Postgres down), an unsaved
        ScrapeRun is returned so the CLI can still report the failure.

        Args:
            mode: keyword or store.
            target: The target that failed.
            started_at: When the target started, preserved from the first attempt.
            exc: The exception that ended the target.
            run: The RUNNING row from :meth:`_open_run`, when there is one.

        Returns:
            A ScrapeRun with ``status = FAILED`` and ``error`` set.
        """
        error = repr(exc)[:ERROR_MAX_CHARS]
        finished_at = utcnow()
        try:
            with db.session_scope(self.database_url) as session:
                open_run = run
                if open_run is None or open_run.id is None:
                    open_run = store_repo.start_run(
                        session, self.marketplace, mode, target, now=started_at
                    )
                return store_repo.finish_run(
                    session,
                    open_run,
                    status=RunStatus.FAILED,
                    item_count=0,
                    error=error,
                    now=finished_at,
                )
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as audit_exc:  # noqa: BLE001
            log.error("could not persist FAILED run for %r: %r", target, audit_exc)
            return ScrapeRun(
                marketplace=self.marketplace,
                mode=mode,
                target=target,
                started_at=started_at,
                finished_at=finished_at,
                status=RunStatus.FAILED,
                item_count=0,
                error=error,
            )


# ---------------------------------------------------------------------------
# Module-level API (what the CLI calls)
# ---------------------------------------------------------------------------


def run_target(
    adapter: MarketplaceAdapter,
    mode: RunMode,
    target: str,
    *,
    pages: int = 1,
    database_url: str | None = None,
) -> ScrapeRun:
    """Scrape and persist exactly one target.

    Sequence:

    1. ``store.start_run(...)`` in its own ``db.session_scope``, **committed**, so
       a RUNNING row exists and is visible before any network call.
    2. Call ``adapter.search_keyword`` or ``adapter.search_shop`` per ``mode``,
       with no transaction open — the fetch must never be the thing keeping a
       Postgres connection idle in transaction.
    3. Open a second ``db.session_scope``. For each
       :class:`~scraper.adapters.ScrapedItem`, run the fixed
       upsert_store -> upsert_product -> insert_snapshot chain inside its own
       SAVEPOINT, sharing one ``now`` timestamp — read after the fetch — across
       the whole target.
    4. ``store.finish_run(...)`` with SUCCESS, or PARTIAL when some items could
       not be written or the adapter reported schema drift.

    On exception: roll back the item writes, then move the audit row to FAILED
    with the exception repr **in its own committed transaction** — the persist
    transaction has gone, so the terminal state needs a connection of its own.
    The exception is swallowed here and reflected in the returned run's status;
    only ``KeyboardInterrupt`` and ``SystemExit`` propagate.

    Args:
        adapter: Marketplace adapter to scrape with.
        mode: keyword or store.
        target: The keyword or shop username.
        pages: Pages to walk for this target.
        database_url: Override DB URL, forwarded to ``db.session_scope``.

    Returns:
        The closed :class:`ScrapeRun` for this target.

    Raises:
        ValueError: If ``pages`` < 1.
    """
    if pages < 1:
        raise ValueError(f"pages must be >= 1, got {pages}")
    runner = ScrapeRunner(
        marketplace=getattr(adapter, "marketplace", Marketplace.SHOPEE),
        adapter=adapter,
        database_url=database_url,
        quiet=True,
    )
    return runner._execute_target(RunMode(mode), target, pages=pages)


def run(
    mode: RunMode,
    *,
    marketplace: Marketplace = Marketplace.SHOPEE,
    keywords_file: Path | None = None,
    stores_file: Path | None = None,
    inline: list[str] | None = None,
    pages: int = 1,
    settings: Settings | None = None,
    adapter: MarketplaceAdapter | None = None,
) -> RunResult:
    """Full invocation: resolve targets, build the adapter, loop, aggregate.

    Builds one adapter (and therefore one client and one cookie session) for the
    whole invocation — reusing a single warm session across targets is part of
    the anti-ban posture, not an optimisation. Delegates each target to
    :class:`ScrapeRunner` and never lets one target's failure end the loop.

    Args:
        mode: keyword or store.
        marketplace: Which marketplace. Only SHOPEE has an adapter today.
        keywords_file: Override path for keyword mode.
        stores_file: Override path for store mode.
        inline: Targets given directly on the command line.
        pages: Pages to walk per target.
        settings: Configuration. Defaults to ``config.get_settings()``.
        adapter: Inject a pre-built adapter (tests and reuse). When None, one is
            built via ``adapters.get_adapter(marketplace)`` and closed on exit.

    Returns:
        The aggregated :class:`RunResult`.

    Raises:
        FileNotFoundError: If target resolution needed a missing file.
        ValueError: If no targets resolved, or ``pages`` < 1.
        NotImplementedError: If ``marketplace`` has no adapter yet.
    """
    mode = RunMode(mode)
    if pages < 1:
        raise ValueError(f"pages must be >= 1, got {pages}")

    targets = resolve_targets(
        mode, keywords_file=keywords_file, stores_file=stores_file, inline=inline
    )

    runner = ScrapeRunner(
        settings=settings,
        marketplace=marketplace,
        adapter=adapter,
    )
    try:
        # Force adapter construction up front so an unimplemented marketplace
        # raises out of run() instead of failing every target one by one.
        _ = runner.adapter
        summary = runner.run_targets(mode, targets, pages=pages)
    finally:
        runner.close()

    assert summary.result is not None  # run_targets always attaches it
    return summary.result
