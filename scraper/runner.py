"""Run orchestration: targets in, rows in Postgres out.

The runner is the seam between the network side (adapter/client/session) and the
storage side (store/db). It owns:

* resolving CLI arguments into a concrete list of targets;
* looping targets **continue-on-error** — one dead keyword or renamed shop must
  never abort the remaining targets;
* opening one transaction per target so a failure rolls back only that target;
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
the time series.
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
    load_stores,
    normalise_store_entry,
)
from scraper.models import Marketplace, RunMode, RunStatus, ScrapeRun, Store, utcnow

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
    :func:`scraper.config.load_stores`, defaulting to ``config/keywords.txt`` /
    ``config/stores.txt``. Duplicates are removed while preserving first-seen
    order, so a repeated keyword is not scraped twice in one invocation.

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
        targets = load_stores(stores_file) if stores_file else load_stores()

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
        """Release the adapter this runner built and stop progress. Idempotent."""
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
        """
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
        result = RunResult(marketplace=self.marketplace, mode=mode, targets=list(ordered))
        started = time.monotonic()

        self.progress.start(len(ordered))
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
        """Scrape and persist one target inside one transaction. Never raises.

        Args:
            mode: keyword or store.
            target: The keyword or shop username.
            pages: Pages to walk.

        Returns:
            The closed ScrapeRun — SUCCESS with a count, or FAILED with an error.
        """
        started_at = utcnow()
        staged = self._cache.child()

        try:
            with db.session_scope(self.database_url) as session:
                run = store_repo.start_run(
                    session, self.marketplace, mode, target, now=started_at
                )
                self.progress.set_phase("fetching")
                items = self._fetch(mode, target, pages=pages)
                self.progress.set_phase("saving")
                count = self._persist(session, items, staged=staged, now=started_at)
                run = store_repo.finish_run(
                    session,
                    run,
                    status=RunStatus.SUCCESS,
                    item_count=count,
                    now=utcnow(),
                )
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:  # noqa: BLE001 — continue-on-error is the contract
            # The CLI already renders the error per target, so keep the default
            # stderr line to one line and put the traceback behind DEBUG.
            log.warning("target %r failed: %r", target, exc)
            log.debug("traceback for target %r", target, exc_info=True)
            return self._record_failure(mode, target, started_at=started_at, exc=exc)

        # Committed: the staged stores.id values are now real.
        staged.promote()
        return run

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
    ) -> int:
        """Write every item through the fixed store -> product -> snapshot chain.

        Args:
            session: The open SQLAlchemy session owned by ``_execute_target``.
            items: Items to persist.
            staged: Per-target shop cache.
            now: One shared timestamp for the whole target, so a batch has a
                coherent clock.

        Returns:
            How many snapshots were inserted.
        """
        count = 0
        for item in items:
            store, product, snapshot = item
            # ScrapedItem.store is `Store | None` by contract: a keyword hit whose
            # payload carried no resolvable shop still has to be persisted, with a
            # null shop_ref for a later store-mode scrape to backfill.
            shop_ref = (
                self._resolve_shop(session, store, staged=staged, now=now)
                if store is not None
                else None
            )
            product_ref = store_repo.upsert_product(session, product, shop_ref, now=now)
            store_repo.insert_snapshot(session, snapshot, product_ref, now=now)
            count += 1
            self.progress.advance(1)
        return count

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
            enriched = staged.get_shop(key)
            if enriched is None and _looks_like_slug(
                store.username, store.shop_id, self._placeholder_predicate()
            ):
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
                    enriched = fetched
                    staged.put_shop(key, enriched)
            if enriched is not None:
                resolved = _merge_store(store, enriched)

        shop_ref = store_repo.upsert_store(session, resolved, now=now)
        staged.put_ref(key, shop_ref, resolved.username)
        return shop_ref

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
    ) -> ScrapeRun:
        """Write the FAILED audit row in its own committed transaction.

        The transaction that was scraping has already rolled back, taking its
        RUNNING row with it, so the audit row has to be re-created from scratch.
        If even that write fails (Postgres down), an unsaved ScrapeRun is
        returned so the CLI can still report the failure.

        Args:
            mode: keyword or store.
            target: The target that failed.
            started_at: When the target started, preserved from the first attempt.
            exc: The exception that ended the target.

        Returns:
            A ScrapeRun with ``status = FAILED`` and ``error`` set.
        """
        error = repr(exc)[:ERROR_MAX_CHARS]
        finished_at = utcnow()
        try:
            with db.session_scope(self.database_url) as session:
                run = store_repo.start_run(
                    session, self.marketplace, mode, target, now=started_at
                )
                return store_repo.finish_run(
                    session,
                    run,
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
    """Scrape and persist exactly one target inside one transaction.

    Sequence:

    1. Open ``db.session_scope``.
    2. ``store.start_run(...)`` and flush, so a RUNNING row exists before any
       network call.
    3. Call ``adapter.search_keyword`` or ``adapter.search_shop`` per ``mode``.
    4. For each :class:`~scraper.adapters.ScrapedItem`, run the fixed
       upsert_store -> upsert_product -> insert_snapshot chain, sharing one
       ``now`` timestamp across the whole target.
    5. ``store.finish_run(...)`` with SUCCESS and the item count.

    On exception: roll back the item writes, then record the run as FAILED with
    the exception repr **in its own committed transaction** — an audit row that
    vanished with the rollback would be useless. The exception is swallowed here
    and reflected in the returned run's status; only ``KeyboardInterrupt`` and
    ``SystemExit`` propagate.

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
