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

import logging

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from scraper.db import PriceSnapshotRow, ProductRow, ScrapeRunRow, StoreRow
from scraper.models import (
    Marketplace,
    PriceSnapshot,
    Product,
    RunMode,
    RunStatus,
    ScrapeRun,
    Store,
    utcnow,
)

__all__ = [
    "upsert_store",
    "upsert_product",
    "insert_snapshot",
    "insert_snapshot_if_changed",
    "start_run",
    "finish_run",
    "get_stats",
    "latest_prices",
    "price_history",
    "recent_price_changes",
    "recent_runs",
]

#: Upper bound on the text stored in ``scrape_runs.error``. A traceback repr from a
#: parse failure can run to megabytes; the audit log only needs the head of it.
MAX_ERROR_CHARS = 4000

log = logging.getLogger(__name__)


def _stamp(now: datetime | None) -> datetime:
    """Resolve the timestamp to write, defaulting to :func:`scraper.models.utcnow`.

    Args:
        now: Caller-supplied timestamp, or None.

    Returns:
        A timezone-aware UTC datetime.
    """
    return now if now is not None else utcnow()


def upsert_store(
    session: Session,
    store: Store,
    *,
    now: datetime | None = None,
    username_is_synthetic: bool = False,
) -> int:
    """Insert or update a shop, keyed on ``(marketplace, shop_id)``.

    Args:
        session: Open session. Not committed by this function.
        store: Domain model to persist. ``first_seen``/``last_seen`` on the model
            are ignored — this function owns those columns.
        now: Timestamp to stamp. Defaults to ``models.utcnow()``. The runner
            passes one shared value per target so a batch has a coherent clock.
        username_is_synthetic: True when ``store.username`` is a placeholder the
            adapter invented (e.g. ``"shop-30203584"``) rather than a real slug
            scraped from the payload. ``stores.username`` is NOT NULL, so the
            adapter cannot signal "unknown" with None and plain COALESCE would
            happily overwrite a real slug with the placeholder. When this flag is
            set the SET clause keeps whatever is already stored and only falls
            back to the placeholder for a genuinely new row.

    Returns:
        ``stores.id`` of the inserted or existing row — pass this as
        ``shop_ref`` to :func:`upsert_product`.
    """
    ts = _stamp(now)
    table = StoreRow.__table__

    stmt = pg_insert(StoreRow).values(
        marketplace=store.marketplace.value,
        shop_id=store.shop_id,
        username=store.username,
        name=store.name,
        location=store.location,
        follower_count=store.follower_count,
        rating_star=store.rating_star,
        first_seen=ts,
        last_seen=ts,
    )
    # A synthetic username reverses the COALESCE arguments: the stored slug wins,
    # and the placeholder is only used when there is nothing stored yet. Without
    # this a keyword-mode hit — which carries no shop_username and so always
    # arrives with a placeholder — would overwrite the real slug a store-mode
    # scrape captured, corrupting required output field #1 for every product of
    # that shop.
    username_set = (
        func.coalesce(table.c.username, stmt.excluded.username)
        if username_is_synthetic
        else func.coalesce(stmt.excluded.username, table.c.username)
    )

    stmt = stmt.on_conflict_do_update(
        constraint="uq_stores_marketplace_shop_id",
        set_={
            # COALESCE(new, old): a sparse payload leaves the stored value alone
            # instead of erasing detail a richer earlier scrape captured.
            "username": username_set,
            "name": func.coalesce(stmt.excluded.name, table.c.name),
            "location": func.coalesce(stmt.excluded.location, table.c.location),
            "follower_count": func.coalesce(stmt.excluded.follower_count, table.c.follower_count),
            "rating_star": func.coalesce(stmt.excluded.rating_star, table.c.rating_star),
            # first_seen is deliberately absent from this SET clause — it is
            # written once on insert and never touched again.
            "last_seen": stmt.excluded.last_seen,
        },
    ).returning(StoreRow.id)

    # DO UPDATE (rather than DO NOTHING) guarantees RETURNING yields a row on the
    # conflict path too, so the id comes back in a single round trip with no
    # read-then-write race between concurrent writers.
    return session.execute(stmt).scalar_one()


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
    ts = _stamp(now)
    table = ProductRow.__table__

    stmt = pg_insert(ProductRow).values(
        marketplace=product.marketplace.value,
        item_id=product.item_id,
        # product.shop_id is the MARKETPLACE's id and is not stored here; the
        # caller resolves it to our stores.id and passes it as shop_ref.
        shop_ref=shop_ref,
        name=product.name,
        url=product.url,
        image=product.image,
        category=product.category,
        first_seen=ts,
        last_seen=ts,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_products_marketplace_item_id",
        set_={
            # COALESCE also gives shop_ref backfill semantics: a keyword scrape
            # that could not resolve the shop passes None and leaves any
            # previously-resolved ref intact, while a store scrape fills it in.
            "shop_ref": func.coalesce(stmt.excluded.shop_ref, table.c.shop_ref),
            "name": func.coalesce(stmt.excluded.name, table.c.name),
            "url": func.coalesce(stmt.excluded.url, table.c.url),
            "image": func.coalesce(stmt.excluded.image, table.c.image),
            "category": func.coalesce(stmt.excluded.category, table.c.category),
            # first_seen intentionally omitted — insert-only.
            "last_seen": stmt.excluded.last_seen,
        },
    ).returning(ProductRow.id)

    return session.execute(stmt).scalar_one()


