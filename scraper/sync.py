"""Mirror the scraped tables from one database into another.

Two databases exist here for a reason that is not going away: scraping happens
in a browser on this laptop and writes to Postgres on this laptop, while the
dashboard runs on Vercel and can only read a database Vercel can reach. Section
7 of the README seeds the second one with a per-table ``pg_dump``. That works
once. Afterwards the laptop keeps collecting and the two drift apart, and a
dump-based reload is no longer obviously safe, because by then it is not clear
which side holds what.

This module is the repeatable version of that step, and it is deliberately a
**mirror rather than a merge**: the source is the truth, and afterwards the
target's scraped tables are byte-for-byte what the source holds, ids included.

Why ids are copied rather than regenerated. The primary keys here are internal
serials — ``products.id`` means nothing to Shopee — and the natural keys are
``(marketplace, shop_id)`` and ``(marketplace, item_id)``. A merge would have to
map every source id to a target id and rewrite ``shop_ref`` and ``product_ref``
as it went. Copying ids verbatim skips that entirely, and leaves the two
databases agreeing on what row 8134 is, which matters the moment anything holds
an id across them — ``notify_watermark`` does exactly that.

What this does **not** touch: ``app_credentials`` and ``notify_watermark``. Both
belong to the dashboard rather than to the scrape, and the target's login is
deliberately not the laptop's (README section 7, step 2). The watermark is
instead *reseeded* to the mirrored maximums by :func:`reseed_watermark`, for the
reason ``migrations/005_notify_watermark.sql`` gives: everything just copied
predates the notifier's interest in it, and announcing 18,000 long-known
listings as new is not a useful notification.

The destructive part is guarded rather than trusted. :func:`plan` reports what
each side holds and, crucially, which natural keys exist in the target and *not*
in the source — rows a mirror would destroy. The CLI refuses to run when that
list is non-empty unless it is explicitly overridden.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from sqlalchemy import func, select, text
from sqlalchemy.engine import Engine

from scraper.db import Base, ProductRow, StoreRow

__all__ = [
    "OWNED_BY_TARGET",
    "SCRAPED_TABLES",
    "SyncPlan",
    "TableDiff",
    "mirror",
    "natural_keys",
    "plan",
    "reseed_watermark",
    "table_counts",
]

log = logging.getLogger(__name__)

#: The scraped tables, in an order that satisfies the foreign keys on insert:
#: ``products.shop_ref`` -> ``stores.id``, and both ``product_keywords`` and
#: ``price_snapshots`` -> ``products.id``. Deletion walks this in reverse.
SCRAPED_TABLES: tuple[str, ...] = (
    "stores",
    "products",
    "product_keywords",
    "price_snapshots",
    "scrape_runs",
)

#: Tables the target owns and this never writes. The dashboard makes both
#: (``lib/auth.ts``, ``lib/notify/watermark.ts``), and a deployment's login is
#: not meant to be the laptop's.
OWNED_BY_TARGET: frozenset[str] = frozenset({"app_credentials", "notify_watermark"})

#: Rows per round trip. The target is usually across the internet, so this is a
#: latency knob, not a memory one: 18,000 products at 1,000 a time is 18 round
#: trips instead of 18,000.
DEFAULT_BATCH_SIZE = 1_000


@dataclass(frozen=True)
class TableDiff:
    """How many rows each side holds for one table.

    Attributes:
        table: Table name.
        source: Row count in the source database.
        target: Row count in the target database, before mirroring.
    """

    table: str
    source: int
    target: int

    @property
    def delta(self) -> int:
        """Rows the target gains (positive) or loses (negative) from a mirror."""
        return self.source - self.target


@dataclass
class SyncPlan:
    """What a mirror would do, computed before anything is written.

    Attributes:
        diffs: Per-table counts, in :data:`SCRAPED_TABLES` order.
        target_only_stores: ``(marketplace, shop_id)`` present in the target and
            absent from the source.
        target_only_products: ``(marketplace, item_id)``, likewise.
        missing_tables: Scraped tables absent from the target — it has never had
            the migrations run against it.
    """

    diffs: list[TableDiff] = field(default_factory=list)
    target_only_stores: list[tuple[str, int]] = field(default_factory=list)
    target_only_products: list[tuple[str, int]] = field(default_factory=list)
    missing_tables: list[str] = field(default_factory=list)

    @property
    def destroys_rows(self) -> bool:
        """Whether the target holds scraped rows the source cannot replace.

        The one question worth answering before a mirror. Counts alone cannot
        answer it: a target with *fewer* rows can still hold a shop the source
        has never seen.
        """
        return bool(self.target_only_stores or self.target_only_products)


def table_counts(engine: Engine, tables: tuple[str, ...] = SCRAPED_TABLES) -> dict[str, int]:
    """Count rows in each table, treating an absent table as absent, not as zero.

    Args:
        engine: Database to count in.
        tables: Table names.

    Returns:
        Table name -> row count, omitting tables the database does not have.
    """
    counts: dict[str, int] = {}
    with engine.connect() as conn:
        present = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                )
            )
        }
        for table in tables:
            if table not in present:
                continue
            counts[table] = conn.execute(
                select(func.count()).select_from(Base.metadata.tables[table])
            ).scalar_one()
    return counts


def natural_keys(engine: Engine, table: str) -> set[tuple[str, int]]:
    """Read a table's natural keys.

    Args:
        engine: Database to read.
        table: ``stores`` or ``products``.

    Returns:
        ``{(marketplace, shop_id)}`` for stores, ``{(marketplace, item_id)}``
        for products. Empty when the table does not exist.

    Raises:
        ValueError: For any other table — nothing else here has a natural key
            this comparison can use.
    """
    if table == "stores":
        stmt = select(StoreRow.marketplace, StoreRow.shop_id)
    elif table == "products":
        stmt = select(ProductRow.marketplace, ProductRow.item_id)
    else:
        raise ValueError(f"{table} has no natural key to compare on")

    if table not in table_counts(engine, (table,)):
        return set()

    with engine.connect() as conn:
        return {(row[0], row[1]) for row in conn.execute(stmt)}


def plan(source: Engine, target: Engine) -> SyncPlan:
    """Describe what mirroring ``source`` onto ``target`` would do.

    Read-only on both sides. Run this before :func:`mirror` and show it to a
    human — the mirror deletes.

    Args:
        source: Database holding the truth.
        target: Database to be overwritten.

    Returns:
        A :class:`SyncPlan`.
    """
    source_counts = table_counts(source)
    target_counts = table_counts(target)

    result = SyncPlan(
        diffs=[
            TableDiff(table, source_counts.get(table, 0), target_counts.get(table, 0))
            for table in SCRAPED_TABLES
        ],
        missing_tables=[t for t in SCRAPED_TABLES if t not in target_counts],
    )

    # Only worth asking of a target that has the tables at all: a fresh Neon
    # project answers "nothing here is at risk" by construction.
    if not result.missing_tables:
        source_stores = natural_keys(source, "stores")
        source_products = natural_keys(source, "products")
        result.target_only_stores = sorted(natural_keys(target, "stores") - source_stores)
        result.target_only_products = sorted(
            natural_keys(target, "products") - source_products
        )
    return result


def _rows(engine: Engine, table: str, batch_size: int) -> Iterator[list[dict]]:
    """Stream one table out of the source in batches.

    Server-side cursor rather than one big fetch: ``price_snapshots`` is the
    table that grows without bound, and loading it whole is a memory cost that
    buys nothing.
    """
    columns = Base.metadata.tables[table]
    with engine.connect().execution_options(
        stream_results=True, yield_per=batch_size
    ) as conn:
        for partition in conn.execute(select(columns)).partitions():
            yield [dict(row._mapping) for row in partition]


def mirror(
    source: Engine,
    target: Engine,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    on_progress: Callable[[str, int], None] | None = None,
) -> dict[str, int]:
    """Replace the target's scraped tables with the source's, ids included.

    One transaction on the target: a failure — a dropped connection to Neon
    halfway through 22,000 snapshots is the realistic one — rolls the whole
    thing back and leaves the target as it was. A partially mirrored database
    would be worse than either end state, because nothing about it would look
    wrong.

    Args:
        source: Database to read.
        target: Database to overwrite. Its ``app_credentials`` and
            ``notify_watermark`` are left alone.
        batch_size: Rows per insert round trip.
        on_progress: Called as ``(table, rows_written_so_far)`` after each batch.

    Returns:
        Rows written per table.

    Raises:
        sqlalchemy.exc.SQLAlchemyError: On any database failure. The target is
            unchanged when this raises.
    """
    written: dict[str, int] = {}

    with target.begin() as tx:
        # One statement, so the tables go empty together and no foreign key is
        # transiently violated. No CASCADE: if something outside this list
        # references these rows, the right outcome is a loud error rather than a
        # silent truncation of a table nobody asked about.
        tx.execute(text(f"TRUNCATE {', '.join(SCRAPED_TABLES)} RESTART IDENTITY"))

        for table in SCRAPED_TABLES:
            columns = Base.metadata.tables[table]
            count = 0
            for batch in _rows(source, table, batch_size):
                if not batch:
                    continue
                tx.execute(columns.insert(), batch)
                count += len(batch)
                if on_progress is not None:
                    on_progress(table, count)
            written[table] = count

            # RESTART IDENTITY put the sequence back to 1, and these rows were
            # inserted with their ids spelled out, so the sequence now hands out
            # ids that already exist. The next INSERT on the target would fail on
            # the primary key — which, on a database only the dashboard reads,
            # would not surface until someone pointed the ingest server at it.
            tx.execute(
                text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                    f"GREATEST((SELECT COALESCE(MAX(id), 0) FROM {table}), 1))"
                )
            )

    log.info("mirrored %s", ", ".join(f"{table}={n}" for table, n in written.items()))
    return written


def reseed_watermark(target: Engine) -> dict[str, int] | None:
    """Point the target's notifier at the end of what was just mirrored.

    Without this the watermark still holds ids from the target's own, now
    deleted, id space. Those ids are meaningless against the mirrored rows: too
    low and the next notifier run announces thousands of listings that have been
    known for weeks, too high and it silently skips real changes.

    Reseeding to the current maximums is the same posture
    ``migrations/005_notify_watermark.sql`` takes on a fresh database, and for
    the same reason — what was just copied is history, not news.

    Args:
        target: Database that was mirrored into.

    Returns:
        The seeded ids, or None when the target has no ``notify_watermark``
        table (a database the dashboard has never migrated).
    """
    with target.begin() as tx:
        exists = tx.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'notify_watermark'"
            )
        ).first()
        if exists is None:
            return None

        row = tx.execute(
            text(
                """
                INSERT INTO notify_watermark
                    (id, last_snapshot_id, last_product_id, last_store_id, updated_at)
                VALUES (1,
                        COALESCE((SELECT max(id) FROM price_snapshots), 0),
                        COALESCE((SELECT max(id) FROM products), 0),
                        COALESCE((SELECT max(id) FROM stores), 0),
                        now())
                ON CONFLICT (id) DO UPDATE SET
                    last_snapshot_id = EXCLUDED.last_snapshot_id,
                    last_product_id  = EXCLUDED.last_product_id,
                    last_store_id    = EXCLUDED.last_store_id,
                    updated_at       = EXCLUDED.updated_at
                RETURNING last_snapshot_id, last_product_id, last_store_id
                """
            )
        ).one()

    return {
        "last_snapshot_id": row[0],
        "last_product_id": row[1],
        "last_store_id": row[2],
    }
