"""Tests for the Shopee Affiliate Open API client and adapter.

No credentials are needed: the transport is mocked, so these run anywhere. What
they pin down is the stuff that is expensive to get wrong once real credentials
arrive — the signature covering the exact bytes sent, GraphQL's habit of
reporting failure with HTTP 200, and the field mapping onto the five outputs the
dashboard needs.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal

import httpx
import pytest

from scraper.adapters import build_shopee_adapter
from scraper.adapters.shopee_affiliate import PAGE_SIZE, ShopeeAffiliateAdapter
from scraper.affiliate_client import (
    AffiliateAuthError,
    AffiliateClient,
    AffiliateCredentials,
    AffiliateError,
    AffiliateRateLimited,
    sign_request,
)
from scraper.config import Settings
from scraper.models import Marketplace

CREDS = AffiliateCredentials(app_id="123456", app_secret="s3cr3t")


def offer(item_id: int = 111, shop_id: int = 222, **overrides) -> dict:
    """One affiliate offer node, shaped like the real payload."""
    node = {
        "itemId": item_id,
        "shopId": shop_id,
        "shopName": "ERIGO Official Shop",
        "productName": "  Erigo Chino Pants Sirius Black  ",
        "priceMin": "152900.00",
        "priceMax": "189000.00",
        "sales": 640,
        "ratingStar": "4.83",
        "imageUrl": "https://cf.shopee.co.id/file/abc",
        "productLink": "https://shopee.co.id/product/222/111",
        "shopType": [1],
    }
    node.update(overrides)
    return node


def client_returning(*payloads: dict, capture: list | None = None) -> AffiliateClient:
    """An AffiliateClient whose transport replays the given JSON payloads."""
    queue = list(payloads)

    def handler(request: httpx.Request) -> httpx.Response:
        if capture is not None:
            capture.append(request)
        body = queue.pop(0) if queue else {"data": {"productOfferV2": {"nodes": []}}}
        if isinstance(body, httpx.Response):
            return body
        return httpx.Response(200, json=body)

    return AffiliateClient(
        CREDS,
        transport=httpx.MockTransport(handler),
        min_delay=0.0,
        max_delay=0.0,
    )


# ----------------------------------------------------------------------
# Signature
# ----------------------------------------------------------------------


def test_signature_is_sha256_of_appid_timestamp_payload_secret() -> None:
    payload = '{"query":"{ping}"}'
    expected = hashlib.sha256(f"1234561700000000{payload}s3cr3t".encode()).hexdigest()

    assert sign_request("123456", "s3cr3t", payload, 1700000000) == expected


def test_signature_covers_the_exact_bytes_that_are_sent() -> None:
    """The single most expensive thing to get wrong.

    Re-serialising the body for the send would reorder keys or change separators
    and invalidate a signature computed over the first serialisation, producing
    only an opaque "Invalid Signature" from Shopee. This asserts the sent bytes
    are the signed bytes.
    """
    captured: list[httpx.Request] = []
    client = client_returning({"data": {"ok": True}}, capture=captured)

    client.execute("query Q($a: String) { f(a: $a) }", {"a": "kaos polos"})

    request = captured[0]
    sent = request.content.decode("utf-8")
    auth = request.headers["Authorization"]
    timestamp = int(auth.split("Timestamp=")[1].split(",")[0])
    signature = auth.split("Signature=")[1].strip()

    assert signature == sign_request("123456", "s3cr3t", sent, timestamp)
    assert auth.startswith("SHA256 Credential=123456,")


def test_secret_never_appears_in_the_request_or_the_repr() -> None:
    captured: list[httpx.Request] = []
    client = client_returning({"data": {"ok": True}}, capture=captured)
    client.execute("{ping}")

    raw = captured[0].content.decode() + json.dumps(dict(captured[0].headers))
    assert "s3cr3t" not in raw
    assert "s3cr3t" not in repr(CREDS)


# ----------------------------------------------------------------------
# Error envelopes
# ----------------------------------------------------------------------


def test_error_envelope_on_http_200_is_still_an_error() -> None:
    """GraphQL reports failure with 200. The web path learned this the hard way."""
    client = client_returning({"error": 10020, "msg": "invalid app id", "data": None})

    with pytest.raises(AffiliateAuthError) as caught:
        client.execute("{ping}")
    assert caught.value.code == 10020


def test_rate_limit_code_has_its_own_type() -> None:
    client = client_returning({"error": 10030, "msg": "rate limit exceeded"})

    with pytest.raises(AffiliateRateLimited):
        client.execute("{ping}")


def test_graphql_errors_array_is_surfaced() -> None:
    client = client_returning({"errors": [{"message": "Cannot query field ratingStar"}]})

    with pytest.raises(AffiliateError, match="ratingStar"):
        client.execute("{ping}")


def test_http_401_is_an_auth_error_not_a_generic_one() -> None:
    client = client_returning(httpx.Response(401, text="nope"))

    with pytest.raises(AffiliateAuthError):
        client.execute("{ping}")


def test_non_json_body_raises_rather_than_returning_garbage() -> None:
    client = client_returning(httpx.Response(200, text="<html>maintenance</html>"))

    with pytest.raises(AffiliateError, match="not JSON"):
        client.execute("{ping}")


# ----------------------------------------------------------------------
# Adapter field mapping
# ----------------------------------------------------------------------


def test_parses_all_five_required_fields() -> None:
    client = client_returning({"data": {"productOfferV2": {"nodes": [offer()]}}})
    adapter = ShopeeAffiliateAdapter(client)

    items = adapter.search_keyword("kaos polos", pages=1)

    assert len(items) == 1
    store, product, snapshot = items[0]
    assert store.shop_id == 222
    assert store.name == "ERIGO Official Shop"
    assert product.item_id == 111
    assert product.name == "Erigo Chino Pants Sirius Black"  # whitespace collapsed
    assert snapshot.price == Decimal("152900.00")
    assert snapshot.price_max == Decimal("189000.00")
    assert snapshot.sold == 640
    assert snapshot.rating_star == Decimal("4.83")


def test_affiliate_prices_are_whole_rupiah_not_micro_units() -> None:
    """The web endpoint scales prices by 100000; this API does not.

    Applying the web divisor here would report Rp 1.53 instead of Rp 152,900.
    """
    client = client_returning({"data": {"productOfferV2": {"nodes": [offer()]}}})
    items = ShopeeAffiliateAdapter(client).search_keyword("x", pages=1)

    assert items[0].snapshot.price == Decimal("152900.00")


def test_rows_are_marked_as_shopee_so_history_stays_continuous() -> None:
    """A separate marketplace value would fork (marketplace, item_id)."""
    client = client_returning({"data": {"productOfferV2": {"nodes": [offer()]}}})
    adapter = ShopeeAffiliateAdapter(client)

    assert adapter.marketplace is Marketplace.SHOPEE
    store, product, _snapshot = adapter.search_keyword("x", pages=1)[0]
    assert store.marketplace is Marketplace.SHOPEE
    assert product.marketplace is Marketplace.SHOPEE


def test_a_malformed_offer_is_skipped_not_fatal() -> None:
    nodes = [offer(item_id=1), {"itemId": None, "productName": "broken"}, offer(item_id=3)]
    client = client_returning({"data": {"productOfferV2": {"nodes": nodes}}})

    items = ShopeeAffiliateAdapter(client).search_keyword("x", pages=1)

    assert [item.product.item_id for item in items] == [1, 3]


def test_offer_without_a_usable_price_is_skipped() -> None:
    nodes = [offer(item_id=1, priceMin=None, priceMax=None), offer(item_id=2)]
    client = client_returning({"data": {"productOfferV2": {"nodes": nodes}}})

    items = ShopeeAffiliateAdapter(client).search_keyword("x", pages=1)

    assert [item.product.item_id for item in items] == [2]


def test_missing_rating_becomes_none_not_zero() -> None:
    client = client_returning(
        {"data": {"productOfferV2": {"nodes": [offer(ratingStar=None)]}}}
    )
    items = ShopeeAffiliateAdapter(client).search_keyword("x", pages=1)

    assert items[0].snapshot.rating_star is None


# ----------------------------------------------------------------------
# Pagination
# ----------------------------------------------------------------------


def test_pagination_stops_when_a_page_reports_no_next_page() -> None:
    captured: list[httpx.Request] = []
    page1 = {
        "data": {
            "productOfferV2": {
                "nodes": [offer(item_id=i) for i in range(1, PAGE_SIZE + 1)],
                "pageInfo": {"hasNextPage": False},
            }
        }
    }
    client = client_returning(page1, capture=captured)

    items = ShopeeAffiliateAdapter(client).search_keyword("x", pages=5)

    assert len(items) == PAGE_SIZE
    assert len(captured) == 1  # did not request pages 2..5


def test_pagination_stops_when_a_page_repeats_known_items() -> None:
    """Guards against an API that keeps serving page 1 past the end."""
    full = {
        "data": {
            "productOfferV2": {
                "nodes": [offer(item_id=i) for i in range(1, PAGE_SIZE + 1)],
                "pageInfo": {"hasNextPage": True},
            }
        }
    }
    captured: list[httpx.Request] = []
    client = client_returning(full, full, full, capture=captured)

    items = ShopeeAffiliateAdapter(client).search_keyword("x", pages=3)

    assert len(items) == PAGE_SIZE  # deduplicated
    assert len(captured) == 2  # stopped after the repeat, did not fetch page 3


def test_short_page_ends_the_walk() -> None:
    captured: list[httpx.Request] = []
    client = client_returning(
        {"data": {"productOfferV2": {"nodes": [offer(item_id=1)]}}}, capture=captured
    )

    ShopeeAffiliateAdapter(client).search_keyword("x", pages=4)

    assert len(captured) == 1


def test_pages_below_one_is_rejected() -> None:
    with pytest.raises(ValueError):
        ShopeeAffiliateAdapter(client_returning()).search_keyword("x", pages=0)


# ----------------------------------------------------------------------
# Store mode
# ----------------------------------------------------------------------


def test_store_mode_queries_by_numeric_shop_id() -> None:
    captured: list[httpx.Request] = []
    client = client_returning(
        {"data": {"productOfferV2": {"nodes": [offer()]}}}, capture=captured
    )

    ShopeeAffiliateAdapter(client).search_shop("222", pages=1)

    variables = json.loads(captured[0].content)["variables"]
    assert variables["shopId"] == 222
    assert "keyword" not in variables


def test_a_slug_is_rejected_with_actionable_guidance() -> None:
    """The affiliate payload has no shop slug; failing loudly beats guessing."""
    adapter = ShopeeAffiliateAdapter(client_returning())

    with pytest.raises(LookupError, match="numeric id"):
        adapter.search_shop("erigostore", pages=1)


def test_store_mode_can_exceed_one_item_per_shop() -> None:
    """The whole point of this adapter for store mode.

    The web path is capped at a single SEO-exposed item per shop.
    """
    nodes = [offer(item_id=i, shop_id=222) for i in range(1, 31)]
    client = client_returning({"data": {"productOfferV2": {"nodes": nodes}}})

    items = ShopeeAffiliateAdapter(client).search_shop("222", pages=1)

    assert len(items) == 30
    assert {item.product.shop_id for item in items} == {222}


# ----------------------------------------------------------------------
# Adapter selection
# ----------------------------------------------------------------------


def _settings(**overrides) -> Settings:
    base = {"database_url": "postgresql://localhost/unused"}
    base.update(overrides)
    return Settings(**base)


def test_affiliate_adapter_is_chosen_when_credentials_exist() -> None:
    settings = _settings(
        shopee_affiliate_app_id="123456", shopee_affiliate_app_secret="s3cr3t"
    )
    assert settings.has_affiliate_credentials is True

    adapter = build_shopee_adapter(settings=settings)

    assert isinstance(adapter, ShopeeAffiliateAdapter)
    adapter.close()


def test_web_adapter_is_chosen_without_credentials() -> None:
    from scraper.adapters.shopee import ShopeeAdapter

    settings = _settings()
    assert settings.has_affiliate_credentials is False

    adapter = build_shopee_adapter(settings=settings)

    assert isinstance(adapter, ShopeeAdapter)


def test_blank_credentials_do_not_count_as_credentials() -> None:
    settings = _settings(shopee_affiliate_app_id="  ", shopee_affiliate_app_secret="")
    assert settings.has_affiliate_credentials is False


def test_unknown_region_fails_loudly() -> None:
    settings = _settings(
        shopee_affiliate_app_id="1",
        shopee_affiliate_app_secret="2",
        shopee_affiliate_region="atlantis",
    )

    with pytest.raises(ValueError, match="atlantis"):
        build_shopee_adapter(settings=settings)


def test_affiliate_secret_is_not_in_settings_repr() -> None:
    settings = _settings(
        shopee_affiliate_app_id="123456", shopee_affiliate_app_secret="s3cr3t"
    )

    assert "s3cr3t" not in repr(settings)