def insert_snapshot(
    session: Session, snapshot: PriceSnapshot, product_ref: int, *, now: datetime | None = None
) -> int:
    """Append one price observation. Always an INSERT — never an upsert.

    Args:
        session: Open session. Not committed by this function.
        snapshot: Observation to store. Its ``item_id`` is not written to the
            table; ``product_ref`` is the link.
        product_ref: ``products.id`` from :func:`upsert_product`.
        now: The observation timestamp to write. When supplied it **wins over**
            ``snapshot.scraped_at``; when omitted, the snapshot's own value is
            used, falling back to ``models.utcnow()``.

    Returns:
        The new ``price_snapshots.id``.
    """
    # Precedence note: `now` deliberately overrides the model value rather than
    # merely filling a None. PriceSnapshot.scraped_at has a `default_factory` of
    # utcnow(), so it is essentially never None by the time an adapter hands it
    # over — under fill-only semantics the caller's `now` would be dead code and
    # the runner's documented "one shared clock per target" would silently not
    # hold (observed: two snapshots from one batch 34us apart). The runner passes
    # one timestamp per target precisely so a batch is diffable as a unit.
    scraped_at = now if now is not None else snapshot.scraped_at
    if scraped_at is None:
        scraped_at = utcnow()
    # No ON CONFLICT here by design: this table is the time series. Two scrapes of
    # the same product must produce two rows, otherwise there is nothing to diff.
    stmt = (
        insert(PriceSnapshotRow)
        .values(
            product_ref=product_ref,
            price=snapshot.price,
            price_min=snapshot.price_min,
            price_max=snapshot.price_max,
            stock=snapshot.stock,
            sold=snapshot.sold,
            historical_sold=snapshot.historical_sold,
            rating_star=snapshot.rating_star,
            rating_count=snapshot.rating_count,
            scraped_at=scraped_at,
        )
        .returning(PriceSnapshotRow.id)
    )
    return session.execute(stmt).scalar_one()


#: Fields that decide whether an observation says anything new.
#:
#: ``stock`` is deliberately excluded. It moves on almost every scrape of a
#: busy listing, so including it would defeat deduplication entirely while
#: telling a price-comparison dashboard nothing it asked about.
_SNAPSHOT_SIGNIFICANT_FIELDS = (
    "price",
    "price_min",
    "price_max",
    "sold",
    "historical_sold",
    "rating_star",
    "rating_count",
)


