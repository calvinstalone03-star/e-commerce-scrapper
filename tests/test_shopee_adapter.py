"""Tests for :mod:`scraper.adapters.shopee` and the adapter registry.

Fixture provenance — this matters, because two of the three are real and one is
not:

``tests/fixtures/shopee_get_shop_seo.json``
    **REAL.** Copied out of ``.recon/browser_capture.json`` (request #28,
    ``GET /api/v4/shop/get_shop_seo?shopid=30203584``, HTTP 200). The recon
    harness truncated the body at 4000 characters mid-``video_info_list``, so the
    item was cut at that key and the object closed to make it valid JSON; the
    130-entry ``label_ids`` array was dropped. Every retained value — including
    ``price: 15290000000``, ``sold: 612`` and ``historical_sold: 500000`` — is
    verbatim from the wire. Note it carries **no** ``item_rating``, which is what
    makes it the natural missing-rating case.

``tests/fixtures/shopee_get_shop_detail.json``
    **REAL.** ``.recon/B_get_shop_detail.json`` verbatim, minus the ``ab_test_info``
    blob. This was the only endpoint that answered a plain httpx probe.

``tests/fixtures/shopee_blocked.json``
    **REAL.** ``.recon/A_search_kaos_polos.json`` verbatim — the ``error: 90309999``
    anti-bot envelope Shopee returned for keyword search.

``tests/fixtures/shopee_search_items_SYNTHETIC.json``
    **HAND-WRITTEN, NOT A CAPTURE.** Every recon attempt at
    ``/api/v4/search/search_items`` was blocked, from plain httpx *and* from a
    real Chromium carrying Shopee's own JS-generated signing headers. No genuine
    search body exists to copy, so the ``item_basic`` envelope here is
    reconstructed from the documented field map. The field *names* are what the
    adapter must handle; the *values* are invented.

The fixtures live under ``tests/fixtures`` rather than being read from ``.recon``
because ``.recon`` is gitignored.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from scraper.adapters import ScrapedItem, get_adapter, register_adapter
from scraper.adapters.shopee import (
    PRICE_DIVISOR,
    SEARCH_PAGE_SIZE,
    SHOP_PAGE_SIZE,
    ShopeeAdapter,
    build_image_url,
    build_product_url,
    is_placeholder_username,
    normalise_username,
    parse_item,
    parse_shop,
    parse_sold_field,
    to_rupiah,
)
from scraper.client import BlockedError, ScraperHTTPError
from scraper.models import Marketplace
from scraper.models import ScrapedItem as ModelScrapedItem

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict[str, Any]:
    """Read a JSON fixture from ``tests/fixtures``.

    Args:
        name: File name inside the fixtures directory.

    Returns:
        The decoded JSON object.
    """
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# Test doubles
# --------------------------------------------------------------------------- #


class FakeBlockedError(BlockedError):
    """A :class:`BlockedError` constructible today.

    ``ScraperHTTPError.__init__`` is still a scaffold stub that raises
    ``NotImplementedError``, so ``BlockedError("x")`` cannot be built yet. Going
    straight to ``RuntimeError.__init__`` sidesteps the stub while keeping
    ``isinstance(exc, BlockedError)`` true, which is the only thing the adapter
    tests on. This keeps the suite independent of whichever state
    ``scraper/client.py`` is in.
    """

    def __init__(self, message: str = "blocked") -> None:
        """Initialise without touching the unimplemented parent constructor."""
        RuntimeError.__init__(self, message)


class FakeHTTPError(ScraperHTTPError):
    """A non-block :class:`ScraperHTTPError`, constructible for the same reason."""

    def __init__(self, message: str = "boom") -> None:
        """Initialise without touching the unimplemented parent constructor."""
        RuntimeError.__init__(self, message)


class FakeClient:
    """Stands in for :class:`scraper.client.ShopeeClient`.

    The adapter only ever calls ``get_json``, so that is all this implements. It
    records every call and serves responses from a per-path queue; a queued entry
    that is an exception instance is raised instead of returned.

    Attributes:
        calls: ``(path, params, referer)`` for every request, in order.
        closed: Whether :meth:`close` was called.
    """

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        """Seed the response queues.

        Args:
            responses: ``path -> payload`` or ``path -> [payload, ...]``. A list
                is consumed one entry per call; the last entry repeats once the
                queue is exhausted. A missing path yields ``{"error": 0}``.
        """
        self._responses: dict[str, list[Any]] = {}
        for path, value in (responses or {}).items():
            self._responses[path] = list(value) if isinstance(value, list) else [value]
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []
        self.closed = False

    def get_json(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        referer: str | None = None,
        allow_rebootstrap: bool = True,
    ) -> dict[str, Any]:
        """Record the call and return (or raise) the next queued response."""
        self.calls.append((path, dict(params or {}), referer))
        queue = self._responses.get(path)
        if not queue:
            return {"error": 0}
        response = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(response, BaseException):
            raise response
        return response

    def close(self) -> None:
        """Mark the client closed."""
        self.closed = True

    def paths(self) -> list[str]:
        """Return just the paths of the recorded calls, in order."""
        return [path for path, _, _ in self.calls]

    def calls_to(self, path: str) -> list[tuple[str, dict[str, Any], str | None]]:
        """Return the recorded calls made to one path."""
        return [call for call in self.calls if call[0] == path]


def make_search_page(count: int, *, start_id: int = 1000, shop_id: int = 555) -> dict[str, Any]:
    """Build a search payload of ``count`` well-formed ``item_basic`` entries.

    Args:
        count: How many items the page should carry.
        start_id: First item id; ids increment from here.
        shop_id: Shop id stamped on every item.

    Returns:
        A search-shaped payload.
    """
    return {
        "error": 0,
        "items": [
            {
                "item_basic": {
                    "itemid": start_id + index,
                    "shopid": shop_id,
                    "name": f"Item {index}",
                    "price": 1_000_000_000,
                    "stock": 5,
                    "sold": index,
                }
            }
            for index in range(count)
        ],
    }


# --------------------------------------------------------------------------- #
# to_rupiah / the price divisor
# --------------------------------------------------------------------------- #


def test_price_divisor_matches_the_verified_capture() -> None:
    """The real capture's 15_290_000_000 is Rp 152.900, cross-checked by discount."""
    payload = load_fixture("shopee_get_shop_seo.json")
    item = payload["data"]["items"][0]

    assert to_rupiah(item["price"]) == Decimal("152900")
    assert to_rupiah(item["price_before_discount"]) == Decimal("500000")
    # The payload's own "-69%" is the independent confirmation of the divisor.
    discount = 1 - (Decimal("152900") / Decimal("500000"))
    assert item["discount"] == f"-{int(discount * 100)}%"
    assert PRICE_DIVISOR == Decimal(100_000)


