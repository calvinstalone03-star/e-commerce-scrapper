"""Persistence-layer tests, run against a real local PostgreSQL database.

These deliberately do **not** use SQLite or a mock. Everything interesting in
``scraper/store.py`` is Postgres-specific — ``INSERT ... ON CONFLICT ON CONSTRAINT
... DO UPDATE``, ``COALESCE`` in the DO UPDATE SET, ``DISTINCT ON``, ``timestamptz``
and ``numeric`` round-tripping. A portable-SQL substitute would test none of it.

Target database: ``ecom_scraper_test`` on the local cluster. Create it with::

    createdb -h 127.0.0.1 -p 5432 -U calvin ecom_scraper_test

Override the URL with ``ECOM_SCRAPER_TEST_DATABASE_URL`` if your cluster differs.
Every test starts from a dropped-and-recreated schema, so ordering never matters
and a failed test cannot poison its successors.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError

from scraper.db import (
    Base,
    PriceSnapshotRow,
    ProductRow,
    ScrapeRunRow,
    StoreRow,
    _has_ddl,
    _normalise_url,
    get_engine,
    get_sessionmaker,
    init_db,
    run_migrations,
    session_scope,
)
from scraper.models import (
    Marketplace,
    PriceSnapshot,
    Product,
    RunMode,
    RunStatus,
    Store,
)
from scraper.store import (
    finish_run,
    get_stats,
    insert_snapshot,
    latest_prices,
    price_history,
    recent_price_changes,
    recent_runs,
    start_run,
    upsert_product,
    upsert_store,
)

TEST_DATABASE_URL = os.environ.get(
    "ECOM_SCRAPER_TEST_DATABASE_URL",
    "postgresql://calvin@127.0.0.1:5432/ecom_scraper_test",
)

# Fixed clock values. Every test stamps timestamps explicitly rather than relying
# on models.utcnow(), which keeps assertions exact and keeps this suite
# independent of a module another agent owns.
T0 = datetime(2026, 7, 27, 9, 0, 0, tzinfo=timezone.utc)
T1 = T0 + timedelta(hours=1)
T2 = T0 + timedelta(hours=2)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def engine():
    """Engine bound to the scratch test database; skips the suite if unreachable."""
    eng = get_engine(TEST_DATABASE_URL)
    try:
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(
            f"Cannot reach the test database at {TEST_DATABASE_URL!r} ({exc.__class__.__name__}). "
            "Create it with: createdb -h 127.0.0.1 -p 5432 -U calvin ecom_scraper_test"
        )
    return eng


@pytest.fixture()
def session(engine):
    """A clean schema and an open Session for one test.

    Drops and recreates all four tables before every test so each one sees an
    empty database. The session is rolled back on teardown — the tests commit
    explicitly when they mean to.
    """
    Base.metadata.drop_all(engine)
    init_db(TEST_DATABASE_URL)

    sess = get_sessionmaker(TEST_DATABASE_URL)()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------


def rows_of(session, entity):
    """Re-read every row of ``entity`` straight from Postgres.

    ``expire_all()`` is load-bearing, not defensive. store.py writes through Core
    ``INSERT ... ON CONFLICT``, which updates the database but leaves SQLAlchemy's
    identity map alone. An ORM instance loaded *before* an upsert therefore keeps
    reporting its pre-upsert attribute values, and a plain ``select(Entity)``
    returns that stale instance rather than re-reading. Expiring first forces a
    real SELECT, so these assertions describe the database and not the cache.
    """
    session.expire_all()
    return session.execute(select(entity)).scalars().all()


def row_of(session, entity):
    """Re-read the single expected row of ``entity``; fails if there is not exactly one."""
    found = rows_of(session, entity)
    assert len(found) == 1, f"expected exactly 1 {entity.__name__} row, found {len(found)}"
    return found[0]


# ---------------------------------------------------------------------------
# Builders — small helpers so each test states only what it varies
# ---------------------------------------------------------------------------


def make_store(**overrides) -> Store:
    """Build a Store with realistic Shopee-shaped defaults (values from live recon)."""
    data = {
        "marketplace": Marketplace.SHOPEE,
        "shop_id": 30203584,
        "username": "erigostore",
        "name": "ERIGO Official Shop",
        "location": "KAB. TANGERANG",
        "follower_count": 7590364,
        "rating_star": Decimal("4.844464"),
    }
    data.update(overrides)
    return Store(**data)


def make_product(**overrides) -> Product:
    """Build a Product with realistic Shopee-shaped defaults."""
    data = {
        "marketplace": Marketplace.SHOPEE,
        "item_id": 2698631224,
        "shop_id": 30203584,
        "name": "Erigo Chino Pants Sirius Black - Celana Panjang Chino Unisex",
        "url": "https://shopee.co.id/product/30203584/2698631224",
        "image": "https://down-id.img.susercontent.com/file/id-11134201-7rbkc-m7umx9q1utm11c",
        "category": "Celana",
    }
    data.update(overrides)
    return Product(**data)


def make_snapshot(**overrides) -> PriceSnapshot:
    """Build a PriceSnapshot in whole rupiah (the adapter has already divided by 100000)."""
    data = {
        "item_id": 2698631224,
        "price": Decimal("152900"),
        "price_min": Decimal("152900"),
        "price_max": Decimal("199000"),
        "stock": 1,
        "sold": 612,
        "historical_sold": 500000,
        "rating_star": Decimal("4.9"),
        "rating_count": 325363,
        "scraped_at": T0,
    }
    data.update(overrides)
    return PriceSnapshot(**data)


# ---------------------------------------------------------------------------
# Schema / migration
# ---------------------------------------------------------------------------


def test_normalise_url_rewrites_to_psycopg3_driver():
    """A bare or legacy Postgres prefix is rewritten; explicit drivers are left alone."""
    assert _normalise_url("postgresql://u@h/db") == "postgresql+psycopg://u@h/db"
    assert _normalise_url("postgres://u@h/db") == "postgresql+psycopg://u@h/db"
    # Already explicit — must not be double-rewritten.
    assert _normalise_url("postgresql+psycopg://u@h/db") == "postgresql+psycopg://u@h/db"
    assert _normalise_url("postgresql+asyncpg://u@h/db") == "postgresql+asyncpg://u@h/db"
    # Non-Postgres URLs pass through untouched.
    assert _normalise_url("sqlite:///x.db") == "sqlite:///x.db"


def test_engine_is_cached_per_url(engine):
    """Repeated calls reuse one Engine, so a long run cannot leak connection pools."""
    assert get_engine(TEST_DATABASE_URL) is engine
    assert get_sessionmaker(TEST_DATABASE_URL) is get_sessionmaker(TEST_DATABASE_URL)


def test_init_db_applies_the_sql_migration_and_is_idempotent(engine):
    """init_db runs 001_init.sql (not the create_all fallback) and survives a re-run."""
    Base.metadata.drop_all(engine)

    applied = run_migrations(engine)
    assert applied == ["001_init.sql"], (
        "run_migrations should report the real DDL file as applied; got %r" % (applied,)
    )

    # Idempotency is the recovery path — there is no applied-migrations ledger.
    assert run_migrations(engine) == ["001_init.sql"]
    init_db(TEST_DATABASE_URL)

    with engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
            )
        }
    assert {"stores", "products", "price_snapshots", "scrape_runs"} <= tables


def test_has_ddl_distinguishes_real_sql_from_a_comments_only_placeholder():
    """The switch init_db uses to choose between the migration and create_all."""
    assert _has_ddl("CREATE TABLE x (id serial);")
    assert _has_ddl("-- leading comment\nCREATE TABLE x (id serial);")
    assert not _has_ddl("")
    assert not _has_ddl("\n   \n")
    # The state 001_init.sql shipped in: comments only, no statements.
    assert not _has_ddl("-- PLACEHOLDER.\n-- The db agent owns this file.\n\n")


def test_init_db_falls_back_to_create_all_when_no_migration_has_ddl(engine, tmp_path, monkeypatch):
    """With no real DDL on disk, init_db still produces a usable schema.

    Reproduces the pre-DDL scaffold state: chdir into a tree whose ``migrations/``
    holds only a comments-only placeholder, and point ``_PROJECT_ROOT`` there too
    so neither branch of ``_resolve_migrations_dir`` can find the real file.
    """
    Base.metadata.drop_all(engine)
    (tmp_path / "migrations").mkdir()
    (tmp_path / "migrations" / "001_init.sql").write_text("-- PLACEHOLDER, no DDL yet\n")
    monkeypatch.setattr("scraper.db._PROJECT_ROOT", tmp_path)
    monkeypatch.chdir(tmp_path)

    assert run_migrations(engine) == [], "a comments-only file must not count as applied"
    init_db(TEST_DATABASE_URL)

    with engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
            )
        }
    assert {"stores", "products", "price_snapshots", "scrape_runs"} <= tables


def test_named_constraints_and_index_exist(session, engine):
    """The ON CONFLICT targets and the time-series index exist under their fixed names.

    store.py names these constraints in its ``ON CONFLICT ON CONSTRAINT`` clauses,
    so a rename breaks the upserts at runtime rather than at import time.
    """
    with engine.connect() as conn:
        constraints = {
            row[0]
            for row in conn.execute(
                text("SELECT conname FROM pg_constraint WHERE conname LIKE 'uq_%'")
            )
        }
        indexdef = conn.execute(
            text(
                "SELECT indexdef FROM pg_indexes "
                "WHERE indexname = 'ix_price_snapshots_product_ref_scraped_at'"
            )
        ).scalar_one()

    assert "uq_stores_marketplace_shop_id" in constraints
    assert "uq_products_marketplace_item_id" in constraints
    # The DESC matters: it is what lets DISTINCT ON / ORDER BY scraped_at DESC
    # walk the index directly.
    assert "product_ref" in indexdef and "scraped_at DESC" in indexdef


# ---------------------------------------------------------------------------
# upsert_store
# ---------------------------------------------------------------------------


def test_upsert_store_is_idempotent_and_advances_last_seen(session):
    """Same shop twice -> one row, same id, last_seen advances, first_seen frozen."""
    first_id = upsert_store(session, make_store(), now=T0)
    second_id = upsert_store(session, make_store(), now=T1)

    assert first_id == second_id

    rows = session.execute(select(StoreRow)).scalars().all()
    assert len(rows) == 1, "a second upsert of the same (marketplace, shop_id) must not insert"

    row = rows[0]
    assert row.first_seen == T0, "first_seen must survive the conflict path untouched"
    assert row.last_seen == T1, "last_seen must be refreshed on every observation"
    assert row.shop_id == 30203584
    assert row.username == "erigostore"
    assert row.rating_star == Decimal("4.844464")


def test_upsert_store_does_not_clobber_stored_values_with_null(session):
    """A sparse payload must not erase detail captured by a richer earlier scrape."""
    upsert_store(session, make_store(), now=T0)

    # Simulates a listing-tier payload: shop identity only, no descriptive fields.
    sparse = make_store(name=None, location=None, follower_count=None, rating_star=None)
    upsert_store(session, sparse, now=T1)

    row = row_of(session, StoreRow)
    assert row.name == "ERIGO Official Shop"
    assert row.location == "KAB. TANGERANG"
    assert row.follower_count == 7590364
    assert row.rating_star == Decimal("4.844464")
    assert row.last_seen == T1, "last_seen still advances even when nothing else changed"


def test_upsert_store_applies_non_null_updates(session):
    """A non-null incoming value does replace the stored one — COALESCE only guards NULL."""
    upsert_store(session, make_store(), now=T0)
    upsert_store(session, make_store(name="ERIGO Official Store", follower_count=8000000), now=T1)

    row = row_of(session, StoreRow)
    assert row.name == "ERIGO Official Store"
    assert row.follower_count == 8000000
    assert row.location == "KAB. TANGERANG", "untouched columns keep their value"


def test_upsert_store_keeps_a_real_slug_against_a_synthetic_one(session):
    """A placeholder username must never displace a real one. Regression.

    ``stores.username`` is NOT NULL, so an adapter with no slug in the payload
    has to invent one (``shop-30203584``). That is a non-null string, so the
    plain ``COALESCE(excluded, stored)`` rule happily picked it — meaning the
    first keyword-mode hit for a shop overwrote the real slug a store-mode scrape
    had captured, and ``latest_prices()`` then reported ``shop-30203584`` as the
    seller of every one of that shop's products. Required output field #1,
    corrupted by a routine second scrape.
    """
    upsert_store(session, make_store(username="erigostore"), now=T0)

    upsert_store(
        session,
        make_store(username="shop-30203584", name=None, location=None,
                   follower_count=None, rating_star=None),
        now=T1,
        username_is_synthetic=True,
    )

    row = row_of(session, StoreRow)
    assert row.username == "erigostore", "the stored real slug wins over a placeholder"
    assert row.last_seen == T1, "the row is still touched — only username is protected"


def test_upsert_store_accepts_a_synthetic_username_for_a_brand_new_shop(session):
    """With nothing stored, the placeholder is better than failing a NOT NULL column."""
    upsert_store(
        session,
        make_store(username="shop-30203584"),
        now=T0,
        username_is_synthetic=True,
    )

    assert row_of(session, StoreRow).username == "shop-30203584"


def test_upsert_store_real_slug_still_overwrites_a_stored_placeholder(session):
    """The guard is one-directional: a real slug must still upgrade a placeholder."""
    upsert_store(
        session, make_store(username="shop-30203584"), now=T0, username_is_synthetic=True
    )
    upsert_store(session, make_store(username="erigostore"), now=T1)

    assert row_of(session, StoreRow).username == "erigostore"


def test_upsert_store_separates_marketplaces(session):
    """Natural key is (marketplace, shop_id): one shop_id on two marketplaces is two rows."""
    shopee_id = upsert_store(session, make_store(marketplace=Marketplace.SHOPEE), now=T0)
    toko_id = upsert_store(session, make_store(marketplace=Marketplace.TOKOPEDIA), now=T0)

    assert shopee_id != toko_id
    assert len(rows_of(session, StoreRow)) == 2


# ---------------------------------------------------------------------------
# upsert_product
# ---------------------------------------------------------------------------


def test_upsert_product_is_idempotent_and_advances_last_seen(session):
    """Same listing twice -> one row, same id, first_seen frozen, last_seen advanced."""
    shop_ref = upsert_store(session, make_store(), now=T0)

    first_id = upsert_product(session, make_product(), shop_ref, now=T0)
    second_id = upsert_product(session, make_product(), shop_ref, now=T1)

    assert first_id == second_id
    row = row_of(session, ProductRow)
    assert row.first_seen == T0
    assert row.last_seen == T1
    assert row.shop_ref == shop_ref
    assert row.item_id == 2698631224


def test_upsert_product_stores_shop_ref_not_marketplace_shop_id(session):
    """products.shop_ref is OUR stores.id, never the marketplace's shop_id."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    upsert_product(session, make_product(), shop_ref, now=T0)

    row = row_of(session, ProductRow)
    assert row.shop_ref == shop_ref
    assert row.shop_ref != 30203584, "the marketplace shop_id must not leak into shop_ref"
    assert not hasattr(row, "shop_id"), "products has no shop_id column by design"