def insert_snapshot_if_changed(
    session: Session,
    snapshot: PriceSnapshot,
    product_ref: int,
    *,
    now: datetime | None = None,
    window_hours: float | None = 24.0,
) -> int | None:
    """Append an observation, unless it repeats the previous one verbatim.

    The snapshots table is a time series and must stay append-only, but scraping
    the same page twice in a row produces two byte-identical rows that carry no
    information — they are not price history, they are noise, and they distort
    any "how often did this change" reading of the data.

    So an observation is skipped when every significant field matches the
    product's most recent snapshot *and* that snapshot is recent enough. Past
    ``window_hours``, an unchanged observation is written anyway, because
    "the price was still 55.000 a week later" is a real, useful fact that a
    gap in the series cannot express.

    Args:
        session: Open session. Not committed by this function.
        snapshot: Observation to consider.
        product_ref: ``products.id`` from :func:`upsert_product`.
        now: Observation timestamp; wins over ``snapshot.scraped_at``.
        window_hours: How long an unchanged observation stays redundant. None
            disables the check entirely, restoring plain append behaviour.

    Returns:
        The new ``price_snapshots.id``, or None when the observation was
        skipped as unchanged.
    """
    if window_hours is None:
        return insert_snapshot(session, snapshot, product_ref, now=now)

    scraped_at = now or snapshot.scraped_at or utcnow()

    latest = session.execute(
        select(PriceSnapshotRow)
        .where(PriceSnapshotRow.product_ref == product_ref)
        .order_by(PriceSnapshotRow.scraped_at.desc(), PriceSnapshotRow.id.desc())
        .limit(1)
    ).scalar_one_or_none()

    if latest is not None and _snapshot_matches(latest, snapshot):
        previous_at = latest.scraped_at
        if previous_at is not None:
            # Rows written before timezone handling settled can be naive; treat
            # those as UTC rather than raising on the subtraction.
            if previous_at.tzinfo is None:
                previous_at = previous_at.replace(tzinfo=timezone.utc)
            # abs(): the previous row can legitimately carry a *later* timestamp
            # than this observation — a backfilled capturedAt, an out-of-order
            # replay, a clock skew. An identical observation within the window is
            # redundant whichever side of it the neighbour sits on, and requiring
            # a forward-only delta silently disabled deduplication for exactly
            # those cases.
            age_hours = abs((scraped_at - previous_at).total_seconds()) / 3600.0
            if age_hours < window_hours:
                log.debug(
                    "skipping unchanged snapshot for product_ref=%s (%.1fh since the last one)",
                    product_ref,
                    age_hours,
                )
                return None

    return insert_snapshot(session, snapshot, product_ref, now=now)


def _snapshot_matches(row: PriceSnapshotRow, snapshot: PriceSnapshot) -> bool:
    """Whether a stored row carries the same significant values as an observation.

    Numeric comparison goes through Decimal so that a stored ``55000.00`` and an
    observed ``55000`` count as equal — otherwise every scrape would look like a
    change and nothing would ever be deduplicated.
    """
    for field_name in _SNAPSHOT_SIGNIFICANT_FIELDS:
        stored = getattr(row, field_name, None)
        observed = getattr(snapshot, field_name, None)
        if stored is None and observed is None:
            continue
        if stored is None or observed is None:
            return False
        try:
            if Decimal(str(stored)) != Decimal(str(observed)):
                return False
        except (InvalidOperation, ValueError):
            if str(stored) != str(observed):
                return False
    return True