@pytest.mark.parametrize(
    ("micro", "expected"),
    [
        (2_500_000_000, Decimal("25000")),
        ("2500000000", Decimal("25000")),
        (2_500_000_000.0, Decimal("25000")),
        (150_000, Decimal("1.5")),
        (None, None),
        (-1, None),
        (0, None),
        ("", None),
        ("not-a-price", None),
    ],
)
def test_to_rupiah(micro: Any, expected: Decimal | None) -> None:
    """Micro-units divide by 100_000; sentinels and junk degrade to None."""
    assert to_rupiah(micro) == expected


def test_to_rupiah_never_uses_binary_float() -> None:
    """A float input must not smuggle binary rounding into the Decimal."""
    assert to_rupiah(1_234_500_000.0) == Decimal("12345")


# --------------------------------------------------------------------------- #
# parse_sold
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (612, 612),
        (0, 0),
        ("612", 612),
        ("1.200", 1200),
        ("100+", 100),
        ("1RB+", 1000),
        ("1rb+ terjual", 1000),
        ("Terjual 5RB+", 5000),
        ("1,2rb", 1200),
        ("1.2k", 1200),
        ("10k+", 10000),
        ("1jt+", 1_000_000),
        ({"sold_count_text": "2RB+ terjual"}, 2000),
        ({"sold_count": 47}, 47),
        (None, None),
        ("", None),
        ("banyak", None),
        (-5, None),
    ],
)
def test_parse_sold_field(value: Any, expected: int | None) -> None:
    """Exact ints, redacted display buckets and display dicts all land as ints."""
    assert parse_sold_field(value) == expected


# --------------------------------------------------------------------------- #
# parse_item — real flat shape
# --------------------------------------------------------------------------- #


def test_parse_item_flat_shape_from_real_capture() -> None:
    """The verified get_shop_seo item maps end to end with no envelope."""
    payload = load_fixture("shopee_get_shop_seo.json")
    item = parse_item(payload["data"]["items"][0])

    assert isinstance(item, ScrapedItem)
    store, product, snapshot = item  # NamedTuple unpacks positionally

    assert store.marketplace is Marketplace.SHOPEE
    assert store.shop_id == 30203584
    assert product.item_id == 2698631224
    assert product.shop_id == 30203584
    assert product.name == "Erigo Chino Pants Sirius Black - Celana Panjang Chino Unisex"
    assert product.url == (
        "https://shopee.co.id/erigo-chino-pants-sirius-black-celana-panjang-chino-unisex"
        "-i.30203584.2698631224"
    )
    assert product.image == (
        "https://down-id.img.susercontent.com/file/id-11134201-7rbkc-m7umx9q1utm11c"
    )

    assert snapshot.item_id == 2698631224
    assert snapshot.price == Decimal("152900")
    assert snapshot.price_min == Decimal("152900")
    assert snapshot.price_max == Decimal("152900")
    assert snapshot.stock == 1
    assert snapshot.sold == 612
    assert snapshot.historical_sold == 500000
    # scraped_at is stamped by PriceSnapshot's default_factory; the repository
    # only overrides it when it is None. first_seen/last_seen stay the
    # repository's job.
    assert snapshot.scraped_at is not None and snapshot.scraped_at.tzinfo is not None
    assert product.first_seen is None and product.last_seen is None
    assert store.first_seen is None and store.last_seen is None


def test_parse_item_reads_the_per_item_rating_from_get_shop_seo() -> None:
    """get_shop_seo *does* carry a per-item rating — verified against the live endpoint.

    The recon notes claimed per-item rating was absent from this endpoint and only
    obtainable from the blocked ``search_items``. A live integration fetch on
    2026-07-27 disproved that: the item carries a full ``item_rating`` envelope,
    and these are its real values. The fixture was widened to match.
    """
    payload = load_fixture("shopee_get_shop_seo.json")
    raw = payload["data"]["items"][0]

    _, _, snapshot = parse_item(raw)
    assert snapshot.rating_star == Decimal("4.833337902673064")
    # rating_count[0] is the total; indices 1..5 are the per-star histogram.
    assert snapshot.rating_count == 328378


def test_parse_item_missing_rating_degrades_to_none() -> None:
    """An item with no rating envelope must yield None, not a crash.

    Driven by an item with ``item_rating`` stripped rather than by the raw
    fixture, so the degradation path stays covered now that the real payload
    does carry a rating.
    """
    payload = load_fixture("shopee_get_shop_seo.json")
    raw = dict(payload["data"]["items"][0])
    raw.pop("item_rating", None)

    _, _, snapshot = parse_item(raw)
    assert snapshot.rating_star is None
    assert snapshot.rating_count is None


