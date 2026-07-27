"""Tests for :mod:`scraper.runner` — orchestration only, no network, no browser.

Two layers, deliberately:

* **Fake layer** (always runs). A :class:`FakeAdapter` stands in for the network
  and a :class:`FakeDatabase` stands in for ``scraper.db`` + ``scraper.store``.
  The fake database implements real transaction semantics — writes go to a
  working copy that is discarded on exception and swapped in on clean exit — so
  "target 2 rolled back but targets 1 and 3 committed" is genuinely exercised
  rather than assumed.
* **Postgres layer** (runs when available). The same three behaviours re-checked
  against the real repository and a real database, so the fake cannot quietly
  drift from ``store.py``. Skipped when Postgres is unreachable or when
  ``db.py`` / ``store.py`` / ``models.py`` are still scaffold stubs.

The Postgres layer never truncates a table. It confines itself to ids at or
above :data:`TEST_ID_BASE` and to targets prefixed ``pytest-runner-``, and
deletes only those, so it is safe to run beside anything else using the same
test database.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from scraper import runner as runner_mod
from scraper.adapters import ScrapedItem
from scraper.models import (
    Marketplace,
    PriceSnapshot,
    Product,
    RunMode,
    RunStatus,
    ScrapeRun,
    Store,
)
from scraper.runner import RunSummary, ScrapeRunner

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

#: Postgres-layer rows use ids at or above this so they can be deleted precisely
#: without touching anything another test (or another agent) put in the same DB.
TEST_ID_BASE = 990_000_000

#: Prefix for ``scrape_runs.target`` values written by the Postgres layer.
TARGET_PREFIX = "pytest-runner-"

DEFAULT_TEST_DATABASE_URL = "postgresql://calvin@127.0.0.1:5432/ecom_scraper_test"


# --------------------------------------------------------------------------
# Fixtures / helpers shared by both layers
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Give the runner a deterministic, monotonically increasing UTC clock.

    ``models.utcnow`` may still be a scaffold stub while sibling agents work, and
    a fixed clock also makes ``first_seen``/``last_seen``/``scraped_at`` ordering
    assertions exact.
    """
    start = datetime(2026, 7, 27, 12, 0, 0, tzinfo=UTC)
    counter = {"n": 0}

    def _tick() -> datetime:
        counter["n"] += 1
        return start + timedelta(seconds=counter["n"])

    monkeypatch.setattr(runner_mod, "utcnow", _tick)


def make_item(
    *,
    shop_id: int,
    item_id: int,
    price: int,
    username: str = "erigostore",
    thin: bool = True,
    name: str | None = None,
) -> ScrapedItem:
    """Build one ScrapedItem triple the way an adapter would.

    Args:
        shop_id: Marketplace shop id.
        item_id: Marketplace item id.
        price: Price in whole rupiah.
        username: Shop slug carried on the Store.
        thin: When True the Store carries identity only, which is what a keyword
            search payload yields and what makes the runner consider enriching it
            via ``adapter.get_shop``.
        name: Product name. Defaults to a name derived from ``item_id``.

    Returns:
        A ScrapedItem with all timestamps left None, per the adapter contract.
    """
    store = Store(marketplace=Marketplace.SHOPEE, shop_id=shop_id, username=username)
    if not thin:
        store = store.model_copy(
            update={
                "name": f"Shop {shop_id}",
                "location": "KAB. TANGERANG",
                "follower_count": 1234,
                "rating_star": Decimal("4.8"),
            }
        )
    product = Product(
        marketplace=Marketplace.SHOPEE,
        item_id=item_id,
        shop_id=shop_id,
        name=name or f"Produk {item_id}",
        url=f"https://shopee.co.id/product/{shop_id}/{item_id}",
    )
    snapshot = PriceSnapshot(
        item_id=item_id,
        price=Decimal(price),
        sold=12,
        historical_sold=500,
        rating_star=Decimal("4.7"),
        rating_count=99,
        stock=7,
    )
    return ScrapedItem(store=store, product=product, snapshot=snapshot)