def start_run(
    session: Session,
    marketplace: Marketplace,
    mode: RunMode,
    target: str,
    *,
    now: datetime | None = None,
) -> ScrapeRun:
    """Open an audit row with ``status = RUNNING`` and flush it to get an id.

    ``session.flush()`` (not commit) populates ``scrape_runs.id`` on the returned
    model; transaction ownership stays with the caller, as everywhere else in
    this module.

    Durability caveat: a flushed row is invisible outside its transaction and
    disappears with a rollback, so "a crashed process leaves a RUNNING row behind
    as evidence" holds **only if the caller commits this transaction before it
    starts scraping**. :meth:`scraper.runner.ScrapeRunner._execute_target` does
    exactly that — it commits the RUNNING row, then fetches with no transaction
    open, then persists and closes the run in a second transaction. A caller that
    keeps one transaction open across the network phase gets no audit trail from
    a SIGKILL and holds a connection idle-in-transaction for the whole scrape.

    Args:
        session: Open session. Not committed by this function.
        marketplace: Marketplace being scraped.
        mode: ``RunMode.KEYWORD`` or ``RunMode.STORE``.
        target: The keyword or the shop username.
        now: Value for ``started_at``. Defaults to ``models.utcnow()``.

    Returns:
        A :class:`ScrapeRun` with ``id`` and ``started_at`` populated.
    """
    ts = _stamp(now)
    row = ScrapeRunRow(
        marketplace=marketplace.value,
        mode=mode.value,
        target=target,
        started_at=ts,
        finished_at=None,
        status=RunStatus.RUNNING.value,
        item_count=0,
        error=None,
    )
    session.add(row)
    # flush, not commit: the caller owns the transaction. This populates row.id
    # from the sequence so the RUNNING row is addressable before scraping starts.
    session.flush()

    return ScrapeRun(
        id=row.id,
        marketplace=marketplace,
        mode=mode,
        target=target,
        started_at=ts,
        finished_at=None,
        status=RunStatus.RUNNING,
        item_count=0,
        error=None,
    )


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
    if run.id is None:
        raise ValueError("finish_run() requires a ScrapeRun with an id; call start_run() first.")

    ts = _stamp(now)
    truncated = error[:MAX_ERROR_CHARS] if error is not None else None

    row = session.get(ScrapeRunRow, run.id)
    if row is None:
        raise ValueError(f"scrape_runs row {run.id} not found; it may have been rolled back.")

    row.status = status.value
    row.item_count = item_count
    row.error = truncated
    row.finished_at = ts
    session.flush()

    # Mirror the terminal state back onto the caller's model so it stays the
    # single object describing this run.
    run.status = status
    run.item_count = item_count
    run.error = truncated
    run.finished_at = ts
    return run


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
    mp = marketplace.value if marketplace is not None else None

    stores_q = select(func.count()).select_from(StoreRow)
    products_q = select(func.count()).select_from(ProductRow)
    # price_snapshots has no marketplace column of its own, so scoping a snapshot
    # count means going through its product.
    snapshots_q = select(func.count()).select_from(PriceSnapshotRow)
    last_snapshot_q = select(func.max(PriceSnapshotRow.scraped_at))
    runs_q = select(func.count()).select_from(ScrapeRunRow)
    last_run_q = select(func.max(ScrapeRunRow.started_at))
    by_status_q = select(ScrapeRunRow.status, func.count()).group_by(ScrapeRunRow.status)

    if mp is not None:
        stores_q = stores_q.where(StoreRow.marketplace == mp)
        products_q = products_q.where(ProductRow.marketplace == mp)
        snapshots_q = snapshots_q.join(
            ProductRow, ProductRow.id == PriceSnapshotRow.product_ref
        ).where(ProductRow.marketplace == mp)
        last_snapshot_q = last_snapshot_q.select_from(PriceSnapshotRow).join(
            ProductRow, ProductRow.id == PriceSnapshotRow.product_ref
        ).where(ProductRow.marketplace == mp)
        runs_q = runs_q.where(ScrapeRunRow.marketplace == mp)
        last_run_q = last_run_q.where(ScrapeRunRow.marketplace == mp)
        by_status_q = by_status_q.where(ScrapeRunRow.marketplace == mp)

    runs_by_status = {
        status: count for status, count in session.execute(by_status_q).all() if status is not None
    }

    return {
        "stores": session.execute(stores_q).scalar_one(),
        "products": session.execute(products_q).scalar_one(),
        "snapshots": session.execute(snapshots_q).scalar_one(),
        "runs": session.execute(runs_q).scalar_one(),
        "last_run_at": session.execute(last_run_q).scalar_one(),
        "last_snapshot_at": session.execute(last_snapshot_q).scalar_one(),
        "runs_by_status": runs_by_status,
    }