def test_parse_item_does_not_mistake_cmt_count_for_rating_count() -> None:
    """``cmt_count`` is comments, not ratings — conflating them would be silent bad data.

    The real payload makes this sharper than a None check: both numbers are
    present and they are close (325_363 comments vs 328_378 ratings), which is
    exactly the situation a sloppy field map gets wrong.
    """
    payload = load_fixture("shopee_get_shop_seo.json")
    raw = payload["data"]["items"][0]
    assert raw["cmt_count"] == 325363

    _, _, snapshot = parse_item(raw)
    assert snapshot.rating_count == 328378
    assert snapshot.rating_count != raw["cmt_count"]


def test_parse_item_flat_shape_has_placeholder_username() -> None:
    """A payload with no slug still produces a valid Store, flagged as synthetic."""
    payload = load_fixture("shopee_get_shop_seo.json")
    store, _, _ = parse_item(payload["data"]["items"][0])

    assert store.username == "shop-30203584"
    assert is_placeholder_username(store.username)


# --------------------------------------------------------------------------- #
# parse_item — item_basic envelope
# --------------------------------------------------------------------------- #


def test_parse_item_item_basic_shape() -> None:
    """The nested ``{"item_basic": {...}}`` envelope maps identically."""
    payload = load_fixture("shopee_search_items_SYNTHETIC.json")
    store, product, snapshot = parse_item(payload["items"][0])

    assert product.item_id == 22334455667
    assert product.shop_id == 30203584
    assert product.name == "Kaos Polos Cotton Combed 30s Unisex Lengan Pendek"
    assert snapshot.price == Decimal("55000")
    assert snapshot.price_min == Decimal("55000")
    assert snapshot.price_max == Decimal("79000")
    assert snapshot.stock == 480
    assert snapshot.sold == 233
    assert snapshot.historical_sold == 18452
    assert snapshot.rating_star == Decimal("4.8231")
    # rating_count[0] is the total; indices 1..5 are the per-star histogram.
    assert snapshot.rating_count == 1204
    assert store.location == "JAKARTA BARAT"
    assert store.name == "Kaos Nusantara"


def test_parse_item_variant_price_sentinel_falls_back_to_price_min() -> None:
    """A variant listing reports ``price: -1``; price must come from price_min."""
    payload = load_fixture("shopee_search_items_SYNTHETIC.json")
    raw = payload["items"][1]
    assert raw["item_basic"]["price"] == -1  # guard the premise

    _, _, snapshot = parse_item(raw)
    assert snapshot.price == Decimal("89000")
    assert snapshot.price_min == Decimal("89000")
    assert snapshot.price_max == Decimal("125000")


def test_parse_item_missing_sold_is_none_not_zero() -> None:
    """An absent sold field means "not exposed", which is None — never 0."""
    _, _, snapshot = parse_item(
        {"itemid": 1, "shopid": 2, "name": "No counters", "price": 1_000_000_000}
    )
    assert snapshot.sold is None
    assert snapshot.historical_sold is None
    assert snapshot.stock is None
    assert snapshot.rating_star is None


def test_parse_item_zero_sold_is_preserved() -> None:
    """A genuine 0 is data, and must survive the None-vs-zero rule."""
    _, _, snapshot = parse_item({"itemid": 1, "shopid": 2, "name": "x", "sold": 0})
    assert snapshot.sold == 0


def test_parse_item_accepts_bucketed_sold_string() -> None:
    """Shopee redacts sold counts to display buckets on some envelopes."""
    _, _, snapshot = parse_item(
        {"itemid": 1, "shopid": 2, "name": "x", "item_card_display_sold_count": "1RB+ terjual"}
    )
    assert snapshot.sold == 1000


def test_parse_item_reads_item_card_display_price() -> None:
    """The newer item-card envelope is the last price fallback."""
    _, _, snapshot = parse_item(
        {
            "itemid": 1,
            "shopid": 2,
            "name": "x",
            "item_card_display_price": {"price": 3_300_000_000},
        }
    )
    assert snapshot.price == Decimal("33000")


def test_parse_item_survives_retyped_fields() -> None:
    """A shape change degrades each field to None rather than raising."""
    _, _, snapshot = parse_item(
        {
            "itemid": "1",
            "shopid": "2",
            "name": "Retyped",
            "price": {"unexpected": "object"},
            "stock": "not-a-number",
            "item_rating": ["not", "a", "mapping"],
        }
    )
    assert snapshot.price is None
    assert snapshot.stock is None
    assert snapshot.rating_star is None


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param({"shopid": 2, "name": "no itemid"}, id="missing-itemid"),
        pytest.param({"itemid": 1, "name": "no shopid"}, id="missing-shopid"),
        pytest.param({"itemid": 1, "shopid": 2}, id="missing-name"),
        pytest.param({"itemid": "abc", "shopid": 2, "name": "x"}, id="unparseable-itemid"),
        pytest.param({"item_basic": {}}, id="empty-envelope"),
        pytest.param({}, id="empty"),
    ],
)
def test_parse_item_raises_valueerror_on_malformed(raw: dict[str, Any]) -> None:
    """parse_item signals a bad item with ValueError so the caller can skip it."""
    with pytest.raises(ValueError):
        parse_item(raw)


# --------------------------------------------------------------------------- #
# URL / image helpers
# --------------------------------------------------------------------------- #


def test_build_product_url_numeric_suffix_is_exact() -> None:
    """The slug is cosmetic; the ``-i.<shop>.<item>`` suffix must be exact."""
    url = build_product_url("Kaos Polos 30s!! (Putih)", 555, 999)
    assert url.endswith("-i.555.999")
    assert url.startswith("https://shopee.co.id/kaos-polos-30s-putih")


