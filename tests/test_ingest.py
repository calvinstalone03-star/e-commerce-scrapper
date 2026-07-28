"""Tests for the browser-extension ingest endpoint.

The interesting properties are not "does FastAPI work" but: does it refuse
unauthenticated writes into the user's database, does it drop payloads it should
not store, and does it reuse the scraper's own parser rather than growing a
second one that drifts.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from scraper.config import Settings
from scraper.models import Marketplace
from scraper.ingest import (
    CAPTURED_PATHS,
    IngestResult,
    IngestService,
    build_app,
    is_captured,
    resolve_token,
)

SEARCH_URL = "https://shopee.co.id/api/v4/search/search_items?keyword=kaos%20polos"


def item(item_id: int = 111, shop_id: int = 222) -> dict:
    """One listing in Shopee's search shape (prices in micro-units)."""
    return {
        "itemid": item_id,
        "shopid": shop_id,
        "name": "Kaos Polos Cotton Combed 30s",
        "price": 5500000000,  # 55,000 rupiah in micro-units
        "price_min": 5500000000,
        "price_max": 7500000000,
        "sold": 233,
        "historical_sold": 233,
        "item_rating": {"rating_star": 4.82, "rating_count": [10, 0, 0, 0, 2, 8]},
        "shop_location": "KAB. TANGERANG",
        "stock": 50,
    }


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        database_url="postgresql://localhost/unused",
        cookies_path=tmp_path / "cookies.json",
    )


class RecordingService:
    """Stands in for IngestService so HTTP tests need no database."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object, datetime | None]] = []

    def ingest(self, url, payload, captured_at=None) -> IngestResult:
        self.calls.append((url, payload, captured_at))
        return IngestResult(seen=1, stored=1)


# ----------------------------------------------------------------------
# Path filtering
# ----------------------------------------------------------------------


def test_listing_paths_are_captured() -> None:
    for path in CAPTURED_PATHS:
        assert is_captured(f"https://shopee.co.id{path}?x=1"), path


def test_unrelated_paths_are_not_captured() -> None:
    """A Shopee front-end change must not be able to fill the DB with junk."""
    for url in (
        "https://shopee.co.id/api/v4/account/basic/get_account_info",
        "https://shopee.co.id/api/v4/web/subcart",
        "https://shopee.co.id/api/v4/platform/get_ft_v2",
        "https://evil.example/api/v4/search/search_items",
        "not a url at all",
    ):
        assert is_captured(url) is False, url


def test_lookalike_hosts_are_rejected() -> None:
    """Suffix matching on the raw string would accept every one of these."""
    for host in ("notshopee.co.id", "shopee.co.id.evil.example", "evil.example"):
        assert is_captured(f"https://{host}/api/v4/search/search_items") is False, host


def test_shopee_subdomains_are_accepted() -> None:
    assert is_captured("https://mall.shopee.co.id/api/v4/search/search_items") is True


# ----------------------------------------------------------------------
# Parsing + persistence (no DB: the service is exercised through its parser)
# ----------------------------------------------------------------------


def test_uncaptured_url_is_rejected_without_touching_the_database(settings) -> None:
    service = IngestService(settings, database_url="postgresql://unused/nope")

    result = service.ingest("https://shopee.co.id/api/v4/web/subcart", {"data": "OK"})

    assert result.accepted is False
    assert result.stored == 0
    assert "not captured" in (result.reason or "")


def test_payload_without_items_stores_nothing(settings) -> None:
    service = IngestService(settings, database_url="postgresql://unused/nope")

    result = service.ingest(SEARCH_URL, {"items": []})

    assert result.accepted is True
    assert result.seen == 0
    assert result.stored == 0


def test_extraction_reuses_the_scrapers_own_parser() -> None:
    """The design commitment: no second parser in JavaScript or here.

    If this ever fails because parse_item moved, the fix is to follow it, not to
    inline a copy.
    """
    from scraper.adapters.shopee import _extract_items, parse_item

    raw = _extract_items({"items": [{"item_basic": item()}]})
    assert len(raw) == 1

    parsed = parse_item(raw[0])
    assert parsed.product.item_id == 111
    assert parsed.snapshot.sold == 233
    # Micro-units divided by the web endpoint's 100000 divisor.
    assert int(parsed.snapshot.price) == 55000


# ----------------------------------------------------------------------
# HTTP surface
# ----------------------------------------------------------------------


@pytest.fixture()
def client(settings, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("INGEST_TOKEN", "test-token")
    service = RecordingService()
    app = build_app(settings, service=service)
    return TestClient(app), service


def test_health_needs_no_token(client) -> None:
    http, _service = client

    response = http.get("/health")

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_ingest_without_a_token_is_rejected(client) -> None:
    """This is an unauthenticated write path into the user's database otherwise."""
    http, service = client

    response = http.post("/ingest", json={"url": SEARCH_URL, "payload": {"items": []}})

    assert response.status_code == 401
    assert service.calls == []