def test_upsert_product_backfills_a_null_shop_ref(session):
    """A keyword scrape can insert with shop_ref=None; a later store scrape fills it in."""
    product_id = upsert_product(session, make_product(), None, now=T0)
    row = row_of(session, ProductRow)
    assert row.shop_ref is None

    shop_ref = upsert_store(session, make_store(), now=T1)
    assert upsert_product(session, make_product(), shop_ref, now=T1) == product_id

    row = row_of(session, ProductRow)
    assert row.shop_ref == shop_ref, "a resolved shop must backfill onto the existing row"


def test_upsert_product_does_not_clobber_shop_ref_or_detail_with_null(session):
    """A later sparse scrape must not undo an already-resolved shop_ref or wipe detail."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    upsert_product(session, make_product(), shop_ref, now=T0)

    # image/category are genuinely optional on the model, so this really is the
    # sparse-payload shape. (url is not usable here: Product._fill_url derives a
    # Shopee URL from the ids, so a Shopee product can never reach the DB with
    # url=None — see the Tokopedia test below for the url guard.)
    sparse = make_product(image=None, category=None)
    upsert_product(session, sparse, None, now=T1)

    row = row_of(session, ProductRow)
    assert row.shop_ref == shop_ref, "shop_ref must not regress to NULL"
    assert row.image is not None, "an earlier image must not be erased"
    assert row.category == "Celana"
    assert row.last_seen == T1


def test_upsert_product_does_not_clobber_url_with_null(session):
    """The url COALESCE guard, exercised on Tokopedia where url really can be None.

    ``Product._fill_url`` only auto-derives a URL for Shopee — Tokopedia URLs are
    slug-addressed and need a shop username the model does not carry. So a
    Tokopedia product built without a url reaches the repository with url=None,
    which is exactly the case the COALESCE has to survive.
    """
    rich = Product(
        marketplace=Marketplace.TOKOPEDIA,
        item_id=777,
        shop_id=555,
        name="Kaos Polos Cotton Combed 30s",
        url="https://www.tokopedia.com/tokolain/kaos-polos-cotton-combed-30s",
    )
    sparse = Product(
        marketplace=Marketplace.TOKOPEDIA,
        item_id=777,
        shop_id=555,
        name="Kaos Polos Cotton Combed 30s",
    )
    assert sparse.url is None, "precondition: Tokopedia products are not auto-urled"

    upsert_product(session, rich, None, now=T0)
    upsert_product(session, sparse, None, now=T1)

    row = row_of(session, ProductRow)
    assert row.url == "https://www.tokopedia.com/tokolain/kaos-polos-cotton-combed-30s"


# ---------------------------------------------------------------------------
# insert_snapshot
# ---------------------------------------------------------------------------


def test_insert_snapshot_appends_rather_than_upserts(session):
    """Two scrapes of one product produce two rows — this table is the time series."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)

    id_a = insert_snapshot(session, make_snapshot(scraped_at=T0), product_ref)
    id_b = insert_snapshot(
        session, make_snapshot(price=Decimal("149000"), sold=700, scraped_at=T1), product_ref
    )

    assert id_a != id_b
    session.expire_all()
    rows = session.execute(
        select(PriceSnapshotRow).order_by(PriceSnapshotRow.scraped_at)
    ).scalars().all()
    assert len(rows) == 2, "insert_snapshot must never collapse observations"
    assert [r.price for r in rows] == [Decimal("152900"), Decimal("149000")]
    assert [r.product_ref for r in rows] == [product_ref, product_ref]