class FakeAdapter:
    """A :class:`~scraper.adapters.MarketplaceAdapter` that never touches a network.

    Records every call so tests can assert on request counts — notably that
    ``get_shop`` runs at most once per shop id per invocation.
    """

    marketplace: Marketplace = Marketplace.SHOPEE

    def __init__(
        self,
        items_by_target: dict[str, list[ScrapedItem]] | None = None,
        *,
        raise_for: dict[str, BaseException] | None = None,
        missing_shops: set[str] | None = None,
    ) -> None:
        """Configure the canned responses.

        Args:
            items_by_target: Target -> items to return. Unknown targets return [].
            raise_for: Target -> exception to raise instead of returning items.
            missing_shops: Usernames for which ``get_shop`` raises LookupError.
        """
        self.items_by_target = items_by_target or {}
        self.raise_for = raise_for or {}
        self.missing_shops = missing_shops or set()
        self.keyword_calls: list[tuple[str, int]] = []
        self.shop_calls: list[tuple[str, int]] = []
        self.get_shop_calls: list[str] = []
        self.closed = False

    def _resolve(self, target: str) -> list[ScrapedItem]:
        """Return canned items for ``target``, or raise its canned exception."""
        if target in self.raise_for:
            raise self.raise_for[target]
        return list(self.items_by_target.get(target, []))

    def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]:
        """Canned keyword search."""
        if pages < 1:
            raise ValueError("pages must be >= 1")
        self.keyword_calls.append((keyword, pages))
        return self._resolve(keyword)

    def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]:
        """Canned shop listing."""
        if pages < 1:
            raise ValueError("pages must be >= 1")
        self.shop_calls.append((username, pages))
        return self._resolve(username)

    def get_shop(self, username: str) -> Store:
        """Canned username -> Store resolution, counted."""
        self.get_shop_calls.append(username)
        if username in self.missing_shops:
            raise LookupError(f"no such shop: {username}")
        return Store(
            marketplace=Marketplace.SHOPEE,
            shop_id=SHOP_IDS_BY_USERNAME[username],
            username=username,
            name=f"{username} Official Shop",
            location="KAB. TANGERANG",
            follower_count=7_590_364,
            rating_star=Decimal("4.844464"),
        )

    def close(self) -> None:
        """Mark the adapter closed."""
        self.closed = True


#: Usernames the FakeAdapter knows how to resolve.
SHOP_IDS_BY_USERNAME = {"erigostore": 30_203_584, "eigerindostore": 100_1, "othershop": 777}


# --------------------------------------------------------------------------
# Fake database: real transaction semantics, no Postgres
# --------------------------------------------------------------------------


@dataclass
class _FakeState:
    """The whole fake database, cheap enough to copy per transaction."""

    stores: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    products: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    snapshots: list[dict[str, Any]] = field(default_factory=list)
    runs: dict[int, dict[str, Any]] = field(default_factory=dict)
    sequences: dict[str, int] = field(
        default_factory=lambda: {"store": 0, "product": 0, "snapshot": 0, "run": 0}
    )

    def copy(self) -> "_FakeState":
        """Return an independent copy, so a rollback can simply discard it."""
        return _FakeState(
            stores={k: dict(v) for k, v in self.stores.items()},
            products={k: dict(v) for k, v in self.products.items()},
            snapshots=[dict(row) for row in self.snapshots],
            runs={k: dict(v) for k, v in self.runs.items()},
            sequences=dict(self.sequences),
        )

    def next_id(self, kind: str) -> int:
        """Hand out the next serial id for ``kind``."""
        self.sequences[kind] += 1
        return self.sequences[kind]


class _FakeSession:
    """Stand-in for a SQLAlchemy Session; just carries the working state."""

    def __init__(self, state: _FakeState) -> None:
        """Bind the session to the transaction's working state."""
        self.state = state

    def flush(self) -> None:
        """No-op; the fake assigns ids eagerly."""