def test_ingest_with_a_wrong_token_is_rejected(client) -> None:
    http, service = client

    response = http.post(
        "/ingest",
        json={"url": SEARCH_URL, "payload": {"items": []}},
        headers={"X-Ingest-Token": "not-the-token"},
    )

    assert response.status_code == 401
    assert service.calls == []


def test_ingest_with_the_right_token_reaches_the_service(client) -> None:
    http, service = client

    response = http.post(
        "/ingest",
        json={
            "url": SEARCH_URL,
            "payload": {"items": [{"item_basic": item()}]},
            "capturedAt": "2026-07-28T10:00:00Z",
        },
        headers={"X-Ingest-Token": "test-token"},
    )

    assert response.status_code == 200
    assert response.json()["stored"] == 1
    assert len(service.calls) == 1
    url, _payload, captured_at = service.calls[0]
    assert url == SEARCH_URL
    assert captured_at == datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)


def test_a_missing_url_is_a_422_not_a_crash(client) -> None:
    http, _service = client

    response = http.post(
        "/ingest", json={"payload": {}}, headers={"X-Ingest-Token": "test-token"}
    )

    assert response.status_code == 422


def test_an_unparseable_timestamp_falls_back_to_now(client) -> None:
    http, service = client

    response = http.post(
        "/ingest",
        json={"url": SEARCH_URL, "payload": {"items": []}, "capturedAt": "yesterday-ish"},
        headers={"X-Ingest-Token": "test-token"},
    )

    assert response.status_code == 200
    assert service.calls[0][2] is None  # service applies its own default


# ----------------------------------------------------------------------
# Token handling
# ----------------------------------------------------------------------


def test_env_token_wins(settings, monkeypatch) -> None:
    monkeypatch.setenv("INGEST_TOKEN", "from-env")

    assert resolve_token(settings) == "from-env"


