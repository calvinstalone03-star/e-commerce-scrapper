"""Tests for the local -> hosted mirror, run against two real PostgreSQL databases.

Two, because everything this module does is about the relationship between them:
ids copied verbatim, the target's own tables left alone, a truncate and a bulk
insert that have to succeed or fail together. A single database, or a mock,
tests none of that.

Target databases: ``ecom_scraper_test`` (source) and ``ecom_scraper_test_target``
(target) on the local cluster. Create them with::

    createdb -h 127.0.0.1 -p 5432 -U calvin ecom_scraper_test
    createdb -h 127.0.0.1 -p 5432 -U calvin ecom_scraper_test_target

Override either with ``ECOM_SCRAPER_TEST_DATABASE_URL`` /
``ECOM_SCRAPER_TEST_TARGET_DATABASE_URL``.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError

from scraper.db import Base, get_engine, init_db
from scraper.sync import (
    SCRAPED_TABLES,
    mirror,
    natural_keys,
    plan,
    reseed_seen,
    table_counts,
)

SOURCE_URL = os.environ.get(
    "ECOM_SCRAPER_TEST_DATABASE_URL",
    "postgresql://calvin@127.0.0.1:5432/ecom_scraper_test",
)
TARGET_URL = os.environ.get(
    "ECOM_SCRAPER_TEST_TARGET_DATABASE_URL",
    "postgresql://calvin@127.0.0.1:5432/ecom_scraper_test_target",
)

T0 = datetime(2026, 8, 1, 9, 0, 0, tzinfo=timezone.utc)


def _connect_or_skip(url: str, name: str):
    engine = get_engine(url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(
            f"Cannot reach the {name} database at {url!r} ({exc.__class__.__name__}). "
            f"Create it with: createdb -h 127.0.0.1 -p 5432 -U calvin {url.rsplit('/', 1)[-1]}"
        )
    return engine


@pytest.fixture(scope="session")
def source_engine():
    return _connect_or_skip(SOURCE_URL, "source")


@pytest.fixture(scope="session")
def target_engine():
    return _connect_or_skip(TARGET_URL, "target")


def _reset(engine, url: str) -> None:
    """Drop everything, including the tables the migrations own, and rebuild."""
    Base.metadata.drop_all(engine)
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS app_credentials, notify_seen"))
    init_db(url)


@pytest.fixture()
def databases(source_engine, target_engine):
    _reset(source_engine, SOURCE_URL)
    _reset(target_engine, TARGET_URL)
    return source_engine, target_engine


def seed(engine, *, shop_id: int = 5001, item_id: int = 7001, store_pk: int = 11,
         product_pk: int = 21, snapshot_pk: int = 31, keyword_pk: int = 41,
         price: str = "55000") -> None:
    """Write one shop, one listing, one snapshot and one keyword, at fixed ids."""
    tables = Base.metadata.tables
    with engine.begin() as conn:
        conn.execute(
            tables["stores"].insert(),
            [{"id": store_pk, "marketplace": "shopee", "shop_id": shop_id,
              "username": f"toko{shop_id}", "name": "Toko", "is_own": True,
              "first_seen": T0, "last_seen": T0}],
        )
        conn.execute(
            tables["products"].insert(),
            [{"id": product_pk, "marketplace": "shopee", "item_id": item_id,
              "shop_ref": store_pk, "name": "LEGO 8827", "set_code": "8827",
              "first_seen": T0, "last_seen": T0}],
        )
        conn.execute(
            tables["price_snapshots"].insert(),
            [{"id": snapshot_pk, "product_ref": product_pk, "price": Decimal(price),
              "sold": 12, "scraped_at": T0}],
        )
        conn.execute(
            tables["product_keywords"].insert(),
            [{"id": keyword_pk, "product_ref": product_pk, "keyword": "lego",
              "marketplace": "shopee", "first_seen": T0, "last_seen": T0}],
        )


# ----------------------------------------------------------------------
# Mirroring
# ----------------------------------------------------------------------


def test_mirror_copies_rows_with_their_ids(databases) -> None:
    """Ids are the point: notify_seen holds one across both databases."""
    source, target = databases
    seed(source)

    written = mirror(source, target)

    assert written == {
        "stores": 1, "products": 1, "product_keywords": 1,
        "price_snapshots": 1, "scrape_runs": 0,
    }
    with target.connect() as conn:
        store = conn.execute(select(Base.metadata.tables["stores"])).one()
        product = conn.execute(select(Base.metadata.tables["products"])).one()
        snapshot = conn.execute(select(Base.metadata.tables["price_snapshots"])).one()
    assert store.id == 11 and store.shop_id == 5001
    assert store.is_own is True  # own-shop is what the per-product messages need
    assert product.id == 21 and product.shop_ref == 11 and product.set_code == "8827"
    assert snapshot.id == 31 and snapshot.product_ref == 21
    assert snapshot.price == Decimal("55000")


def test_mirror_replaces_what_the_target_held(databases) -> None:
    source, target = databases
    seed(source, shop_id=5001, item_id=7001)
    seed(target, shop_id=9999, item_id=8888, store_pk=99, product_pk=98,
         snapshot_pk=97, keyword_pk=96)

    mirror(source, target)

    assert natural_keys(target, "stores") == {("shopee", 5001)}
    assert natural_keys(target, "products") == {("shopee", 7001)}


def test_mirror_leaves_the_targets_own_tables_alone(databases) -> None:
    """A deployment's login is deliberately not the laptop's."""
    source, target = databases
    seed(source)
    with target.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app_credentials (id, username, hash, salt, secret) "
                "VALUES (true, 'admin', 'not-the-laptops-hash', 'salt', 'secret') "
                "ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash"
            )
        )

    mirror(source, target)

    with target.connect() as conn:
        row = conn.execute(text("SELECT username, hash FROM app_credentials")).one()
    assert row.hash == "not-the-laptops-hash"


def test_mirror_advances_the_sequences_past_the_copied_ids(databases) -> None:
    """TRUNCATE RESTART IDENTITY leaves the sequence at 1; the ids copied do not."""
    source, target = databases
    seed(source, store_pk=11, product_pk=21)

    mirror(source, target)

    with target.begin() as conn:
        new_id = conn.execute(
            text(
                "INSERT INTO products (marketplace, item_id, shop_ref, name) "
                "VALUES ('shopee', 7777, 11, 'baru') RETURNING id"
            )
        ).scalar_one()
    assert new_id > 21


def test_a_failed_mirror_leaves_the_target_untouched(databases, monkeypatch) -> None:
    """One transaction, so a dropped link mid-copy is 'unchanged', not 'half'."""
    source, target = databases
    seed(source, shop_id=5001, item_id=7001)
    seed(target, shop_id=9999, item_id=8888, store_pk=99, product_pk=98,
         snapshot_pk=97, keyword_pk=96)

    def explode(engine, table, batch_size):
        if table == "price_snapshots":
            raise OperationalError("connection lost", None, Exception("boom"))
        yield []

    monkeypatch.setattr("scraper.sync._rows", explode)

    with pytest.raises(OperationalError):
        mirror(source, target)

    assert natural_keys(target, "stores") == {("shopee", 9999)}
    assert table_counts(target)["price_snapshots"] == 1


# ----------------------------------------------------------------------
# Planning
# ----------------------------------------------------------------------


def test_plan_counts_both_sides(databases) -> None:
    source, target = databases
    seed(source)

    result = plan(source, target)

    by_table = {diff.table: diff for diff in result.diffs}
    assert [diff.table for diff in result.diffs] == list(SCRAPED_TABLES)
    assert by_table["products"].source == 1
    assert by_table["products"].target == 0
    assert by_table["products"].delta == 1
    assert result.destroys_rows is False


def test_plan_names_rows_only_the_target_has(databases) -> None:
    """The one question counts cannot answer: a smaller target can still be unique."""
    source, target = databases
    seed(source, shop_id=5001, item_id=7001)
    seed(target, shop_id=9999, item_id=8888, store_pk=99, product_pk=98,
         snapshot_pk=97, keyword_pk=96)

    result = plan(source, target)

    assert result.destroys_rows is True
    assert result.target_only_stores == [("shopee", 9999)]
    assert result.target_only_products == [("shopee", 8888)]


def test_plan_on_an_unmigrated_target_lists_the_missing_tables(databases) -> None:
    source, target = databases
    seed(source)
    Base.metadata.drop_all(target)

    result = plan(source, target)

    assert set(result.missing_tables) == set(SCRAPED_TABLES)
    # Nothing to destroy, and asking would mean querying tables that are absent.
    assert result.destroys_rows is False


def test_table_counts_omits_tables_that_do_not_exist(databases) -> None:
    _source, target = databases
    Base.metadata.drop_all(target)

    assert table_counts(target) == {}


def test_natural_keys_refuses_a_table_without_one(databases) -> None:
    source, _target = databases

    with pytest.raises(ValueError, match="no natural key"):
        natural_keys(source, "price_snapshots")


# ----------------------------------------------------------------------
# The read marker
# ----------------------------------------------------------------------


def test_reseed_points_seen_at_what_was_mirrored(databases) -> None:
    """Otherwise the dashboard renders every mirrored listing as new."""
    source, target = databases
    seed(source, store_pk=11, product_pk=21, snapshot_pk=31)

    mirror(source, target)
    seeded = reseed_seen(target)

    assert seeded == 31


def test_reseed_overwrites_a_seen_marker_from_the_targets_old_id_space(databases) -> None:
    """A marker left from the target's own history can sit above the new max."""
    source, target = databases
    seed(source, store_pk=11, product_pk=21, snapshot_pk=31)
    with target.begin() as conn:
        conn.execute(text("UPDATE notify_seen SET last_seen_snapshot_id = 999999"))

    mirror(source, target)
    seeded = reseed_seen(target)

    assert seeded == 31


def test_reseed_reports_a_target_the_dashboard_has_never_migrated(databases) -> None:
    _source, target = databases
    with target.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS notify_seen"))

    assert reseed_seen(target) is None