def test_build_product_url_falls_back_when_name_has_no_ascii() -> None:
    """An unsluggable title still yields a resolvable URL."""
    assert build_product_url("!!!", 555, 999) == "https://shopee.co.id/product/555/999"


def test_build_image_url() -> None:
    """Hashes get the CDN prefix; absolute URLs pass through; None stays None."""
    assert build_image_url("id-1134-abc") == (
        "https://down-id.img.susercontent.com/file/id-1134-abc"
    )
    assert build_image_url("https://cdn.example/x.jpg") == "https://cdn.example/x.jpg"
    assert build_image_url(None) is None
    assert build_image_url("") is None


@pytest.mark.parametrize(
    "raw",
    [
        "erigostore",
        "@erigostore",
        "  erigostore  ",
        "shopee.co.id/erigostore",
        "https://shopee.co.id/erigostore",
        "https://shopee.co.id/erigostore?smtt=1",
    ],
)
def test_normalise_username(raw: str) -> None:
    """Anything a user might paste reduces to the bare slug."""
    assert normalise_username(raw) == "erigostore"


def test_normalise_username_rejects_blank() -> None:
    """An empty target is a configuration error, not a silent no-op."""
    with pytest.raises(ValueError):
        normalise_username("   ")


# --------------------------------------------------------------------------- #
# parse_shop
# --------------------------------------------------------------------------- #


def test_parse_shop_from_real_capture() -> None:
    """The verified get_shop_detail body maps onto a Store."""
    store = parse_shop(load_fixture("shopee_get_shop_detail.json"))

    assert store.marketplace is Marketplace.SHOPEE
    assert store.shop_id == 30203584
    assert store.username == "erigostore"
    assert store.name == "ERIGO Official Shop"
    assert store.location == "KAB. TANGERANG"
    assert store.follower_count == 7590364
    assert store.rating_star == Decimal("4.844464")
    assert store.first_seen is None and store.last_seen is None


def test_parse_shop_accepts_bare_data_dict() -> None:
    """Both the enveloped and the unwrapped form are accepted."""
    payload = load_fixture("shopee_get_shop_detail.json")
    assert parse_shop(payload["data"]).shop_id == 30203584


def test_parse_shop_username_fallback() -> None:
    """When the payload omits the slug, the looked-up one is used."""
    store = parse_shop({"data": {"shopid": 7}}, username="@toko-kita")
    assert store.username == "toko-kita"
    assert not is_placeholder_username(store.username)


def test_parse_shop_requires_a_shop_id() -> None:
    """No shopid means the payload is unusable."""
    with pytest.raises(ValueError):
        parse_shop({"data": {"name": "no id"}})


# --------------------------------------------------------------------------- #
# search_keyword — pagination
# --------------------------------------------------------------------------- #