def test_generated_token_is_cached_and_private(settings, monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("INGEST_TOKEN", raising=False)

    first = resolve_token(settings)
    second = resolve_token(settings)

    assert first == second, "a regenerated token would break the extension every restart"
    cache = tmp_path / ".ingest-token"
    assert cache.exists()
    assert oct(cache.stat().st_mode)[-3:] == "600"


# ----------------------------------------------------------------------
# Structural fallback for server-rendered payloads
# ----------------------------------------------------------------------


def test_deep_find_items_reaches_listings_buried_in_page_state() -> None:
    """Shopee renders the first page server-side; the listings sit inside an
    undocumented page-state blob whose path moves with the front end."""
    from scraper.ingest import deep_find_items

    blob = {
        "props": {
            "pageProps": {
                "initialState": {
                    "search": {"sections": [{"data": {"item": [item(1), item(2)]}}]},
                    "unrelated": {"banners": [{"id": 9, "url": "x"}]},
                }
            }
        }
    }

    found = deep_find_items(blob)

    assert sorted(entry["itemid"] for entry in found) == [1, 2]


def test_deep_find_items_deduplicates_the_same_listing() -> None:
    """Page state parks the same listing under several keys."""
    from scraper.ingest import deep_find_items

    blob = {"a": {"list": [item(7)]}, "b": {"byId": {"7": item(7)}}}

    assert len(deep_find_items(blob)) == 1


def test_deep_find_items_does_not_descend_into_a_matched_item() -> None:
    """Variation models nested inside a listing carry itemid too, and each one
    would otherwise become a phantom product row."""
    from scraper.ingest import deep_find_items

    parent = item(11)
    parent["models"] = [
        {"itemid": 11, "name": "Merah / L", "price": 1},
        {"itemid": 11, "name": "Biru / M", "price": 2},
    ]

    found = deep_find_items({"items": [parent]})

    assert len(found) == 1
    assert found[0]["name"] == "Kaos Polos Cotton Combed 30s"


def test_deep_find_items_handles_the_item_basic_wrapper() -> None:
    from scraper.ingest import deep_find_items

    found = deep_find_items({"deep": {"nest": [{"item_basic": item(5)}]}})

    assert len(found) == 1


def test_deep_find_items_ignores_structures_with_no_listings() -> None:
    from scraper.ingest import deep_find_items

    assert deep_find_items({"banners": [{"id": 1, "img": "a"}], "n": 3}) == []
    assert deep_find_items(None) == []
    assert deep_find_items("just a string") == []


def test_deep_find_items_is_bounded_on_pathological_nesting() -> None:
    """A page-state blob is deep and wide; an unbounded walk would stall."""
    from scraper.ingest import deep_find_items

    node: dict = {"leaf": item(1)}
    for _ in range(400):
        node = {"next": node}

    assert deep_find_items(node) == []  # beyond _MAX_DEPTH, returns rather than hangs


# ----------------------------------------------------------------------
# DOM path
# ----------------------------------------------------------------------


def dom_item(**overrides) -> dict:
    """One card as dom-scraper.js reports it, using strings seen on a real page."""
    entry = {
        "shopId": 30203584,
        "itemId": 111222333,
        "name": "1:8 Formula 1 Balap Blok Bangunan Mobil Sport",
        "price": 404800,
        "sold": "158",
        "ratingStar": 4.8,
        "location": "Tangerang",
        "url": "https://shopee.co.id/slug-i.30203584.111222333",
        "image": "https://cf.shopee.co.id/file/abc",
    }
    entry.update(overrides)
    return entry


def test_dom_entry_maps_all_five_required_fields() -> None:
    from scraper.ingest import _dom_entry_to_models

    store, product, snapshot = _dom_entry_to_models(dom_item())

    assert store.shop_id == 30203584
    assert product.item_id == 111222333
    assert product.name.startswith("1:8 Formula 1")
    assert snapshot.price == Decimal("404800")
    assert snapshot.sold == 158
    assert snapshot.rating_star == Decimal("4.8")


def test_dom_prices_are_whole_rupiah_not_micro_units() -> None:
    """The page renders "Rp404.800". Applying the API's 100000 divisor here
    would file it as Rp 4."""
    from scraper.ingest import _dom_entry_to_models

    _store, _product, snapshot = _dom_entry_to_models(dom_item(price=404800))

    assert snapshot.price == Decimal("404800")


@pytest.mark.parametrize(
    "text,expected",
    [
        ("158", 158),
        ("5RB+", 5000),
        ("10RB+", 10000),
        ("1,5RB", 1500),
        ("10K+", 10000),
        ("2RB+", 2000),
        (None, None),
    ],
)
def test_dom_sold_text_is_normalised_by_the_shared_parser(text, expected) -> None:
    """Every one of these spellings appears on a live Shopee results page."""
    from scraper.ingest import _dom_entry_to_models

    _store, _product, snapshot = _dom_entry_to_models(dom_item(sold=text))

    assert snapshot.sold == expected


def test_dom_entry_without_a_name_or_price_is_skipped() -> None:
    """One unreadable card must not lose the rest of the page."""
    from scraper.ingest import _dom_entry_to_models

    assert _dom_entry_to_models(dom_item(name="")) is None
    assert _dom_entry_to_models(dom_item(price=None)) is None
    assert _dom_entry_to_models({"shopId": 1}) is None
    assert _dom_entry_to_models(dom_item(price=-5)) is None


def test_dom_entry_tolerates_missing_optional_fields() -> None:
    from scraper.ingest import _dom_entry_to_models

    store, product, snapshot = _dom_entry_to_models(
        dom_item(sold=None, ratingStar=None, location=None, image=None, url=None)
    )

    assert snapshot.sold is None
    assert snapshot.rating_star is None
    assert store.location is None
    assert product.image is None


def test_dom_shop_username_is_flagged_synthetic() -> None:
    """A search card shows no shop slug, only the numeric id from the product
    URL. Storing "shop-<id>" unflagged would overwrite a real slug."""
    from scraper.ingest import _dom_entry_to_models

    store, _product, _snapshot = _dom_entry_to_models(dom_item())

    assert store.username == "shop-30203584"


def test_ingest_dom_endpoint_requires_the_token(client) -> None:
    http, _service = client

    response = http.post("/ingest-dom", json={"items": [dom_item()]})

    assert response.status_code == 401


def test_ingest_dom_rejects_a_non_list_items_field(client) -> None:
    http, _service = client

    response = http.post(
        "/ingest-dom", json={"items": "nope"}, headers={"X-Ingest-Token": "test-token"}
    )

    assert response.status_code == 422


# ----------------------------------------------------------------------
# Multi-marketplace
# ----------------------------------------------------------------------


def test_shopee_numeric_keys_pass_through_unchanged() -> None:
    """Shopee ids must stay recognisable so DOM rows match the ones the API and
    scraping paths wrote for the same listing."""
    from scraper.ingest import _dom_entry_to_models

    store, product, _snapshot = _dom_entry_to_models(
        {"shopKey": "30203584", "itemKey": "111222333", "name": "Kaos", "price": 55000},
        Marketplace.SHOPEE,
    )

    assert store.shop_id == 30203584
    assert product.item_id == 111222333


def test_tokopedia_slugs_become_stable_ids() -> None:
    """Tokopedia URLs carry no numeric id, but price history needs the same
    listing to resolve to the same id on every scrape."""
    from scraper.ingest import _dom_entry_to_models, stable_id

    entry = {
        "shopKey": "tokosaya",
        "itemKey": "tokosaya/lego-technic-42115",
        "name": "LEGO Technic 42115",
        "price": 4999000,
    }

    first = _dom_entry_to_models(entry, Marketplace.TOKOPEDIA)
    second = _dom_entry_to_models(dict(entry), Marketplace.TOKOPEDIA)

    assert first[1].item_id == second[1].item_id
    assert first[1].item_id == stable_id("tokosaya/lego-technic-42115")
    assert first[1].marketplace is Marketplace.TOKOPEDIA


def test_stable_id_survives_a_restart() -> None:
    """hash() is salted per process and would mint a fresh product row on every
    server restart, forking each listing's price history."""
    import subprocess
    import sys

    code = (
        "from scraper.ingest import stable_id; print(stable_id('tokosaya/lego-technic-42115'))"
    )
    runs = {
        subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, check=True
        ).stdout.strip()
        for _ in range(2)
    }

    assert len(runs) == 1