def latest_prices(
    session: Session,
    marketplace: Marketplace | None = None,
    *,
    limit: int | None = None,
) -> list[dict[str, object]]:
    """Return the most recent snapshot for every product — the dashboard's main view.

    One row per product, joined to its shop, carrying the five required output
    fields (shop username, listing title, price, units sold, product rating) plus
    the surrounding context. Products with no snapshot yet are omitted.

    Implemented with Postgres ``DISTINCT ON (product_ref) ORDER BY product_ref,
    scraped_at DESC``, which the ``ix_price_snapshots_product_ref_scraped_at``
    index serves directly — no correlated subquery, no window function.

    Args:
        session: Open session, read-only usage.
        marketplace: Restrict to one marketplace, or None for all.
        limit: Cap the number of rows, or None for all of them.

    Returns:
        Rows newest-first, each a dict with keys: ``marketplace``, ``item_id``,
        ``name``, ``url``, ``image``, ``category``, ``shop_id``, ``shop_username``,
        ``shop_name``, ``location``, ``price``, ``price_min``, ``price_max``,
        ``stock``, ``sold``, ``historical_sold``, ``rating_star``,
        ``rating_count``, ``scraped_at``. Shop-derived keys are None when the
        product's ``shop_ref`` was never resolved.
    """
    latest = (
        select(
            PriceSnapshotRow.product_ref.label("product_ref"),
            PriceSnapshotRow.price.label("price"),
            PriceSnapshotRow.price_min.label("price_min"),
            PriceSnapshotRow.price_max.label("price_max"),
            PriceSnapshotRow.stock.label("stock"),
            PriceSnapshotRow.sold.label("sold"),
            PriceSnapshotRow.historical_sold.label("historical_sold"),
            PriceSnapshotRow.rating_star.label("rating_star"),
            PriceSnapshotRow.rating_count.label("rating_count"),
            PriceSnapshotRow.scraped_at.label("scraped_at"),
        )
        .distinct(PriceSnapshotRow.product_ref)
        .order_by(PriceSnapshotRow.product_ref, PriceSnapshotRow.scraped_at.desc())
        .subquery("latest")
    )

    query = (
        select(
            ProductRow.marketplace.label("marketplace"),
            ProductRow.item_id.label("item_id"),
            ProductRow.name.label("name"),
            ProductRow.url.label("url"),
            ProductRow.image.label("image"),
            ProductRow.category.label("category"),
            StoreRow.shop_id.label("shop_id"),
            StoreRow.username.label("shop_username"),
            StoreRow.name.label("shop_name"),
            StoreRow.location.label("location"),
            latest.c.price,
            latest.c.price_min,
            latest.c.price_max,
            latest.c.stock,
            latest.c.sold,
            latest.c.historical_sold,
            latest.c.rating_star,
            latest.c.rating_count,
            latest.c.scraped_at,
        )
        .select_from(latest)
        .join(ProductRow, ProductRow.id == latest.c.product_ref)
        # outerjoin: shop_ref is nullable, and a product with an unresolved shop
        # must still appear in the dashboard.
        .outerjoin(StoreRow, StoreRow.id == ProductRow.shop_ref)
        .order_by(latest.c.scraped_at.desc(), ProductRow.item_id)
    )

    if marketplace is not None:
        query = query.where(ProductRow.marketplace == marketplace.value)
    if limit is not None:
        query = query.limit(limit)

    return [dict(row) for row in session.execute(query).mappings().all()]


def recent_runs(
    session: Session,
    *,
    marketplace: Marketplace | None = None,
    limit: int = 10,
) -> list[dict[str, object]]:
    """Return the most recent ``scrape_runs`` rows, newest first.

    Backs the ``stats`` CLI table. Lives here rather than in ``cli.py`` because
    ``docs/DESIGN.md`` §7 gives ``cli.py`` option parsing and Rich rendering only,
    and this module all database access.

    Args:
        session: Open session, read-only usage.
        marketplace: Restrict to one marketplace, or None for all.
        limit: Maximum rows to return.

    Returns:
        Rows newest-first, each a dict with keys ``id``, ``marketplace``,
        ``mode``, ``target``, ``started_at``, ``finished_at``, ``status``,
        ``item_count`` and ``error``.
    """
    query = (
        select(
            ScrapeRunRow.id,
            ScrapeRunRow.marketplace,
            ScrapeRunRow.mode,
            ScrapeRunRow.target,
            ScrapeRunRow.started_at,
            ScrapeRunRow.finished_at,
            ScrapeRunRow.status,
            ScrapeRunRow.item_count,
            ScrapeRunRow.error,
        )
        # id breaks ties: several targets in one invocation can share a
        # started_at, and an unstable order makes the table flicker between runs.
        .order_by(ScrapeRunRow.started_at.desc(), ScrapeRunRow.id.desc())
        .limit(limit)
    )
    if marketplace is not None:
        query = query.where(ScrapeRunRow.marketplace == marketplace.value)
    return [dict(row) for row in session.execute(query).mappings().all()]