class FakeDatabase:
    """In-memory replacement for ``scraper.db`` + ``scraper.store``.

    Mirrors the repository contract that matters to the runner: upserts keyed on
    the marketplace natural keys, never overwriting a stored non-null with NULL,
    append-only snapshots, and a ``scrape_runs`` row per target. Commits swap the
    working copy in; an exception discards it.
    """

    def __init__(self) -> None:
        """Start empty with all call counters at zero."""
        self.committed = _FakeState()
        self.upsert_store_calls: list[int] = []
        self.upsert_product_calls: list[int] = []
        self.insert_snapshot_calls: list[int] = []
        self.commits = 0
        self.rollbacks = 0

    # -- transaction boundary ---------------------------------------------

    @contextmanager
    def session_scope(self, database_url: str | None = None) -> Any:
        """Yield a session over a working copy; commit on success, discard on error."""
        working = self.committed.copy()
        session = _FakeSession(working)
        try:
            yield session
        except BaseException:
            self.rollbacks += 1
            raise
        else:
            self.committed = working
            self.commits += 1

    # -- repository functions ---------------------------------------------

    def upsert_store(self, session: Any, store: Store, *, now: datetime | None = None) -> int:
        """Insert or update a shop keyed on ``(marketplace, shop_id)``."""
        self.upsert_store_calls.append(store.shop_id)
        state: _FakeState = session.state
        key = (store.marketplace.value, store.shop_id)
        row = state.stores.get(key)
        if row is None:
            row = {"id": state.next_id("store"), "first_seen": now, "shop_id": store.shop_id}
            state.stores[key] = row
        incoming = store.model_dump(exclude={"first_seen", "last_seen"})
        for name, value in incoming.items():
            if value is not None or row.get(name) is None:
                row[name] = value
        row["last_seen"] = now
        return int(row["id"])

    def upsert_product(
        self, session: Any, product: Product, shop_ref: int | None, *, now: datetime | None = None
    ) -> int:
        """Insert or update a listing keyed on ``(marketplace, item_id)``."""
        self.upsert_product_calls.append(product.item_id)
        state: _FakeState = session.state
        key = (product.marketplace.value, product.item_id)
        row = state.products.get(key)
        if row is None:
            row = {"id": state.next_id("product"), "first_seen": now, "item_id": product.item_id}
            state.products[key] = row
        incoming = product.model_dump(exclude={"first_seen", "last_seen", "shop_id"})
        for name, value in incoming.items():
            if value is not None or row.get(name) is None:
                row[name] = value
        if shop_ref is not None or row.get("shop_ref") is None:
            row["shop_ref"] = shop_ref
        row["last_seen"] = now
        return int(row["id"])

    def insert_snapshot(
        self,
        session: Any,
        snapshot: PriceSnapshot,
        product_ref: int,
        *,
        now: datetime | None = None,
    ) -> int:
        """Append one observation. Raises for the poison item id, to test rollback."""
        self.insert_snapshot_calls.append(snapshot.item_id)
        if snapshot.item_id == POISON_ITEM_ID:
            raise RuntimeError(f"simulated write failure for item {snapshot.item_id}")
        state: _FakeState = session.state
        row = snapshot.model_dump(exclude={"item_id"})
        row["id"] = state.next_id("snapshot")
        row["product_ref"] = product_ref
        row["scraped_at"] = snapshot.scraped_at or now
        state.snapshots.append(row)
        return int(row["id"])

    def start_run(
        self,
        session: Any,
        marketplace: Marketplace,
        mode: RunMode,
        target: str,
        *,
        now: datetime | None = None,
    ) -> ScrapeRun:
        """Open a RUNNING audit row and hand back a model carrying its id."""
        state: _FakeState = session.state
        run_id = state.next_id("run")
        row = {
            "id": run_id,
            "marketplace": marketplace.value,
            "mode": mode.value,
            "target": target,
            "started_at": now,
            "finished_at": None,
            "status": RunStatus.RUNNING.value,
            "item_count": 0,
            "error": None,
        }
        state.runs[run_id] = row
        return ScrapeRun(
            id=run_id,
            marketplace=marketplace,
            mode=mode,
            target=target,
            started_at=now,
            status=RunStatus.RUNNING,
        )

    def finish_run(
        self,
        session: Any,
        run: ScrapeRun,
        *,
        status: RunStatus,
        item_count: int,
        error: str | None = None,
        now: datetime | None = None,
    ) -> ScrapeRun:
        """Close the audit row opened by :meth:`start_run`."""
        if run.id is None:
            raise ValueError("finish_run needs a run created by start_run")
        state: _FakeState = session.state
        row = state.runs[run.id]
        row.update(
            status=status.value, item_count=item_count, error=error, finished_at=now
        )
        return run.model_copy(
            update={
                "status": status,
                "item_count": item_count,
                "error": error,
                "finished_at": now,
            }
        )

    # -- assertions helpers ------------------------------------------------

    def snapshots_for(self, item_id: int) -> list[dict[str, Any]]:
        """Every committed snapshot belonging to ``item_id``."""
        key = (Marketplace.SHOPEE.value, item_id)
        product = self.committed.products.get(key)
        if product is None:
            return []
        return [s for s in self.committed.snapshots if s["product_ref"] == product["id"]]

    def committed_item_ids(self) -> set[int]:
        """Item ids of every committed product."""
        return {item_id for _, item_id in self.committed.products}

    def runs_by_target(self) -> dict[str, dict[str, Any]]:
        """Committed ``scrape_runs`` rows keyed by target."""
        return {row["target"]: row for row in self.committed.runs.values()}


#: Snapshot inserts for this item id blow up, which is how the fake simulates a
#: mid-target write failure and lets us prove the rollback is real.
POISON_ITEM_ID = 66_666


