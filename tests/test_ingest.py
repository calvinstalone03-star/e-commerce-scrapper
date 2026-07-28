"""Tests for the browser-extension ingest endpoint.

The interesting properties are not "does FastAPI work" but: does it refuse
unauthenticated writes into the user's database, does it drop payloads it should
not store, and does it reuse the scraper's own parser rather than growing a
second one that drifts.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from scraper.config import Settings
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
