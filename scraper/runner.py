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
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from scraper.adapters import MarketplaceAdapter
from scraper.config import Settings
from scraper.models import Marketplace, RunMode, ScrapeRun

__all__ = ["RunResult", "resolve_targets", "run_target", "run"]


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
    """

    marketplace: Marketplace
    mode: RunMode
    targets: list[str] = field(default_factory=list)
    runs: list[ScrapeRun] = field(default_factory=list)
    item_count: int = 0
    failed_targets: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Whether every target succeeded.

        Returns:
            True when ``failed_targets`` is empty. The CLI maps False to a
            non-zero exit code.
        """
        raise NotImplementedError


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
    raise NotImplementedError


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
    """
    raise NotImplementedError


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
    :func:`run_target` and never lets one target's failure end the loop.

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
    raise NotImplementedError