def test_search_keyword_paginates_with_newest_offsets() -> None:
    """``newest`` is a row offset (page * limit), not a page index."""
    client = FakeClient(
        {
            "/api/v4/search/search_items": [
                make_search_page(SEARCH_PAGE_SIZE, start_id=0),
                make_search_page(SEARCH_PAGE_SIZE, start_id=1000),
                make_search_page(SEARCH_PAGE_SIZE, start_id=2000),
            ]
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos polos", pages=3)

    assert len(items) == SEARCH_PAGE_SIZE * 3
    offsets = [params["newest"] for _, params, _ in client.calls_to("/api/v4/search/search_items")]
    assert offsets == [0, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE * 2]

    _, params, referer = client.calls[0]
    assert params["limit"] == SEARCH_PAGE_SIZE
    assert params["keyword"] == "kaos polos"
    assert params["scenario"] == "PAGE_GLOBAL_SEARCH"
    assert params["version"] == 2
    assert referer == "https://shopee.co.id/search?keyword=kaos%20polos"


def test_search_keyword_stops_early_on_short_page() -> None:
    """A page shorter than ``limit`` is the last page — do not request another."""
    client = FakeClient(
        {
            "/api/v4/search/search_items": [
                make_search_page(SEARCH_PAGE_SIZE, start_id=0),
                make_search_page(5, start_id=9000),
            ]
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos", pages=5)

    assert len(client.calls_to("/api/v4/search/search_items")) == 2
    assert len(items) == SEARCH_PAGE_SIZE + 5


def test_search_keyword_stops_on_empty_page() -> None:
    """An empty result set is a legitimate answer, not an error."""
    client = FakeClient({"/api/v4/search/search_items": {"error": 0, "items": []}})
    adapter = ShopeeAdapter(client=client)

    assert adapter.search_keyword("nothing-matches-this", pages=4) == []
    assert len(client.calls) == 1


def test_search_keyword_honours_nomore_flag() -> None:
    """A full page flagged ``nomore`` still ends pagination."""
    page = make_search_page(SEARCH_PAGE_SIZE)
    page["nomore"] = True
    client = FakeClient({"/api/v4/search/search_items": page})
    adapter = ShopeeAdapter(client=client)

    adapter.search_keyword("kaos", pages=4)
    assert len(client.calls) == 1


def test_search_keyword_deduplicates_across_pages() -> None:
    """The same item on two pages is yielded once."""
    client = FakeClient(
        {
            "/api/v4/search/search_items": [
                make_search_page(SEARCH_PAGE_SIZE, start_id=0),
                make_search_page(SEARCH_PAGE_SIZE, start_id=0),
            ]
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos", pages=2)
    ids = [item.product.item_id for item in items]
    assert len(ids) == len(set(ids)) == SEARCH_PAGE_SIZE


def test_search_keyword_skips_malformed_item_without_losing_the_page() -> None:
    """One bad entry in a page must cost exactly one item, and must not raise."""
    page = make_search_page(3)
    page["items"].insert(1, {"item_basic": {"shopid": 555, "name": "no itemid"}})
    page["items"].insert(2, {"item_basic": None})
    page["items"].insert(3, "not-even-a-dict")
    client = FakeClient({"/api/v4/search/search_items": page})
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos", pages=1)

    assert len(items) == 3
    assert [item.product.name for item in items] == ["Item 0", "Item 1", "Item 2"]


def test_search_keyword_propagates_blocked_error() -> None:
    """A block is the runner's problem — the adapter must not swallow it."""
    client = FakeClient({"/api/v4/search/search_items": FakeBlockedError()})
    adapter = ShopeeAdapter(client=client)

    with pytest.raises(BlockedError):
        adapter.search_keyword("kaos", pages=2)


def test_search_keyword_stops_on_antibot_error_envelope(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Shopee returns error 90309999 with HTTP 200 to a browser-shaped client.

    Also checks the log names the refusal rather than printing a bare code —
    "anti-bot refusal" and "error 4" point an operator at completely different
    fixes.
    """
    blocked_body = load_fixture("shopee_blocked.json")
    assert blocked_body["error"] == 90309999  # guard the premise
    client = FakeClient({"/api/v4/search/search_items": blocked_body})
    adapter = ShopeeAdapter(client=client)

    with caplog.at_level("WARNING", logger="scraper.adapters.shopee"):
        assert adapter.search_keyword("kaos", pages=3) == []

    assert len(client.calls) == 1
    assert "anti-bot refusal" in caplog.text
    assert blocked_body["tracking_id"] in caplog.text


def test_search_keyword_returns_partial_results_on_mid_walk_http_error() -> None:
    """A non-block failure on page 2 keeps page 1's items."""
    client = FakeClient(
        {"/api/v4/search/search_items": [make_search_page(SEARCH_PAGE_SIZE), FakeHTTPError()]}
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos", pages=3)
    assert len(items) == SEARCH_PAGE_SIZE


@pytest.mark.parametrize("pages", [0, -1])
def test_search_keyword_rejects_bad_page_count(pages: int) -> None:
    """``pages`` below 1 is a programming error."""
    adapter = ShopeeAdapter(client=FakeClient())
    with pytest.raises(ValueError):
        adapter.search_keyword("kaos", pages=pages)


# --------------------------------------------------------------------------- #
# search_keyword — the shop_id -> username hook
# --------------------------------------------------------------------------- #


def test_search_keyword_fires_no_shop_requests_by_default() -> None:
    """Without a resolver, keyword mode must not issue one lookup per item."""
    client = FakeClient({"/api/v4/search/search_items": make_search_page(10)})
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos", pages=1)

    assert len(client.calls) == 1
    assert all(is_placeholder_username(item.store.username) for item in items)


def test_search_keyword_resolver_is_called_once_per_distinct_shop() -> None:
    """The hook is memoised, so 60 hits from 2 sellers cost 2 resolutions."""
    page = {
        "error": 0,
        "items": [
            {"item_basic": {"itemid": index, "shopid": 100 + (index % 2), "name": f"i{index}"}}
            for index in range(30)
        ],
    }
    client = FakeClient({"/api/v4/search/search_items": page})
    seen: list[int] = []

    def resolver(shop_id: int) -> str | None:
        seen.append(shop_id)
        return f"toko-{shop_id}"

    adapter = ShopeeAdapter(client=client, username_resolver=resolver)
    items = adapter.search_keyword("kaos", pages=1)

    assert sorted(seen) == [100, 101]
    assert {item.store.username for item in items} == {"toko-100", "toko-101"}
    assert all(item.store.shop_id in (100, 101) for item in items)


def test_resolve_username_caches_negative_results() -> None:
    """An unresolvable shop is not retried on the next page."""
    calls: list[int] = []

    def resolver(shop_id: int) -> str | None:
        calls.append(shop_id)
        return None

    adapter = ShopeeAdapter(client=FakeClient(), username_resolver=resolver)
    assert adapter.resolve_username(42) is None
    assert adapter.resolve_username(42) is None
    assert calls == [42]


def test_resolve_username_survives_a_broken_resolver() -> None:
    """Enrichment is best-effort; a raising hook must not fail the run."""

    def resolver(shop_id: int) -> str | None:
        raise RuntimeError("resolver exploded")

    adapter = ShopeeAdapter(client=FakeClient(), username_resolver=resolver)
    assert adapter.resolve_username(42) is None


def test_lookup_username_reads_canonical_url() -> None:
    """The built-in resolver mines get_shop_seo's verified canonical_url."""
    client = FakeClient({"/api/v4/shop/get_shop_seo": load_fixture("shopee_get_shop_seo.json")})
    adapter = ShopeeAdapter(client=client)

    assert adapter.lookup_username(30203584) == "erigostore"
    assert client.calls[0][1] == {"shopid": 30203584}


# --------------------------------------------------------------------------- #
# get_shop
# --------------------------------------------------------------------------- #


def test_get_shop_resolves_username_to_shop_id() -> None:
    """The username -> shop_id resolution store mode depends on."""
    client = FakeClient(
        {"/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json")}
    )
    adapter = ShopeeAdapter(client=client)

    store = adapter.get_shop("https://shopee.co.id/erigostore")

    assert store.shop_id == 30203584
    assert store.username == "erigostore"
    assert client.calls[0][1] == {"username": "erigostore"}
    assert client.calls[0][2] == "https://shopee.co.id/erigostore"


def test_get_shop_is_memoised() -> None:
    """A store-mode run must not re-resolve the same shop on every page."""
    client = FakeClient(
        {"/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json")}
    )
    adapter = ShopeeAdapter(client=client)

    first = adapter.get_shop("erigostore")
    second = adapter.get_shop("@erigostore")

    assert first is second
    assert len(client.calls) == 1


def test_get_shop_falls_back_to_get_shop_base() -> None:
    """If the newer endpoint has nothing, the older one gets a turn."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": {"error": 4, "error_msg": "not found", "data": None},
            "/api/v4/shop/get_shop_base": load_fixture("shopee_get_shop_detail.json"),
        }
    )
    adapter = ShopeeAdapter(client=client)

    assert adapter.get_shop("erigostore").shop_id == 30203584
    assert client.paths() == ["/api/v4/shop/get_shop_detail", "/api/v4/shop/get_shop_base"]


def test_get_shop_raises_lookup_error_when_missing() -> None:
    """A nonexistent shop is a LookupError the runner records as FAILED."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": {"error": 4, "data": None},
            "/api/v4/shop/get_shop_base": {"error": 4, "data": None},
        }
    )
    adapter = ShopeeAdapter(client=client)

    with pytest.raises(LookupError):
        adapter.get_shop("does-not-exist")


def test_get_shop_propagates_blocked_error() -> None:
    """A block must not be misreported as "shop does not exist"."""
    client = FakeClient({"/api/v4/shop/get_shop_detail": FakeBlockedError()})
    adapter = ShopeeAdapter(client=client)

    with pytest.raises(BlockedError):
        adapter.get_shop("erigostore")


# --------------------------------------------------------------------------- #
# search_shop
# --------------------------------------------------------------------------- #


def test_search_shop_resolves_once_and_paginates_by_offset() -> None:
    """One shop lookup, then ``offset = page * limit`` on the listing endpoint."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": [
                make_search_page(SHOP_PAGE_SIZE, start_id=0, shop_id=30203584),
                make_search_page(SHOP_PAGE_SIZE, start_id=500, shop_id=30203584),
            ],
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_shop("erigostore", pages=2)

    assert len(items) == SHOP_PAGE_SIZE * 2
    assert len(client.calls_to("/api/v4/shop/get_shop_detail")) == 1
    offsets = [params["offset"] for _, params, _ in client.calls_to("/api/v4/recommend/recommend")]
    assert offsets == [0, SHOP_PAGE_SIZE]
    # This endpoint spells it `shopid`; rcmd_items spells it `shop_id`.
    assert client.calls_to("/api/v4/recommend/recommend")[0][1]["shopid"] == 30203584


def test_search_shop_attaches_the_rich_store_to_every_item() -> None:
    """Required output field #1 (username) must be real, never a placeholder."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": make_search_page(3, shop_id=30203584),
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_shop("erigostore", pages=1)

    assert items
    for item in items:
        assert item.store.username == "erigostore"
        assert item.store.name == "ERIGO Official Shop"
        assert item.store.location == "KAB. TANGERANG"
        assert item.store.shop_id == item.product.shop_id == 30203584
        assert not is_placeholder_username(item.store.username)


def test_search_shop_falls_through_blocked_endpoints_to_get_shop_seo() -> None:
    """The recon reality: both paginated listings are blocked, the SEO door is not."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": FakeBlockedError(),
            "/api/v4/shop/rcmd_items": FakeBlockedError(),
            "/api/v4/shop/get_shop_seo": load_fixture("shopee_get_shop_seo.json"),
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_shop("erigostore", pages=1)

    assert [item.product.item_id for item in items] == [2698631224]
    assert items[0].store.username == "erigostore"
    assert items[0].snapshot.price == Decimal("152900")
    assert "/api/v4/shop/get_shop_seo" in client.paths()


def test_search_shop_does_not_paginate_the_unpaginated_seo_endpoint() -> None:
    """get_shop_seo takes no offset; asking for 4 pages must not call it 4 times."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": {"error": 0, "items": []},
            "/api/v4/shop/rcmd_items": {"error": 0, "items": []},
            "/api/v4/shop/get_shop_seo": load_fixture("shopee_get_shop_seo.json"),
        }
    )
    adapter = ShopeeAdapter(client=client)

    adapter.search_shop("erigostore", pages=4)
    assert len(client.calls_to("/api/v4/shop/get_shop_seo")) == 1


def test_search_shop_raises_blocked_only_when_every_endpoint_is_blocked() -> None:
    """Failing the target is honest only once there is nothing left to try."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": FakeBlockedError(),
            "/api/v4/shop/rcmd_items": FakeBlockedError(),
            "/api/v4/shop/get_shop_seo": FakeBlockedError(),
        }
    )
    adapter = ShopeeAdapter(client=client)

    with pytest.raises(BlockedError):
        adapter.search_shop("erigostore", pages=1)


def test_search_shop_returns_empty_when_shop_has_no_listings() -> None:
    """A shop with nothing on sale is not an error."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": {"error": 0, "items": []},
            "/api/v4/shop/rcmd_items": {"error": 0, "items": []},
            "/api/v4/shop/get_shop_seo": {"error": 0, "data": {"items": []}},
        }
    )
    adapter = ShopeeAdapter(client=client)

    assert adapter.search_shop("erigostore", pages=1) == []