def recent_price_changes(
    session: Session,
    *,
    marketplace: Marketplace | None = None,
    limit: int = 10,
) -> list[dict[str, object]]:
    """Return the most recently observed price *movements*.

    Compares each snapshot with the preceding snapshot of the same product via a
    ``lag()`` window and keeps only the rows where the price actually changed.
    This is the headline output of the whole tracker: a price column alone is a
    catalogue, a price column plus its previous value is a price monitor.

    Rows where either side is NULL are excluded — "price became known" is not a
    price change, and rendering it as one would invent a fake delta.

    Args:
        session: Open session, read-only usage.
        marketplace: Restrict to one marketplace, or None for all.
        limit: Maximum rows to return.

    Returns:
        Rows newest-first, each a dict with keys ``scraped_at``, ``marketplace``,
        ``item_id``, ``product_name``, ``username``, ``previous_price`` and
        ``price``. ``username`` is None when the product's shop is unresolved.
    """
    windowed = (
        select(
            PriceSnapshotRow.product_ref.label("product_ref"),
            PriceSnapshotRow.price.label("price"),
            PriceSnapshotRow.scraped_at.label("scraped_at"),
            func.lag(PriceSnapshotRow.price)
            .over(
                partition_by=PriceSnapshotRow.product_ref,
                # id is part of the ordering because the runner stamps one shared
                # scraped_at across a whole target: without it, two snapshots of
                # one product in a single batch have no defined predecessor.
                order_by=(PriceSnapshotRow.scraped_at, PriceSnapshotRow.id),
            )
            .label("previous_price"),
        )
    ).subquery("windowed")

    query = (
        select(
            windowed.c.scraped_at,
            windowed.c.price,
            windowed.c.previous_price,
            ProductRow.marketplace.label("marketplace"),
            ProductRow.item_id.label("item_id"),
            ProductRow.name.label("product_name"),
            StoreRow.username.label("username"),
        )
        .select_from(windowed)
        .join(ProductRow, ProductRow.id == windowed.c.product_ref)
        .outerjoin(StoreRow, StoreRow.id == ProductRow.shop_ref)
        .where(windowed.c.previous_price.isnot(None))
        .where(windowed.c.price.isnot(None))
        .where(windowed.c.price != windowed.c.previous_price)
        .order_by(windowed.c.scraped_at.desc())
        .limit(limit)
    )
    if marketplace is not None:
        query = query.where(ProductRow.marketplace == marketplace.value)
    return [dict(row) for row in session.execute(query).mappings().all()]


def price_history(
    session: Session,
    item_id: int,
    *,
    marketplace: Marketplace | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    """Return every snapshot recorded for one listing — the dashboard's detail view.

    Consecutive rows are what a price chart and a units-sold velocity calculation
    are diffed from.

    Note that ``item_id`` alone is not globally unique: uniqueness is
    ``(marketplace, item_id)``. Left unfiltered this can therefore return rows
    from two marketplaces that happen to share an id, which is why every row
    carries its own ``marketplace``. Pass ``marketplace`` to scope it.

    Args:
        session: Open session, read-only usage.
        item_id: The marketplace's own item id (``Product.item_id``), not
            ``products.id``.
        marketplace: Restrict to one marketplace, or None for all.
        limit: Cap the number of rows, or None for the full history.

    Returns:
        Rows ordered newest-first, each a dict with keys: ``marketplace``,
        ``item_id``, ``name``, ``price``, ``price_min``, ``price_max``, ``stock``,
        ``sold``, ``historical_sold``, ``rating_star``, ``rating_count``,
        ``scraped_at``. Empty when the listing is unknown or has no snapshots.
    """
    query = (
        select(
            ProductRow.marketplace.label("marketplace"),
            ProductRow.item_id.label("item_id"),
            ProductRow.name.label("name"),
            PriceSnapshotRow.price.label("price"),
            PriceSnapshotRow.price_min.label("price_min"),
            PriceSnapshotRow.price_max.label("price_max"),
            PriceSnapshotRow.stock.label("stock"),
            PriceSnapshotRow.sold.label("sold"),
            PriceSnapshotRow.historical_sold.label("historical_sold"),
            PriceSnapshotRow.rating_star.label("rating_star"),
            PriceSnapshotRow.rating_count.label("rating_count"),
            PriceSnapshotRow.scraped_at.label("scraped_at"),
        )
        .select_from(PriceSnapshotRow)
        .join(ProductRow, ProductRow.id == PriceSnapshotRow.product_ref)
        .where(ProductRow.item_id == item_id)
        # id breaks ties when two snapshots share a scraped_at (the runner stamps
        # one shared clock value across a batch), keeping the order deterministic.
        .order_by(PriceSnapshotRow.scraped_at.desc(), PriceSnapshotRow.id.desc())
    )

    if marketplace is not None:
        query = query.where(ProductRow.marketplace == marketplace.value)
    if limit is not None:
        query = query.limit(limit)

    return [dict(row) for row in session.execute(query).mappings().all()]