def test_insert_snapshot_round_trips_decimals_and_nulls(session):
    """Money/rating come back as Decimal (never float) and optional fields stay None."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)

    insert_snapshot(
        session,
        make_snapshot(price=Decimal("152900.50"), stock=None, historical_sold=None),
        product_ref,
    )

    row = row_of(session, PriceSnapshotRow)
    assert isinstance(row.price, Decimal)
    assert row.price == Decimal("152900.50")
    assert isinstance(row.rating_star, Decimal)
    assert row.stock is None
    assert row.historical_sold is None


def test_insert_snapshot_defaults_scraped_at_from_now(session):
    """When the adapter leaves scraped_at unset, the repository stamps it."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)

    insert_snapshot(session, make_snapshot(scraped_at=None), product_ref, now=T2)

    row = row_of(session, PriceSnapshotRow)
    assert row.scraped_at == T2


# ---------------------------------------------------------------------------
# scrape_runs
# ---------------------------------------------------------------------------


def test_start_run_flushes_an_id_before_scraping(session):
    """start_run must flush so a crashed process still leaves a RUNNING row behind."""
    run = start_run(session, Marketplace.SHOPEE, RunMode.STORE, "erigostore", now=T0)

    assert run.id is not None
    assert run.status is RunStatus.RUNNING
    assert run.started_at == T0

    row = row_of(session, ScrapeRunRow)
    assert row.id == run.id
    assert row.status == "running"
    assert row.mode == "store"
    assert row.marketplace == "shopee"
    assert row.target == "erigostore"
    assert row.finished_at is None