def test_search_shop_reads_the_recommend_sections_envelope() -> None:
    """recommend/recommend nests items under data.sections[].data.item."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": {
                "error": 0,
                "data": {
                    "sections": [
                        {
                            "data": {
                                "item": [
                                    {
                                        "itemid": 42,
                                        "shopid": 30203584,
                                        "name": "Sections envelope",
                                        "price": 2_000_000_000,
                                    }
                                ]
                            }
                        }
                    ]
                },
            },
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_shop("erigostore", pages=1)
    assert [item.product.item_id for item in items] == [42]
    assert items[0].snapshot.price == Decimal("20000")


def test_search_shop_merges_every_recommend_section() -> None:
    """A multi-section page must yield all of its items, and keep paginating. Regression.

    ``_extract_items`` returned the *first* non-empty container and dropped the
    rest. ``/recommend`` genuinely answers with a list of sections, so a 50-item
    page split 20/30 came back as 20 — and because 20 < SHOP_PAGE_SIZE also
    convinced ``_is_last_page`` the walk was over, so the remainder of the shop
    was never requested. The run recorded SUCCESS with a silently truncated
    catalogue: a 2456-item shop showing as 20 products, with no error anywhere.
    """

    def section(start: int, count: int) -> dict[str, Any]:
        return {
            "data": {
                "item": [
                    {
                        "itemid": start + i,
                        "shopid": 30203584,
                        "name": f"Item {start + i}",
                        "price": 1_000_000_000,
                    }
                    for i in range(count)
                ]
            }
        }

    page_one = {"error": 0, "data": {"sections": [section(100, 20), section(200, 10)]}}
    page_two = {"error": 0, "data": {"sections": [section(300, 5)]}}
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": [page_one, page_two],
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_shop("erigostore", pages=3)

    # 20 + 10 from page 1 (a full SHOP_PAGE_SIZE, so the walk continues) and 5
    # from page 2 (short, so it stops).
    assert len(items) == 35
    assert len(client.calls_to("/api/v4/recommend/recommend")) == 2
    assert sorted(item.product.item_id for item in items) == (
        list(range(100, 120)) + list(range(200, 210)) + list(range(300, 305))
    )


def test_extract_items_deduplicates_a_list_reachable_by_two_paths() -> None:
    """Merging containers must not double-count one list found under two keys."""
    from scraper.adapters.shopee import _extract_items

    entries = [{"itemid": 7, "shopid": 1, "name": "one"}]
    payload = {"data": {"item": entries, "sections": [{"data": {"item": entries}}]}}

    assert len(_extract_items(payload)) == 1


def test_search_shop_reports_an_empty_shop_when_only_some_endpoints_were_blocked() -> None:
    """One blocked endpoint plus two clean empty ones is an empty shop, not a block.

    Regression: the guard counted strategies *tried*, not strategies *blocked*, so
    a shop with no active listings during a partial block was recorded FAILED and
    the CLI exited 1 — sending an operator to chase an anti-bot problem that two
    HTTP 200s had already disproved.
    """
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": load_fixture("shopee_get_shop_detail.json"),
            "/api/v4/recommend/recommend": FakeBlockedError(),
            "/api/v4/shop/rcmd_items": {"error": 0, "items": []},
            "/api/v4/shop/get_shop_seo": {"error": 0, "data": {"items": []}},
        }
    )
    adapter = ShopeeAdapter(client=client)

    assert adapter.search_shop("erigostore", pages=1) == []


def test_search_keyword_keeps_pages_already_walked_when_blocked() -> None:
    """A mid-walk block keeps what was collected, exactly as store mode does. Regression.

    ``search_keyword`` re-raised BlockedError verbatim, discarding every page it
    had already parsed, while ``_walk_shop_strategy`` explicitly kept its
    partials. The same event lost all data in one mode and none in the other —
    and keyword mode, which is the one structurally most likely to be blocked
    mid-walk, was the one with no protection.
    """
    client = FakeClient(
        {
            "/api/v4/search/search_items": [
                make_search_page(SEARCH_PAGE_SIZE, start_id=1000),
                make_search_page(SEARCH_PAGE_SIZE, start_id=2000),
                FakeBlockedError(),
            ]
        }
    )
    adapter = ShopeeAdapter(client=client)

    items = adapter.search_keyword("kaos polos", pages=5)

    assert len(items) == 2 * SEARCH_PAGE_SIZE


def test_search_keyword_still_raises_when_blocked_on_the_very_first_page() -> None:
    """With nothing collected there is no partial to protect: the block is the answer."""
    client = FakeClient({"/api/v4/search/search_items": FakeBlockedError()})
    adapter = ShopeeAdapter(client=client)

    with pytest.raises(BlockedError):
        adapter.search_keyword("kaos", pages=5)


def test_parse_stats_distinguishes_schema_drift_from_an_empty_result() -> None:
    """Entries that all fail to parse must be visible as drift, not as "no items".

    Regression: a Shopee field rename made every item unparseable, the adapter
    returned [], and the run finished SUCCESS with item_count=0 and exit code 0 —
    indistinguishable from an empty shop, so a nightly cron stayed green while
    collecting nothing indefinitely.
    """
    drifted_page = {
        "error": 0,
        # `name` renamed: parse_item raises ValueError on every entry.
        "items": [
            {"itemid": 900 + i, "shopid": 5, "product_title": "renamed", "price": 1_000_000_000}
            for i in range(3)
        ],
    }
    client = FakeClient({"/api/v4/search/search_items": drifted_page})
    adapter = ShopeeAdapter(client=client)

    assert adapter.search_keyword("kaos", pages=1) == []
    assert adapter.last_parse_stats.raw_seen == 3
    assert adapter.last_parse_stats.parsed == 0
    assert adapter.last_parse_stats.drifted is True

    # A genuinely empty page is NOT drift — that is the whole point.
    empty = ShopeeAdapter(client=FakeClient({"/api/v4/search/search_items": {"error": 0,
                                                                             "items": []}}))
    assert empty.search_keyword("kaos", pages=1) == []
    assert empty.last_parse_stats.drifted is False


def test_unrated_listing_reports_no_rating_rather_than_zero_stars() -> None:
    """`rating_star: 0` with no ratings behind it is missing data, not a 0-star rating.

    Regression: every unreviewed listing persisted rating_star = 0, so it sorted
    below a genuine 1-star product, dragged each shop's AVG(rating_star) toward
    zero, and was silently excluded by a "rating >= 4" filter.
    """
    item = parse_item(
        {
            "itemid": 1,
            "shopid": 2,
            "name": "Brand new listing",
            "price": 1_000_000_000,
            "item_rating": {"rating_star": 0, "rating_count": [0, 0, 0, 0, 0, 0]},
        }
    )
    assert item.snapshot.rating_star is None
    assert item.snapshot.rating_count == 0


def test_a_zero_star_rating_backed_by_reviews_is_preserved() -> None:
    """The guard keys on the count, so a real (if implausible) 0.0 average survives."""
    item = parse_item(
        {
            "itemid": 1,
            "shopid": 2,
            "name": "Genuinely awful",
            "price": 1_000_000_000,
            "item_rating": {"rating_star": 0, "rating_count": [7, 7, 0, 0, 0, 0]},
        }
    )
    assert item.snapshot.rating_star == Decimal("0")
    assert item.snapshot.rating_count == 7


def test_search_shop_propagates_lookup_error() -> None:
    """A renamed shop fails the target before any listing request is made."""
    client = FakeClient(
        {
            "/api/v4/shop/get_shop_detail": {"error": 4, "data": None},
            "/api/v4/shop/get_shop_base": {"error": 4, "data": None},
        }
    )
    adapter = ShopeeAdapter(client=client)

    with pytest.raises(LookupError):
        adapter.search_shop("gone", pages=1)


@pytest.mark.parametrize("pages", [0, -3])
def test_search_shop_rejects_bad_page_count(pages: int) -> None:
    """``pages`` is validated before the shop lookup burns a request."""
    client = FakeClient()
    adapter = ShopeeAdapter(client=client)
    with pytest.raises(ValueError):
        adapter.search_shop("erigostore", pages=pages)
    assert client.calls == []


# --------------------------------------------------------------------------- #
# Lifecycle + registry
# --------------------------------------------------------------------------- #


def test_close_does_not_close_an_injected_client() -> None:
    """The adapter only owns the client it built itself."""
    client = FakeClient()
    adapter = ShopeeAdapter(client=client)
    adapter.close()
    adapter.close()  # idempotent
    assert client.closed is False


def test_adapter_works_as_a_context_manager() -> None:
    """``with ShopeeAdapter(...)`` closes on exit."""
    client = FakeClient()
    with ShopeeAdapter(client=client) as adapter:
        assert adapter.marketplace is Marketplace.SHOPEE
    assert client.closed is False


def test_get_adapter_builds_shopee_without_importing_the_module() -> None:
    """The registry is what keeps the runner free of concrete adapter imports."""
    adapter = get_adapter(Marketplace.SHOPEE, client=FakeClient())
    assert isinstance(adapter, ShopeeAdapter)
    assert adapter.marketplace is Marketplace.SHOPEE


def test_get_adapter_accepts_the_string_form() -> None:
    """``get_adapter("shopee")`` is the call the runner makes."""
    assert isinstance(get_adapter("shopee", client=FakeClient()), ShopeeAdapter)


def test_get_adapter_rejects_an_unknown_marketplace() -> None:
    """An invalid value is a configuration error, surfaced clearly."""
    with pytest.raises((ValueError, NotImplementedError)):
        get_adapter("lazada")


def test_get_adapter_reports_tokopedia_as_not_implemented() -> None:
    """Tokopedia is a known marketplace with no adapter — the documented case."""
    with pytest.raises(NotImplementedError):
        get_adapter(Marketplace.TOKOPEDIA)


def test_register_adapter_makes_a_new_marketplace_a_drop_in() -> None:
    """Adding a marketplace must need no runner change — only a registration."""
    import scraper.adapters as adapters_module

    class FakeTokopediaAdapter:
        """Minimal stand-in proving the Protocol is all the runner needs."""

        marketplace = Marketplace.TOKOPEDIA

        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

        def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]:
            return []

        def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]:
            return []

        def get_shop(self, username: str):  # noqa: ANN201 - Protocol shape only
            raise LookupError(username)

    saved = adapters_module._FACTORIES.copy()
    try:
        register_adapter(Marketplace.TOKOPEDIA, FakeTokopediaAdapter)
        built = get_adapter("tokopedia", client=None)
        assert isinstance(built, FakeTokopediaAdapter)
        assert Marketplace.TOKOPEDIA in adapters_module.available_marketplaces()
    finally:
        adapters_module._FACTORIES.clear()
        adapters_module._FACTORIES.update(saved)


def test_adapters_reexports_the_models_scrapeditem() -> None:
    """One class, not two structurally identical ones.

    The scaffold declared ``ScrapedItem`` in both ``scraper.models`` and
    ``scraper.adapters``. Two NamedTuples with the same fields are still two
    different classes, so an isinstance check would have failed depending on
    which module the caller imported from. ``scraper.adapters`` re-exports the
    models one.
    """
    assert ScrapedItem is ModelScrapedItem

    payload = load_fixture("shopee_get_shop_seo.json")
    item = parse_item(payload["data"]["items"][0])
    assert isinstance(item, ModelScrapedItem)
    assert item._fields == ("store", "product", "snapshot")


def test_shopee_adapter_satisfies_the_protocol() -> None:
    """A structural check that the concrete class still matches the contract."""
    from scraper.adapters import MarketplaceAdapter

    adapter = ShopeeAdapter(client=FakeClient())
    assert isinstance(adapter, MarketplaceAdapter)
    for method in ("search_keyword", "search_shop", "get_shop"):
        assert callable(getattr(adapter, method))