@pytest.fixture()
def fake_db(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    """Swap ``scraper.db.session_scope`` and every ``scraper.store`` write for the fake."""
    fake = FakeDatabase()
    monkeypatch.setattr(runner_mod.db, "session_scope", fake.session_scope)
    for name in (
        "upsert_store",
        "upsert_product",
        "insert_snapshot",
        "start_run",
        "finish_run",
    ):
        monkeypatch.setattr(runner_mod.store_repo, name, getattr(fake, name))
    return fake


def build_runner(adapter: FakeAdapter, **kwargs: Any) -> ScrapeRunner:
    """Construct a quiet ScrapeRunner around ``adapter``."""
    kwargs.setdefault("quiet", True)
    kwargs.setdefault("database_url", "postgresql://fake/fake")
    return ScrapeRunner(adapter=adapter, **kwargs)


# --------------------------------------------------------------------------
# Fake layer: per-target isolation
# --------------------------------------------------------------------------


def test_failing_target_does_not_abort_the_others(fake_db: FakeDatabase) -> None:
    """Target 2 blows up mid-write; targets 1 and 3 still commit."""
    adapter = FakeAdapter(
        {
            "kw-one": [make_item(shop_id=101, item_id=1001, price=10_000, username="othershop")],
            # kw-two persists one good item, then hits the poison item and dies.
            "kw-two": [
                make_item(shop_id=102, item_id=1002, price=20_000, username="othershop"),
                make_item(shop_id=102, item_id=POISON_ITEM_ID, price=30_000, username="othershop"),
            ],
            "kw-three": [make_item(shop_id=103, item_id=1003, price=40_000, username="othershop")],
        }
    )
    runner = build_runner(adapter, enrich_shops=False)

    summary = runner.run_keywords(["kw-one", "kw-two", "kw-three"])

    assert isinstance(summary, RunSummary)
    assert (summary.targets, summary.ok, summary.failed) == (3, 2, 1)
    assert summary.total_items == 2
    assert summary.success is False
    assert summary.elapsed >= 0.0

    assert summary.result is not None
    assert summary.result.failed_targets == ["kw-two"]
    assert summary.result.ok is False
    assert summary.result.status is RunStatus.PARTIAL

    # Targets 1 and 3 committed; every write from target 2 rolled back — including
    # item 1002, which had already been inserted when the poison item failed.
    assert fake_db.committed_item_ids() == {1001, 1003}
    assert fake_db.snapshots_for(1002) == []
    assert fake_db.rollbacks == 1

    # All three targets still produced an audit row, and target 2's carries the error.
    runs = fake_db.runs_by_target()
    assert set(runs) == {"kw-one", "kw-two", "kw-three"}
    assert runs["kw-one"]["status"] == RunStatus.SUCCESS.value
    assert runs["kw-three"]["status"] == RunStatus.SUCCESS.value
    assert runs["kw-two"]["status"] == RunStatus.FAILED.value
    assert runs["kw-two"]["item_count"] == 0
    assert "simulated write failure" in runs["kw-two"]["error"]

    # And the adapter was asked for all three targets — the loop never short-circuited.
    assert [call[0] for call in adapter.keyword_calls] == ["kw-one", "kw-two", "kw-three"]


def test_adapter_exception_is_isolated_to_its_target(fake_db: FakeDatabase) -> None:
    """A network-side failure (LookupError from the adapter) fails only that target."""
    adapter = FakeAdapter(
        {
            "shop-a": [make_item(shop_id=201, item_id=2001, price=15_000, thin=False)],
            "shop-c": [make_item(shop_id=203, item_id=2003, price=25_000, thin=False)],
        },
        raise_for={"shop-b": LookupError("shop does not exist")},
    )
    runner = build_runner(adapter)

    summary = runner.run_stores(["shop-a", "shop-b", "shop-c"])

    assert (summary.targets, summary.ok, summary.failed) == (3, 2, 1)
    assert summary.total_items == 2
    assert fake_db.committed_item_ids() == {2001, 2003}
    runs = fake_db.runs_by_target()
    assert runs["shop-b"]["status"] == RunStatus.FAILED.value
    assert "LookupError" in runs["shop-b"]["error"]


def test_every_target_failing_reports_status_failed(fake_db: FakeDatabase) -> None:
    """When nothing succeeds the aggregate status is FAILED, not PARTIAL."""
    adapter = FakeAdapter(raise_for={"a": RuntimeError("boom"), "b": RuntimeError("boom")})
    summary = build_runner(adapter).run_keywords(["a", "b"])

    assert (summary.ok, summary.failed) == (0, 2)
    assert summary.result is not None
    assert summary.result.status is RunStatus.FAILED


# --------------------------------------------------------------------------
# Fake layer: shop caching
# --------------------------------------------------------------------------


def test_repeated_shop_id_resolves_and_upserts_once(fake_db: FakeDatabase) -> None:
    """One shop seen across three targets costs exactly one get_shop and one upsert."""
    shop_id = SHOP_IDS_BY_USERNAME["erigostore"]
    adapter = FakeAdapter(
        {
            "kw-a": [
                make_item(shop_id=shop_id, item_id=3001, price=10_000),
                make_item(shop_id=shop_id, item_id=3002, price=11_000),
            ],
            "kw-b": [make_item(shop_id=shop_id, item_id=3003, price=12_000)],
            "kw-c": [make_item(shop_id=shop_id, item_id=3004, price=13_000)],
        }
    )
    runner = build_runner(adapter)

    summary = runner.run_keywords(["kw-a", "kw-b", "kw-c"])

    assert summary.failed == 0
    assert summary.total_items == 4

    # The whole point: four items across three targets, one shop resolution.
    assert adapter.get_shop_calls == ["erigostore"]
    assert fake_db.upsert_store_calls == [shop_id]
    assert len(fake_db.committed.stores) == 1

    # The enrichment actually landed — the thin Store was replaced by the rich one.
    (store_row,) = fake_db.committed.stores.values()
    assert store_row["name"] == "erigostore Official Shop"
    assert store_row["location"] == "KAB. TANGERANG"
    assert store_row["follower_count"] == 7_590_364

    # Every product points at that single store row.
    refs = {row["shop_ref"] for row in fake_db.committed.products.values()}
    assert refs == {store_row["id"]}


def test_distinct_shops_are_each_resolved_once(fake_db: FakeDatabase) -> None:
    """Caching is per shop id, not a blanket 'only ever call get_shop once'."""
    adapter = FakeAdapter(
        {
            "kw": [
                make_item(shop_id=SHOP_IDS_BY_USERNAME["erigostore"], item_id=4001,
                          price=10_000, username="erigostore"),
                make_item(shop_id=SHOP_IDS_BY_USERNAME["othershop"], item_id=4002,
                          price=11_000, username="othershop"),
                make_item(shop_id=SHOP_IDS_BY_USERNAME["erigostore"], item_id=4003,
                          price=12_000, username="erigostore"),
            ]
        }
    )
    build_runner(adapter).run_keywords(["kw"])

    assert sorted(adapter.get_shop_calls) == ["erigostore", "othershop"]
    assert len(fake_db.committed.stores) == 2


def test_rich_store_is_not_enriched(fake_db: FakeDatabase) -> None:
    """Store mode already yields a full Store, so no get_shop request is spent."""
    adapter = FakeAdapter(
        {"erigostore": [make_item(shop_id=30_203_584, item_id=5001, price=9_000, thin=False)]}
    )
    build_runner(adapter).run_stores(["erigostore"])

    assert adapter.get_shop_calls == []
    assert fake_db.upsert_store_calls == [30_203_584]


def test_failed_enrichment_still_persists_the_thin_store(fake_db: FakeDatabase) -> None:
    """A LookupError from get_shop degrades to the thin Store; it never fails the target."""
    adapter = FakeAdapter(
        {"kw": [make_item(shop_id=SHOP_IDS_BY_USERNAME["othershop"], item_id=6001,
                          price=8_000, username="othershop")]},
        missing_shops={"othershop"},
    )
    summary = build_runner(adapter).run_keywords(["kw"])

    assert summary.failed == 0
    assert summary.total_items == 1
    assert adapter.get_shop_calls == ["othershop"]
    (store_row,) = fake_db.committed.stores.values()
    assert store_row["username"] == "othershop"
    assert store_row["name"] is None


def test_synthetic_username_is_never_sent_to_get_shop(fake_db: FakeDatabase) -> None:
    """An adapter's own placeholder slug must not cost a doomed shop request.

    Keyword-search payloads carry no shop slug, so adapters invent one and
    publish ``is_placeholder_username`` to say so. The runner honours that
    predicate rather than hardcoding any adapter's placeholder format.
    """

    class PlaceholderAdapter(FakeAdapter):
        """FakeAdapter that labels ``shop-<id>`` usernames as its own invention."""

        @staticmethod
        def is_placeholder_username(username: str | None) -> bool:
            """Whether ``username`` was invented rather than scraped."""
            return bool(username) and str(username).startswith("shop-")

    adapter = PlaceholderAdapter(
        {"kw": [make_item(shop_id=555, item_id=6201, price=7_000, username="shop-555")]}
    )
    summary = build_runner(adapter).run_keywords(["kw"])

    assert summary.failed == 0
    assert adapter.get_shop_calls == [], "no request may be spent on a synthetic slug"
    (store_row,) = fake_db.committed.stores.values()
    assert store_row["username"] == "shop-555"


def test_enrichment_that_resolves_to_a_different_shop_is_discarded(
    fake_db: FakeDatabase,
) -> None:
    """A slug that resolves to another shop must not rewrite this shop's identity."""
    wrong_id = 424_242  # not the id FakeAdapter.get_shop returns for 'erigostore'
    adapter = FakeAdapter(
        {"kw": [make_item(shop_id=wrong_id, item_id=6101, price=7_000, username="erigostore")]}
    )
    summary = build_runner(adapter).run_keywords(["kw"])

    assert summary.failed == 0
    assert adapter.get_shop_calls == ["erigostore"]
    (store_row,) = fake_db.committed.stores.values()
    assert store_row["shop_id"] == wrong_id, "identity comes from the item payload"
    assert store_row["name"] is None, "the other shop's detail must not be copied over"


def test_rolled_back_target_does_not_poison_the_shop_cache(fake_db: FakeDatabase) -> None:
    """A stores.id minted inside a rolled-back transaction is never reused."""
    shop_id = SHOP_IDS_BY_USERNAME["erigostore"]
    adapter = FakeAdapter(
        {
            # This target dies after upserting the shop, so its stores.id vanishes.
            "kw-bad": [make_item(shop_id=shop_id, item_id=POISON_ITEM_ID, price=10_000)],
            "kw-good": [make_item(shop_id=shop_id, item_id=7001, price=11_000)],
        }
    )
    build_runner(adapter).run_keywords(["kw-bad", "kw-good"])

    assert fake_db.committed_item_ids() == {7001}
    # The good target re-upserted the shop rather than trusting the discarded ref.
    assert fake_db.upsert_store_calls == [shop_id, shop_id]
    (store_row,) = fake_db.committed.stores.values()
    product = fake_db.committed.products[(Marketplace.SHOPEE.value, 7001)]
    assert product["shop_ref"] == store_row["id"]


# --------------------------------------------------------------------------
# Fake layer: snapshots accumulate
# --------------------------------------------------------------------------


def test_snapshots_accumulate_across_runs(fake_db: FakeDatabase) -> None:
    """Two runs of the same product append two snapshots and update one product row."""
    shop_id = SHOP_IDS_BY_USERNAME["erigostore"]
    adapter = FakeAdapter({"kw": [make_item(shop_id=shop_id, item_id=8001, price=150_000)]})
    runner = build_runner(adapter)

    first = runner.run_keywords(["kw"])
    assert first.total_items == 1
    assert len(fake_db.snapshots_for(8001)) == 1

    # Same listing, new price — exactly the price-movement case the schema exists for.
    adapter.items_by_target["kw"] = [make_item(shop_id=shop_id, item_id=8001, price=129_000)]
    second = runner.run_keywords(["kw"])
    assert second.total_items == 1

    snapshots = sorted(fake_db.snapshots_for(8001), key=lambda row: row["scraped_at"])
    assert len(snapshots) == 2
    assert [row["price"] for row in snapshots] == [Decimal(150_000), Decimal(129_000)]
    assert snapshots[0]["scraped_at"] < snapshots[1]["scraped_at"]

    # One product row, one store row, two audit rows.
    assert len(fake_db.committed.products) == 1
    assert len(fake_db.committed.stores) == 1
    assert len(fake_db.committed.runs) == 2

    # The cache is per invocation, so the second run re-upserted (refreshing last_seen)
    # rather than skipping the shop entirely.
    assert fake_db.upsert_store_calls == [shop_id, shop_id]


# --------------------------------------------------------------------------
# Fake layer: plumbing
# --------------------------------------------------------------------------


def test_run_targets_dedupes_and_validates() -> None:
    """Repeated targets are collapsed; empty lists and pages < 1 are errors."""
    adapter = FakeAdapter()
    runner = build_runner(adapter)

    with pytest.raises(ValueError):
        runner.run_targets(RunMode.KEYWORD, [], pages=1)
    with pytest.raises(ValueError):
        runner.run_targets(RunMode.KEYWORD, ["a"], pages=0)


def test_run_targets_scrapes_each_unique_target_once(fake_db: FakeDatabase) -> None:
    """A duplicated keyword is scraped once, not twice."""
    adapter = FakeAdapter({"kw": [make_item(shop_id=1, item_id=9001, price=1_000, thin=False)]})
    summary = build_runner(adapter).run_keywords(["kw", "kw", " kw "])

    assert summary.targets == 1
    assert [call[0] for call in adapter.keyword_calls] == ["kw"]


def test_pages_are_forwarded_to_the_adapter(fake_db: FakeDatabase) -> None:
    """``pages`` reaches the adapter untouched for both modes."""
    adapter = FakeAdapter({"kw": [], "erigostore": []})
    runner = build_runner(adapter)
    runner.run_keywords(["kw"], pages=3)
    runner.run_stores(["erigostore"], pages=5)

    assert adapter.keyword_calls == [("kw", 3)]
    assert adapter.shop_calls == [("erigostore", 5)]


def test_close_releases_only_an_owned_adapter() -> None:
    """An injected adapter belongs to the caller and must not be closed for them."""
    adapter = FakeAdapter()
    with build_runner(adapter):
        pass
    assert adapter.closed is False


def test_module_level_run_target_returns_a_closed_run(fake_db: FakeDatabase) -> None:
    """The scaffolded free function still works and never raises on target failure."""
    adapter = FakeAdapter(
        {"kw": [make_item(shop_id=11, item_id=9101, price=5_000, thin=False)]},
        raise_for={"bad": RuntimeError("nope")},
    )

    good = runner_mod.run_target(adapter, RunMode.KEYWORD, "kw", database_url="postgresql://x/y")
    assert good.status is RunStatus.SUCCESS
    assert good.item_count == 1

    bad = runner_mod.run_target(adapter, RunMode.KEYWORD, "bad", database_url="postgresql://x/y")
    assert bad.status is RunStatus.FAILED
    assert "nope" in (bad.error or "")

    with pytest.raises(ValueError):
        runner_mod.run_target(adapter, RunMode.KEYWORD, "kw", pages=0)


def test_module_level_run_aggregates(fake_db: FakeDatabase, tmp_path: Any) -> None:
    """``runner.run`` resolves targets from a file and returns the aggregate RunResult."""
    keywords_file = tmp_path / "keywords.txt"
    keywords_file.write_text(
        "# a comment\n\nkw-one\nkw-two\nkw-one\n", encoding="utf-8"
    )
    adapter = FakeAdapter(
        {
            "kw-one": [make_item(shop_id=21, item_id=9201, price=1_000, thin=False)],
            "kw-two": [make_item(shop_id=22, item_id=9202, price=2_000, thin=False)],
        }
    )

    result = runner_mod.run(
        RunMode.KEYWORD, keywords_file=keywords_file, pages=1, adapter=adapter
    )

    assert result.targets == ["kw-one", "kw-two"]
    assert result.item_count == 2
    assert result.ok is True
    assert len(result.runs) == 2
    assert result.elapsed >= 0.0


def test_module_level_run_rejects_bad_pages(fake_db: FakeDatabase) -> None:
    """``pages`` below 1 is a usage error, raised before anything is scraped."""
    with pytest.raises(ValueError):
        runner_mod.run(RunMode.KEYWORD, inline=["kw"], pages=0, adapter=FakeAdapter())


# --------------------------------------------------------------------------
# CLI exit codes (the runner's contract with the shell)
# --------------------------------------------------------------------------


def test_cli_run_exits_0_when_every_target_succeeds(
    fake_db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A clean run must exit 0 so cron does not page anyone."""
    from typer.testing import CliRunner

    from scraper import cli

    adapter = FakeAdapter({"kw": [make_item(shop_id=31, item_id=9301, price=1_000, thin=False)]})
    monkeypatch.setattr(runner_mod, "get_adapter", lambda marketplace, **kwargs: adapter)

    result = CliRunner().invoke(cli.app, ["run", "--mode", "keyword", "--keyword", "kw"])
    assert result.exit_code == 0, result.output
    assert "1/1 targets ok" in result.output


def test_cli_run_exits_1_on_partial_failure(
    fake_db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Some targets failing is exit 1 — distinct from a usage error's exit 2."""
    from typer.testing import CliRunner

    from scraper import cli

    adapter = FakeAdapter(
        {"good": [make_item(shop_id=32, item_id=9302, price=1_000, thin=False)]},
        raise_for={"bad": RuntimeError("blocked")},
    )
    monkeypatch.setattr(runner_mod, "get_adapter", lambda marketplace, **kwargs: adapter)

    result = CliRunner().invoke(
        cli.app, ["run", "--mode", "keyword", "--keyword", "good", "--keyword", "bad"]
    )
    assert result.exit_code == 1, result.output
    assert "failed targets" in result.output


def test_cli_run_exits_2_on_a_missing_target_file() -> None:
    """A usage/configuration error is exit 2, and says which file is missing."""
    from typer.testing import CliRunner

    from scraper import cli

    result = CliRunner().invoke(
        cli.app, ["run", "--mode", "keyword", "--keywords-file", "/nope/missing.txt"]
    )
    assert result.exit_code == 2, result.output
    assert "missing.txt" in result.output


# --------------------------------------------------------------------------
# Postgres layer
# --------------------------------------------------------------------------


def _pg_url() -> str:
    """The database URL the Postgres layer uses."""
    return os.environ.get("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


def _pg_ready() -> tuple[bool, str]:
    """Whether a real Postgres round-trip through db.py + store.py is possible.

    Returns:
        ``(ready, reason)`` — ``reason`` explains the skip when not ready.
    """
    try:
        from scraper import db, models, store as store_repo
    except Exception as exc:  # noqa: BLE001
        return False, f"scraper.db/store not importable: {exc!r}"

    try:
        models.utcnow()
    except NotImplementedError:
        return False, "models.utcnow is still a scaffold stub"
    except Exception as exc:  # noqa: BLE001
        return False, f"models.utcnow unusable: {exc!r}"

    url = _pg_url()
    try:
        db.init_db(url)
        with db.session_scope(url) as session:
            store_repo.get_stats(session)
    except NotImplementedError:
        return False, "db.py / store.py are still scaffold stubs"
    except Exception as exc:  # noqa: BLE001
        return False, f"Postgres at {url} unusable: {exc!r}"
    return True, ""


_PG_READY, _PG_SKIP_REASON = _pg_ready()
requires_postgres = pytest.mark.skipif(not _PG_READY, reason=_PG_SKIP_REASON or "postgres ready")


@pytest.fixture()
def pg_url() -> Any:
    """Yield the test database URL, deleting this module's own rows either side."""
    from scraper import db

    url = _pg_url()

    def _cleanup() -> None:
        from sqlalchemy import delete, select

        with db.session_scope(url) as session:
            product_ids = list(
                session.execute(
                    select(db.ProductRow.id).where(db.ProductRow.item_id >= TEST_ID_BASE)
                ).scalars()
            )
            if product_ids:
                session.execute(
                    delete(db.PriceSnapshotRow).where(
                        db.PriceSnapshotRow.product_ref.in_(product_ids)
                    )
                )
            session.execute(delete(db.ProductRow).where(db.ProductRow.item_id >= TEST_ID_BASE))
            session.execute(delete(db.StoreRow).where(db.StoreRow.shop_id >= TEST_ID_BASE))
            session.execute(
                delete(db.ScrapeRunRow).where(db.ScrapeRunRow.target.like(f"{TARGET_PREFIX}%"))
            )

    _cleanup()
    try:
        yield url
    finally:
        _cleanup()


@requires_postgres
def test_pg_target_isolation_and_shop_cache(
    pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-target rollback and one-resolution-per-shop, verified against real Postgres.

    Target two writes one item successfully and then hits a failing
    ``insert_snapshot``; nothing from that target may survive, while targets one
    and three must be committed and visible.
    """
    from sqlalchemy import select

    from scraper import db

    shop_id = TEST_ID_BASE + 1
    keep_a, keep_b = TEST_ID_BASE + 11, TEST_ID_BASE + 12
    doomed_ok, doomed_bad = TEST_ID_BASE + 21, TEST_ID_BASE + 22
    targets = [f"{TARGET_PREFIX}one", f"{TARGET_PREFIX}two", f"{TARGET_PREFIX}three"]

    def item(item_id: int, price: int) -> ScrapedItem:
        return make_item(
            shop_id=shop_id, item_id=item_id, price=price, username="erigostore"
        )

    adapter = FakeAdapter(
        {
            targets[0]: [item(keep_a, 150_000)],
            targets[1]: [item(doomed_ok, 20_000), item(doomed_bad, 25_000)],
            targets[2]: [item(keep_b, 30_000)],
        }
    )

    real_insert = runner_mod.store_repo.insert_snapshot

    def failing_insert(
        session: Any, snapshot: PriceSnapshot, product_ref: int, **kwargs: Any
    ) -> int:
        """Blow up on one specific item, mid-target, after a sibling already wrote."""
        if snapshot.item_id == doomed_bad:
            raise RuntimeError("simulated mid-target write failure")
        return real_insert(session, snapshot, product_ref, **kwargs)

    monkeypatch.setattr(runner_mod.store_repo, "insert_snapshot", failing_insert)

    summary = ScrapeRunner(adapter=adapter, quiet=True, database_url=pg_url).run_keywords(
        targets
    )

    assert (summary.targets, summary.ok, summary.failed) == (3, 2, 1)
    assert summary.total_items == 2

    with db.session_scope(pg_url) as session:
        persisted = set(
            session.execute(
                select(db.ProductRow.item_id).where(db.ProductRow.item_id >= TEST_ID_BASE)
            ).scalars()
        )
        assert persisted == {keep_a, keep_b}, "the failing target must have rolled back"

        shop_rows = list(
            session.execute(
                select(db.StoreRow).where(db.StoreRow.shop_id >= TEST_ID_BASE)
            ).scalars()
        )
        assert len(shop_rows) == 1
        assert shop_rows[0].username == "erigostore"
        assert adapter.get_shop_calls == ["erigostore"], "one shop, one resolution"

        statuses = dict(
            session.execute(
                select(db.ScrapeRunRow.target, db.ScrapeRunRow.status).where(
                    db.ScrapeRunRow.target.like(f"{TARGET_PREFIX}%")
                )
            ).all()
        )
        assert statuses[targets[0]] == RunStatus.SUCCESS.value
        assert statuses[targets[1]] == RunStatus.FAILED.value
        assert statuses[targets[2]] == RunStatus.SUCCESS.value


@requires_postgres
def test_pg_snapshots_accumulate_across_runs(pg_url: str) -> None:
    """Two invocations over the same listing leave two snapshots and one product row."""
    from sqlalchemy import func, select

    from scraper import db

    shop_id = TEST_ID_BASE + 2
    item_id = TEST_ID_BASE + 31
    target = f"{TARGET_PREFIX}accumulate"

    adapter = FakeAdapter(
        {target: [make_item(shop_id=shop_id, item_id=item_id, price=150_000,
                            username="erigostore")]}
    )
    ScrapeRunner(adapter=adapter, quiet=True, database_url=pg_url).run_keywords([target])

    adapter.items_by_target[target] = [
        make_item(shop_id=shop_id, item_id=item_id, price=129_000, username="erigostore")
    ]
    ScrapeRunner(adapter=adapter, quiet=True, database_url=pg_url).run_keywords([target])

    with db.session_scope(pg_url) as session:
        product_id = session.execute(
            select(db.ProductRow.id).where(db.ProductRow.item_id == item_id)
        ).scalar_one()
        prices = list(
            session.execute(
                select(db.PriceSnapshotRow.price)
                .where(db.PriceSnapshotRow.product_ref == product_id)
                .order_by(db.PriceSnapshotRow.scraped_at)
            ).scalars()
        )
        assert len(prices) == 2, "snapshots must accumulate, never be overwritten"
        assert [int(price) for price in prices] == [150_000, 129_000]

        product_count = session.execute(
            select(func.count())
            .select_from(db.ProductRow)
            .where(db.ProductRow.item_id == item_id)
        ).scalar_one()
        assert product_count == 1