def test_finish_run_closes_the_row(session):
    """finish_run writes the terminal state to the DB and mirrors it onto the model."""
    run = start_run(session, Marketplace.SHOPEE, RunMode.KEYWORD, "kaos polos", now=T0)
    returned = finish_run(session, run, status=RunStatus.SUCCESS, item_count=42, now=T1)

    assert returned is run
    assert run.status is RunStatus.SUCCESS
    assert run.item_count == 42
    assert run.finished_at == T1

    row = row_of(session, ScrapeRunRow)
    assert row.status == "success"
    assert row.item_count == 42
    assert row.finished_at == T1
    assert row.error is None
    assert len(rows_of(session, ScrapeRunRow)) == 1


def test_finish_run_truncates_a_huge_error(session):
    """A megabyte-long traceback must not be written verbatim into the audit log."""
    run = start_run(session, Marketplace.SHOPEE, RunMode.KEYWORD, "kaos polos", now=T0)
    finish_run(
        session, run, status=RunStatus.FAILED, item_count=0, error="x" * 50_000, now=T1
    )

    row = row_of(session, ScrapeRunRow)
    assert row.status == "failed"
    assert len(row.error) == 4000


def test_finish_run_rejects_a_run_without_an_id(session):
    """Calling finish_run without start_run is a programming error, not a silent no-op."""
    from scraper.models import ScrapeRun

    orphan = ScrapeRun(marketplace=Marketplace.SHOPEE, mode=RunMode.STORE, target="erigostore")
    with pytest.raises(ValueError):
        finish_run(session, orphan, status=RunStatus.SUCCESS, item_count=0, now=T1)


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------


