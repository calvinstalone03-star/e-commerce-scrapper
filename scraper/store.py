"""Repository layer — the only module that writes to Postgres.

Every function takes an explicit :class:`sqlalchemy.orm.Session` as its first
argument and **never commits**. Transaction boundaries belong to the caller
(``scraper.runner`` uses ``db.session_scope``), which keeps a whole target's
writes atomic and makes these functions trivially testable against a rolled-back
session.

Return convention: the upserts return our **database primary key** (an ``int``),
not the ORM row, so callers cannot accidentally hold detached instances. That id
is what gets threaded into ``products.shop_ref`` and
``price_snapshots.product_ref``.

Upsert semantics:

* ``upsert_store`` conflicts on ``(marketplace, shop_id)``.
* ``upsert_product`` conflicts on ``(marketplace, item_id)``.
* On insert, both set ``first_seen`` and ``last_seen`` to now.
* On conflict, both bump ``last_seen`` and refresh the mutable descriptive
  columns, but must **never overwrite a non-null stored value with NULL** — a
  sparse search-results payload must not erase detail scraped earlier.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from scraper.models import Marketplace, PriceSnapshot, Product, RunMode, RunStatus, ScrapeRun, Store

__all__ = [
    "upsert_store",
    "upsert_product",
    "insert_snapshot",
    "start_run",
    "finish_run",
    "get_stats",
]


def upsert_store(session: Session, store: Store, *, now: datetime | None = None) -> int:
    """Insert or update a shop, keyed on ``(marketplace, shop_id)``.

    Args:
        session: Open session. Not committed by this function.
        store: Domain model to persist. ``first_seen``/``last_seen`` on the model
            are ignored — this function owns those columns.
        now: Timestamp to stamp. Defaults to ``models.utcnow()``. The runner
            passes one shared value per target so a batch has a coherent clock.

    Returns:
        ``stores.id`` of the inserted or existing row — pass this as
        ``shop_ref`` to :func:`upsert_product`.
    """
    raise NotImplementedError


def upsert_product(
    session: Session, product: Product, shop_ref: int | None, *, now: datetime | None = None
) -> int:
    """Insert or update a listing, keyed on ``(marketplace, item_id)``.

    Args:
        session: Open session. Not committed by this function.
        product: Domain model to persist. Its ``shop_id`` is the marketplace's
            id and is **not** written to the table; ``shop_ref`` is.
        shop_ref: ``stores.id`` from :func:`upsert_store`, or None when the shop
            is unknown (keyword search results occasionally omit shop detail).
            A later scrape that does know the shop must backfill it.
        now: Timestamp to stamp. Defaults to ``models.utcnow()``.

    Returns:
        ``products.id`` — pass this as ``product_ref`` to :func:`insert_snapshot`.
    """
    raise NotImplementedError


def insert_snapshot(
    session: Session, snapshot: PriceSnapshot, product_ref: int, *, now: datetime | None = None
) -> int:
    """Append one price observation. Always an INSERT — never an upsert.

    Args:
        session: Open session. Not committed by this function.
        snapshot: Observation to store. Its ``item_id`` is not written to the
            table; ``product_ref`` is the link.
        product_ref: ``products.id`` from :func:`upsert_product`.
        now: Fallback for ``scraped_at`` when the snapshot leaves it None.
            Defaults to ``models.utcnow()``.

    Returns:
        The new ``price_snapshots.id``.
    """
    raise NotImplementedError


def start_run(
    session: Session,
    marketplace: Marketplace,
    mode: RunMode,
    target: str,
    *,
    now: datetime | None = None,
) -> ScrapeRun:
    """Open an audit row with ``status = RUNNING`` and flush it to get an id.

    Must ``session.flush()`` (not commit) so ``scrape_runs.id`` is populated on
    the returned model before any scraping happens — that way a crashed process
    still leaves a RUNNING row behind as evidence.

    Args:
        session: Open session. Not committed by this function.
        marketplace: Marketplace being scraped.
        mode: ``RunMode.KEYWORD`` or ``RunMode.STORE``.
        target: The keyword or the shop username.
        now: Value for ``started_at``. Defaults to ``models.utcnow()``.

    Returns:
        A :class:`ScrapeRun` with ``id`` and ``started_at`` populated.
    """
    raise NotImplementedError


def finish_run(
    session: Session,
    run: ScrapeRun,
    *,
    status: RunStatus,
    item_count: int,
    error: str | None = None,
    now: datetime | None = None,
) -> ScrapeRun:
    """Close an audit row opened by :func:`start_run`.

    Args:
        session: Open session. Not committed by this function.
        run: The model returned by :func:`start_run`; ``run.id`` must be set.
        status: Terminal status — SUCCESS, PARTIAL or FAILED.
        item_count: Number of snapshots persisted for this target.
        error: Exception repr when ``status`` is FAILED, else None. Truncate to a
            sane length (a few KB) before storing.
        now: Value for ``finished_at``. Defaults to ``models.utcnow()``.

    Returns:
        The same ScrapeRun with the terminal fields filled in.

    Raises:
        ValueError: If ``run.id`` is None (i.e. ``start_run`` was never called).
    """
    raise NotImplementedError


def get_stats(session: Session, *, marketplace: Marketplace | None = None) -> dict[str, object]:
    """Aggregate counts for the ``stats`` CLI command.

    Args:
        session: Open session, read-only usage.
        marketplace: Restrict to one marketplace, or None for all.

    Returns:
        A dict with at least these keys, suitable for a Rich table::

            {
                "stores": int,
                "products": int,
                "snapshots": int,
                "runs": int,
                "last_run_at": datetime | None,
                "last_snapshot_at": datetime | None,
                "runs_by_status": dict[str, int],
            }
    """
    raise NotImplementedError