def test_stable_id_fits_a_signed_bigint() -> None:
    from scraper.ingest import stable_id

    for key in ("a", "tokosaya/produk", "x" * 500, "ñ-unicode-slug"):
        value = stable_id(key)
        assert 0 < value < 2**63


def test_distinct_slugs_get_distinct_ids() -> None:
    from scraper.ingest import stable_id

    keys = [f"toko{n}/produk-{n}" for n in range(2000)]
    assert len(({stable_id(key) for key in keys})) == len(keys)


def test_tokopedia_shop_slug_is_a_real_username_not_a_placeholder() -> None:
    """Shopee search cards expose no slug so they get "shop-<id>"; Tokopedia's
    URL IS the slug, and flagging it synthetic would stop it ever being stored."""
    from scraper.ingest import _dom_entry_to_models, _is_synthetic

    store, _product, _snapshot = _dom_entry_to_models(
        {"shopKey": "tokosaya", "itemKey": "tokosaya/x-y", "name": "Produk", "price": 1000},
        Marketplace.TOKOPEDIA,
    )

    assert store.username == "tokosaya"
    assert _is_synthetic(store.username, store.shop_id) is False


def test_shopee_dom_username_is_still_synthetic() -> None:
    from scraper.ingest import _dom_entry_to_models, _is_synthetic

    store, _product, _snapshot = _dom_entry_to_models(
        {"shopKey": "30203584", "itemKey": "901", "name": "Produk", "price": 1000},
        Marketplace.SHOPEE,
    )

    assert store.username == "shop-30203584"
    assert _is_synthetic(store.username, store.shop_id) is True


def test_the_same_slug_on_two_marketplaces_stays_separate() -> None:
    """(marketplace, item_id) is the natural key; a collision across sites would
    merge two unrelated products' price histories."""
    from scraper.ingest import _dom_entry_to_models

    entry = {"shopKey": "toko", "itemKey": "toko/produk", "name": "P", "price": 1}

    shopee = _dom_entry_to_models(dict(entry), Marketplace.SHOPEE)
    tokped = _dom_entry_to_models(dict(entry), Marketplace.TOKOPEDIA)

    assert shopee[1].item_id == tokped[1].item_id  # same key, same derived id
    assert shopee[1].marketplace is not tokped[1].marketplace  # but different rows


def test_legacy_numeric_field_names_still_work(client) -> None:
    """The extension used to send shopId/itemId; do not break an old build."""
    from scraper.ingest import _dom_entry_to_models

    store, product, _snapshot = _dom_entry_to_models(
        {"shopId": 42, "itemId": 99, "name": "Produk", "price": 1000}
    )

    assert (store.shop_id, product.item_id) == (42, 99)


def test_unknown_marketplace_is_rejected(client) -> None:
    http, _service = client

    response = http.post(
        "/ingest-dom",
        json={"marketplace": "bukalapak", "items": []},
        headers={"X-Ingest-Token": "test-token"},
    )

    assert response.status_code == 422


# ----------------------------------------------------------------------
# Keyword capture
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://shopee.co.id/search?keyword=kaos%20polos", "kaos polos"),
        ("https://www.tokopedia.com/search?q=lego", "lego"),
        ("https://shopee.co.id/search?keyword=lego&page=2", "lego"),
        # A shop page is not a search: record no keyword rather than invent one.
        ("https://shopee.co.id/erigostore", ""),
        ("https://www.tokopedia.com/tokosaya", ""),
        ("https://shopee.co.id/search?keyword=", ""),
        ("https://shopee.co.id/search?keyword=%20%20", ""),
        ("not a url", ""),
    ],
)
def test_keyword_is_read_from_the_page_url(url, expected) -> None:
    """The extension already sends the page URL and the term is in it, so the
    extension does not have to track what the user typed — and a search page the
    user navigated to by hand is captured just as well as one from the popup."""
    from scraper.ingest import keyword_from_url

    assert keyword_from_url(url) == expected