def _seed_two_products_with_history(session):
    """Seed 2 shops / 2 products / 3 snapshots. Returns the two shop refs."""
    erigo_ref = upsert_store(session, make_store(), now=T0)
    other_ref = upsert_store(
        session,
        make_store(shop_id=99999, username="tokolain", name="Toko Lain", location="JAKARTA BARAT"),
        now=T0,
    )

    p1 = upsert_product(session, make_product(), erigo_ref, now=T0)
    p2 = upsert_product(
        session,
        make_product(item_id=111222333, shop_id=99999, name="Kaos Polos Cotton Combed 30s"),
        other_ref,
        now=T0,
    )

    # p1 gets two observations, so "latest" has something to choose between.
    insert_snapshot(session, make_snapshot(price=Decimal("152900"), sold=612, scraped_at=T0), p1)
    insert_snapshot(session, make_snapshot(price=Decimal("139000"), sold=700, scraped_at=T2), p1)
    insert_snapshot(
        session,
        make_snapshot(item_id=111222333, price=Decimal("45000"), sold=12000, scraped_at=T1),
        p2,
    )
    return erigo_ref, other_ref


def test_latest_prices_returns_one_row_per_product_newest_first(session):
    """The dashboard view: exactly the most recent snapshot per product, joined to its shop."""
    _seed_two_products_with_history(session)

    rows = latest_prices(session, Marketplace.SHOPEE)
    assert len(rows) == 2, "one row per product, not one per snapshot"

    by_item = {row["item_id"]: row for row in rows}

    erigo = by_item[2698631224]
    assert erigo["price"] == Decimal("139000"), "must be the T2 snapshot, not the T0 one"
    assert erigo["sold"] == 700
    assert erigo["scraped_at"] == T2
    # The five required output fields.
    assert erigo["shop_username"] == "erigostore"
    assert erigo["name"].startswith("Erigo Chino Pants")
    assert erigo["rating_star"] == Decimal("4.9")
    assert erigo["shop_name"] == "ERIGO Official Shop"
    assert erigo["location"] == "KAB. TANGERANG"
    assert erigo["shop_id"] == 30203584

    assert by_item[111222333]["price"] == Decimal("45000")
    assert by_item[111222333]["shop_username"] == "tokolain"

    # Ordered newest-first.
    assert [r["scraped_at"] for r in rows] == [T2, T1]


def test_latest_prices_includes_products_without_a_resolved_shop(session):
    """An unresolved shop_ref must not drop the product from the dashboard (outer join)."""
    product_ref = upsert_product(session, make_product(), None, now=T0)
    insert_snapshot(session, make_snapshot(scraped_at=T0), product_ref)

    rows = latest_prices(session)
    assert len(rows) == 1
    assert rows[0]["shop_username"] is None
    assert rows[0]["shop_id"] is None
    assert rows[0]["price"] == Decimal("152900")


def test_latest_prices_filters_by_marketplace_and_honours_limit(session):
    """Marketplace scoping and the row cap both work."""
    _seed_two_products_with_history(session)

    toko_ref = upsert_store(
        session, make_store(marketplace=Marketplace.TOKOPEDIA, shop_id=555, username="tp"), now=T0
    )
    toko_product = upsert_product(
        session,
        make_product(marketplace=Marketplace.TOKOPEDIA, item_id=777, shop_id=555),
        toko_ref,
        now=T0,
    )
    insert_snapshot(session, make_snapshot(item_id=777, scraped_at=T0), toko_product)

    assert len(latest_prices(session)) == 3
    assert len(latest_prices(session, Marketplace.SHOPEE)) == 2
    assert len(latest_prices(session, Marketplace.TOKOPEDIA)) == 1
    assert len(latest_prices(session, limit=1)) == 1


def test_latest_prices_is_empty_when_a_product_has_no_snapshot(session):
    """Products with no observation yet are not dashboard rows."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    upsert_product(session, make_product(), shop_ref, now=T0)

    assert latest_prices(session) == []


def test_price_history_returns_every_snapshot_newest_first(session):
    """The detail view: the full series for one listing, ready to diff into a price chart."""
    _seed_two_products_with_history(session)

    history = price_history(session, 2698631224)
    assert len(history) == 2, "history must include superseded observations"
    assert [row["scraped_at"] for row in history] == [T2, T0]
    assert [row["price"] for row in history] == [Decimal("139000"), Decimal("152900")]
    assert all(row["item_id"] == 2698631224 for row in history)
    assert history[0]["marketplace"] == "shopee"
    assert history[0]["name"].startswith("Erigo Chino Pants")

    # Units-sold velocity between consecutive scrapes is what the series is for.
    assert history[0]["sold"] - history[1]["sold"] == 88


def test_price_history_scopes_by_marketplace(session):
    """item_id is unique only per marketplace, so an unscoped call can span both."""
    shopee_ref = upsert_store(session, make_store(), now=T0)
    toko_ref = upsert_store(
        session, make_store(marketplace=Marketplace.TOKOPEDIA, shop_id=555, username="tp"), now=T0
    )
    # Same item_id deliberately reused across marketplaces.
    p_shopee = upsert_product(session, make_product(item_id=4242), shopee_ref, now=T0)
    p_toko = upsert_product(
        session,
        make_product(marketplace=Marketplace.TOKOPEDIA, item_id=4242, shop_id=555),
        toko_ref,
        now=T0,
    )
    insert_snapshot(session, make_snapshot(item_id=4242, scraped_at=T0), p_shopee)
    insert_snapshot(session, make_snapshot(item_id=4242, scraped_at=T1), p_toko)

    assert len(price_history(session, 4242)) == 2
    assert len(price_history(session, 4242, marketplace=Marketplace.SHOPEE)) == 1
    assert price_history(session, 4242, marketplace=Marketplace.TOKOPEDIA)[0]["marketplace"] == (
        "tokopedia"
    )
    assert len(price_history(session, 4242, limit=1)) == 1


def test_price_history_of_an_unknown_item_is_empty(session):
    """An unknown listing yields [], not an error."""
    assert price_history(session, 123456789) == []


# ---------------------------------------------------------------------------
# get_stats
# ---------------------------------------------------------------------------


def test_get_stats_counts_everything(session):
    """The stats CLI view aggregates all four tables."""
    _seed_two_products_with_history(session)
    run = start_run(session, Marketplace.SHOPEE, RunMode.STORE, "erigostore", now=T0)
    finish_run(session, run, status=RunStatus.SUCCESS, item_count=3, now=T1)
    start_run(session, Marketplace.SHOPEE, RunMode.KEYWORD, "kaos polos", now=T2)

    stats = get_stats(session)

    assert stats["stores"] == 2
    assert stats["products"] == 2
    assert stats["snapshots"] == 3
    assert stats["runs"] == 2
    assert stats["last_run_at"] == T2
    assert stats["last_snapshot_at"] == T2
    assert stats["runs_by_status"] == {"success": 1, "running": 1}


def test_get_stats_scopes_to_one_marketplace(session):
    """Passing a marketplace filters every count, including snapshots (via their product)."""
    _seed_two_products_with_history(session)

    toko_ref = upsert_store(
        session, make_store(marketplace=Marketplace.TOKOPEDIA, shop_id=555, username="tp"), now=T0
    )
    toko_product = upsert_product(
        session,
        make_product(marketplace=Marketplace.TOKOPEDIA, item_id=777, shop_id=555),
        toko_ref,
        now=T0,
    )
    insert_snapshot(session, make_snapshot(item_id=777, scraped_at=T1), toko_product)
    start_run(session, Marketplace.TOKOPEDIA, RunMode.KEYWORD, "kaos", now=T1)

    shopee = get_stats(session, marketplace=Marketplace.SHOPEE)
    assert shopee["stores"] == 2
    assert shopee["products"] == 2
    assert shopee["snapshots"] == 3
    assert shopee["runs"] == 0

    toko = get_stats(session, marketplace=Marketplace.TOKOPEDIA)
    assert toko["stores"] == 1
    assert toko["products"] == 1
    assert toko["snapshots"] == 1
    assert toko["runs"] == 1
    assert toko["last_snapshot_at"] == T1


def test_get_stats_on_an_empty_database(session):
    """Zeroes and Nones, not exceptions — this runs right after initdb."""
    stats = get_stats(session)
    assert stats["stores"] == 0
    assert stats["products"] == 0
    assert stats["snapshots"] == 0
    assert stats["runs"] == 0
    assert stats["last_run_at"] is None
    assert stats["last_snapshot_at"] is None
    assert stats["runs_by_status"] == {}


# ---------------------------------------------------------------------------
# session_scope transaction behaviour
# ---------------------------------------------------------------------------


def test_session_scope_commits_on_success(session):
    """Work inside a completed scope is durable — visible from a different session."""
    with session_scope(TEST_DATABASE_URL) as scoped:
        upsert_store(scoped, make_store(), now=T0)

    assert len(rows_of(session, StoreRow)) == 1


def test_session_scope_rolls_back_and_reraises(session):
    """A failing target must not leave half its writes behind."""
    with pytest.raises(RuntimeError, match="adapter blew up"):
        with session_scope(TEST_DATABASE_URL) as scoped:
            upsert_store(scoped, make_store(), now=T0)
            raise RuntimeError("adapter blew up")

    assert rows_of(session, StoreRow) == []


def test_full_runner_chain_end_to_end(session):
    """The exact call chain the runner uses, twice, as a second scrape of one shop would."""
    with session_scope(TEST_DATABASE_URL) as scoped:
        run = start_run(scoped, Marketplace.SHOPEE, RunMode.STORE, "erigostore", now=T0)
        shop_ref = upsert_store(scoped, make_store(), now=T0)
        product_ref = upsert_product(scoped, make_product(), shop_ref, now=T0)
        insert_snapshot(scoped, make_snapshot(scraped_at=T0), product_ref)
        finish_run(scoped, run, status=RunStatus.SUCCESS, item_count=1, now=T0)

    with session_scope(TEST_DATABASE_URL) as scoped:
        run = start_run(scoped, Marketplace.SHOPEE, RunMode.STORE, "erigostore", now=T2)
        shop_ref = upsert_store(scoped, make_store(), now=T2)
        product_ref = upsert_product(scoped, make_product(), shop_ref, now=T2)
        insert_snapshot(
            scoped, make_snapshot(price=Decimal("129000"), sold=900, scraped_at=T2), product_ref
        )
        finish_run(scoped, run, status=RunStatus.SUCCESS, item_count=1, now=T2)

    stats = get_stats(session, marketplace=Marketplace.SHOPEE)
    assert stats["stores"] == 1, "the shop is upserted, not duplicated"
    assert stats["products"] == 1, "the listing is upserted, not duplicated"
    assert stats["snapshots"] == 2, "but both observations are kept"
    assert stats["runs"] == 2

    latest = latest_prices(session, Marketplace.SHOPEE)
    assert len(latest) == 1
    assert latest[0]["price"] == Decimal("129000")
    assert len(price_history(session, 2698631224)) == 2


# ---------------------------------------------------------------------------
# scraped_at precedence — the runner's "one shared clock per target" contract
# ---------------------------------------------------------------------------


def test_insert_snapshot_now_overrides_the_models_default(session):
    """An explicit ``now`` wins over the value PriceSnapshot defaulted for itself.

    Regression test for a cross-module contract break. ``PriceSnapshot.scraped_at``
    has a ``default_factory`` of ``utcnow()``, so it is essentially never None by
    the time an adapter hands one over. Under the old fill-only semantics the
    caller's ``now`` was therefore dead code, and the runner's documented
    "one shared timestamp per target" silently did not hold — two snapshots from
    a single batch landed tens of microseconds apart.
    """
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)

    # No scraped_at override: the model stamps itself via default_factory.
    snapshot = PriceSnapshot(item_id=2698631224, price=Decimal("152900"))
    assert snapshot.scraped_at is not None, "the model is expected to self-stamp"

    insert_snapshot(session, snapshot, product_ref, now=T2)
    assert row_of(session, PriceSnapshotRow).scraped_at == T2


def test_insert_snapshot_without_now_keeps_the_snapshots_own_timestamp(session):
    """``now=None`` leaves an adapter-supplied timestamp alone (e.g. a backfill)."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)

    insert_snapshot(session, make_snapshot(scraped_at=T1), product_ref)
    assert row_of(session, PriceSnapshotRow).scraped_at == T1


def test_one_shared_now_gives_a_whole_batch_one_clock(session):
    """Every snapshot the runner writes for one target shares a single scraped_at."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    refs = [
        upsert_product(session, make_product(item_id=item_id), shop_ref, now=T0)
        for item_id in (111, 222, 333)
    ]
    for ref in refs:
        # Constructed without scraped_at, exactly as the Shopee adapter does.
        insert_snapshot(session, PriceSnapshot(item_id=1, price=Decimal("1000")), ref, now=T2)

    stamps = {row.scraped_at for row in rows_of(session, PriceSnapshotRow)}
    assert stamps == {T2}, "a batch must be diffable as a unit, not smeared over microseconds"


# ---------------------------------------------------------------------------
# recent_runs / recent_price_changes — the reads behind `ecom-scraper stats`
# ---------------------------------------------------------------------------


def test_recent_runs_returns_newest_first_and_respects_limit(session):
    """Newest first, capped by ``limit``, with the audit fields the CLI renders."""
    for index, stamp in enumerate((T0, T1, T2)):
        run = start_run(session, Marketplace.SHOPEE, RunMode.KEYWORD, f"kw{index}", now=stamp)
        finish_run(session, run, status=RunStatus.SUCCESS, item_count=index, now=stamp)

    rows = recent_runs(session)
    assert [row["target"] for row in rows] == ["kw2", "kw1", "kw0"]
    assert rows[0]["status"] == RunStatus.SUCCESS.value
    assert rows[0]["item_count"] == 2
    assert rows[0]["mode"] == RunMode.KEYWORD.value

    assert [row["target"] for row in recent_runs(session, limit=2)] == ["kw2", "kw1"]


def test_recent_runs_filters_by_marketplace(session):
    """A marketplace filter excludes the other marketplace's audit rows."""
    finish_run(
        session,
        start_run(session, Marketplace.SHOPEE, RunMode.STORE, "erigostore", now=T0),
        status=RunStatus.SUCCESS,
        item_count=1,
        now=T0,
    )
    finish_run(
        session,
        start_run(session, Marketplace.TOKOPEDIA, RunMode.STORE, "tokoshop", now=T1),
        status=RunStatus.SUCCESS,
        item_count=1,
        now=T1,
    )

    rows = recent_runs(session, marketplace=Marketplace.SHOPEE)
    assert [row["target"] for row in rows] == ["erigostore"]


def test_recent_price_changes_reports_only_actual_movements(session):
    """Consecutive snapshots are diffed; an unchanged price is not a change."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)

    insert_snapshot(session, make_snapshot(price=Decimal("152900")), product_ref, now=T0)
    insert_snapshot(session, make_snapshot(price=Decimal("152900")), product_ref, now=T1)
    insert_snapshot(session, make_snapshot(price=Decimal("129000")), product_ref, now=T2)

    rows = recent_price_changes(session)
    assert len(rows) == 1, "the T1 repeat of the same price is not a movement"
    assert rows[0]["previous_price"] == Decimal("152900")
    assert rows[0]["price"] == Decimal("129000")
    assert rows[0]["scraped_at"] == T2
    assert rows[0]["username"] == "erigostore"
    assert rows[0]["product_name"] == make_product().name


def test_recent_price_changes_ignores_a_first_ever_snapshot(session):
    """"Price became known" is not a price change and must not fabricate a delta."""
    shop_ref = upsert_store(session, make_store(), now=T0)
    product_ref = upsert_product(session, make_product(), shop_ref, now=T0)
    insert_snapshot(session, make_snapshot(price=Decimal("152900")), product_ref, now=T0)

    assert recent_price_changes(session) == []


def test_recent_price_changes_survives_an_unresolved_shop(session):
    """A product whose shop_ref was never resolved still reports its movement."""
    product_ref = upsert_product(session, make_product(), None, now=T0)
    insert_snapshot(session, make_snapshot(price=Decimal("100000")), product_ref, now=T0)
    insert_snapshot(session, make_snapshot(price=Decimal("90000")), product_ref, now=T2)

    rows = recent_price_changes(session)
    assert len(rows) == 1
    assert rows[0]["username"] is None, "outer join keeps the row despite a null shop_ref"
    assert rows[0]["price"] == Decimal("90000")


# ----------------------------------------------------------------------
# Snapshot deduplication
# ----------------------------------------------------------------------


class TestInsertSnapshotIfChanged:
    """Scraping the same page twice must not write two identical rows.

    The table stays append-only — that is what makes it a time series — but a
    row that repeats its predecessor verbatim is noise, not history, and it
    distorts any "how often did this change" reading of the data.
    """

    def _product(self, session) -> int:
        from scraper.store import upsert_product, upsert_store

        shop_ref = upsert_store(
            session, Store(marketplace=Marketplace.SHOPEE, shop_id=901, username="dedupeshop")
        )
        return upsert_product(
            session,
            Product(
                marketplace=Marketplace.SHOPEE, item_id=9001, shop_id=901, name="Dedupe target"
            ),
            shop_ref,
        )

    def _snapshot(self, **overrides) -> PriceSnapshot:
        values = {
            "item_id": 9001,
            "price": Decimal("55000"),
            "sold": 233,
            "rating_star": Decimal("4.82"),
        }
        values.update(overrides)
        return PriceSnapshot(**values)

    def test_identical_observation_is_skipped(self, session) -> None:
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        first = insert_snapshot_if_changed(session, self._snapshot(), product_ref, now=base)
        second = insert_snapshot_if_changed(
            session, self._snapshot(), product_ref, now=base + timedelta(minutes=5)
        )

        assert first is not None
        assert second is None, "a verbatim repeat inside the window must not be written"
        assert self._count(session, product_ref) == 1

    def test_a_price_change_is_always_written(self, session) -> None:
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(session, self._snapshot(), product_ref, now=base)
        changed = insert_snapshot_if_changed(
            session,
            self._snapshot(price=Decimal("49000")),
            product_ref,
            now=base + timedelta(minutes=1),
        )

        assert changed is not None
        assert self._count(session, product_ref) == 2

    def test_a_sold_count_change_alone_is_written(self, session) -> None:
        """Units sold moving is the velocity signal; it must never be swallowed."""
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(session, self._snapshot(), product_ref, now=base)
        changed = insert_snapshot_if_changed(
            session, self._snapshot(sold=240), product_ref, now=base + timedelta(minutes=1)
        )

        assert changed is not None

    def test_unchanged_is_written_again_past_the_window(self, session) -> None:
        """'Still 55.000 a week later' is a real fact a gap cannot express."""
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(session, self._snapshot(), product_ref, now=base)
        later = insert_snapshot_if_changed(
            session, self._snapshot(), product_ref, now=base + timedelta(hours=25)
        )

        assert later is not None
        assert self._count(session, product_ref) == 2

    def test_numeric_forms_that_differ_only_in_scale_count_as_equal(self, session) -> None:
        """A stored 55000.00 and an observed 55000 are the same observation.

        Comparing as text instead would make every scrape look like a change and
        nothing would ever deduplicate.
        """
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(
            session, self._snapshot(price=Decimal("55000.00")), product_ref, now=base
        )
        repeat = insert_snapshot_if_changed(
            session,
            self._snapshot(price=Decimal("55000")),
            product_ref,
            now=base + timedelta(minutes=1),
        )

        assert repeat is None

    def test_window_none_restores_plain_append(self, session) -> None:
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(
            session, self._snapshot(), product_ref, now=base, window_hours=None
        )
        second = insert_snapshot_if_changed(
            session,
            self._snapshot(),
            product_ref,
            now=base + timedelta(minutes=1),
            window_hours=None,
        )

        assert second is not None
        assert self._count(session, product_ref) == 2

    def test_two_different_products_do_not_deduplicate_against_each_other(
        self, session
    ) -> None:
        from scraper.store import insert_snapshot_if_changed, upsert_product, upsert_store

        first_ref = self._product(session)
        shop_ref = upsert_store(
            session, Store(marketplace=Marketplace.SHOPEE, shop_id=902, username="other")
        )
        second_ref = upsert_product(
            session,
            Product(marketplace=Marketplace.SHOPEE, item_id=9002, shop_id=902, name="Other"),
            shop_ref,
        )
        base = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)

        a = insert_snapshot_if_changed(session, self._snapshot(), first_ref, now=base)
        b = insert_snapshot_if_changed(
            session, self._snapshot(item_id=9002), second_ref, now=base
        )

        assert a is not None and b is not None

    @staticmethod
    def _count(session, product_ref: int) -> int:
        from sqlalchemy import func, select

        from scraper.db import PriceSnapshotRow

        return session.execute(
            select(func.count())
            .select_from(PriceSnapshotRow)
            .where(PriceSnapshotRow.product_ref == product_ref)
        ).scalar_one()

    def test_a_previous_row_dated_later_still_deduplicates(self, session) -> None:
        """The neighbour can carry a later timestamp than the observation.

        A backfilled capturedAt, an out-of-order replay or clock skew all produce
        that, and a forward-only age check silently disabled deduplication for
        exactly those cases — observed live, where a row stamped an hour in the
        future let three identical payloads through.
        """
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 12, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(session, self._snapshot(), product_ref, now=base)
        earlier = insert_snapshot_if_changed(
            session, self._snapshot(), product_ref, now=base - timedelta(hours=1)
        )

        assert earlier is None
        assert self._count(session, product_ref) == 1

    def test_a_far_earlier_observation_is_still_written(self, session) -> None:
        """Symmetry must not swallow a genuinely distant backfill."""
        from scraper.store import insert_snapshot_if_changed

        product_ref = self._product(session)
        base = datetime(2026, 7, 28, 12, 0, tzinfo=timezone.utc)

        insert_snapshot_if_changed(session, self._snapshot(), product_ref, now=base)
        older = insert_snapshot_if_changed(
            session, self._snapshot(), product_ref, now=base - timedelta(hours=48)
        )

        assert older is not None
