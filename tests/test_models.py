"""Unit tests for :mod:`scraper.models`.

These cover the invariants every other module is allowed to assume, so a failure
here should be read as "a downstream module is about to receive bad data", not
as a cosmetic problem:

* price scaling (the ×100 000 micro-unit divisor) and the no-double-scale rule,
* negative-price rejection,
* rating clamping into 0..5 with a warning,
* every ``parse_sold`` display form Shopee emits,
* product URL construction,
* the timezone-aware ``scraped_at`` default.

No network, no database, no filesystem — these are pure model tests.
"""

from __future__ import annotations

import warnings
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError

from scraper.models import (
    MAX_RATING_STAR,
    SHOPEE_PRICE_DIVISOR,
    Marketplace,
    PriceSnapshot,
    Product,
    RatingOutOfRangeWarning,
    RunMode,
    RunStatus,
    ScrapedItem,
    ScrapeRun,
    Store,
    build_product_url,
    parse_sold,
    scale_shopee_price,
    slugify,
    utcnow,
)

# Real values lifted from the live browser-capture recon of shopee.co.id
# (/api/v4/shop/get_shop_seo for shop erigostore), so the numbers under test are
# the ones production will actually see.
REAL_ITEM_ID = 2698631224
REAL_SHOP_ID = 30203584
REAL_NAME = "Erigo Chino Pants Sirius Black - Celana Panjang Chino Unisex"
REAL_PRICE_MICRO = 15_290_000_000  # -> Rp 152.900
REAL_PRICE_BEFORE_MICRO = 50_000_000_000  # -> Rp 500.000


# ---------------------------------------------------------------------------
# Enums — these strings are a DB contract
# ---------------------------------------------------------------------------


def test_marketplace_values_are_the_db_contract() -> None:
    assert Marketplace.SHOPEE.value == "shopee"
    assert Marketplace.TOKOPEDIA.value == "tokopedia"
    assert Marketplace("shopee") is Marketplace.SHOPEE


def test_run_mode_and_status_values() -> None:
    assert [m.value for m in RunMode] == ["keyword", "store"]
    assert [s.value for s in RunStatus] == ["running", "success", "partial", "failed"]


# ---------------------------------------------------------------------------
# Price scaling
# ---------------------------------------------------------------------------


def test_shopee_price_divisor_is_decimal_100k() -> None:
    """The divisor must be exact and Decimal — a float here silently rounds money."""
    assert SHOPEE_PRICE_DIVISOR == Decimal(100_000)
    assert isinstance(SHOPEE_PRICE_DIVISOR, Decimal)


def test_scale_shopee_price_matches_the_captured_payload() -> None:
    """15_290_000_000 -> Rp 152.900, cross-checked against Shopee's own '-69%'."""
    price = scale_shopee_price(REAL_PRICE_MICRO)
    before = scale_shopee_price(REAL_PRICE_BEFORE_MICRO)
    assert price == Decimal("152900")
    assert before == Decimal("500000")
    # Shopee rendered "-69%" for this listing; our scaled numbers must agree.
    discount_pct = (1 - price / before) * 100
    assert 69 <= discount_pct < 70


def test_scale_shopee_price_stays_in_decimal() -> None:
    assert isinstance(scale_shopee_price(1), Decimal)
    # A price that does not divide evenly must keep its fraction exactly, with no
    # binary-float artefact such as 1.2299999999999999.
    assert scale_shopee_price(123_000) == Decimal("1.23")


def test_scale_shopee_price_none_and_sentinels() -> None:
    assert scale_shopee_price(None) is None
    assert scale_shopee_price(-1) is None  # Shopee's "no price" sentinel
    assert scale_shopee_price(0) == Decimal(0)


def test_from_shopee_micro_scales_all_three_money_fields() -> None:
    snap = PriceSnapshot.from_shopee_micro(
        item_id=REAL_ITEM_ID,
        price=REAL_PRICE_MICRO,
        price_min=REAL_PRICE_MICRO,
        price_max=REAL_PRICE_BEFORE_MICRO,
        stock=1,
    )
    assert snap.price == Decimal("152900")
    assert snap.price_min == Decimal("152900")
    assert snap.price_max == Decimal("500000")
    assert snap.stock == 1


def test_plain_construction_does_not_rescale() -> None:
    """The adapter divides before constructing; the model must not divide again."""
    snap = PriceSnapshot(item_id=REAL_ITEM_ID, price=Decimal("152900"))
    assert snap.price == Decimal("152900")


def test_price_accepts_int_float_str_without_float_artifacts() -> None:
    assert PriceSnapshot(item_id=1, price=152900).price == Decimal("152900")
    assert PriceSnapshot(item_id=1, price=152900.5).price == Decimal("152900.5")
    assert PriceSnapshot(item_id=1, price="152900").price == Decimal("152900")
    # Indonesian thousands separators arrive from rendered-page fallbacks.
    assert PriceSnapshot(item_id=1, price="152.900").price == Decimal("152900")


def test_price_none_stays_none() -> None:
    snap = PriceSnapshot(item_id=1)
    assert snap.price is None and snap.price_min is None and snap.price_max is None


# ---------------------------------------------------------------------------
# Negative price rejection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field", ["price", "price_min", "price_max"])
def test_negative_price_is_rejected(field: str) -> None:
    with pytest.raises(ValidationError) as excinfo:
        PriceSnapshot(item_id=1, **{field: -1})
    assert "must not be negative" in str(excinfo.value)


def test_negative_price_rejected_from_micro_units_too() -> None:
    with pytest.raises(ValidationError):
        PriceSnapshot.from_shopee_micro(item_id=1, price=-100_000)


def test_zero_price_is_allowed() -> None:
    """0 is a real (if odd) listing state; only negatives are sentinels."""
    assert PriceSnapshot(item_id=1, price=0).price == Decimal(0)


# ---------------------------------------------------------------------------
# Rating clamping
# ---------------------------------------------------------------------------


def test_rating_in_range_is_untouched() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error", RatingOutOfRangeWarning)
        snap = PriceSnapshot(item_id=1, rating_star=4.844464)
    assert snap.rating_star == Decimal("4.844464")


@pytest.mark.parametrize("value", [5.1, 10, 48.44, 100])
def test_rating_above_five_is_clamped_and_warns(value: float) -> None:
    with pytest.warns(RatingOutOfRangeWarning, match="clamping"):
        snap = PriceSnapshot(item_id=1, rating_star=value)
    assert snap.rating_star == MAX_RATING_STAR == Decimal(5)


def test_rating_below_zero_is_clamped_and_warns() -> None:
    with pytest.warns(RatingOutOfRangeWarning):
        snap = PriceSnapshot(item_id=1, rating_star=-0.5)
    assert snap.rating_star == Decimal(0)


def test_store_rating_is_clamped_too() -> None:
    with pytest.warns(RatingOutOfRangeWarning):
        store = Store(
            marketplace=Marketplace.SHOPEE, shop_id=1, username="x", rating_star=Decimal("9.9")
        )
    assert store.rating_star == Decimal(5)


def test_store_rating_boundary_values_do_not_warn() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error", RatingOutOfRangeWarning)
        assert PriceSnapshot(item_id=1, rating_star=0).rating_star == Decimal(0)
        assert PriceSnapshot(item_id=1, rating_star=5).rating_star == Decimal(5)


def test_rating_none_stays_none() -> None:
    assert PriceSnapshot(item_id=1).rating_star is None
    assert PriceSnapshot(item_id=1, rating_star=None).rating_star is None


# ---------------------------------------------------------------------------
# parse_sold — every form Shopee emits
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Plain integers straight out of the JSON API.
        (612, 612),
        (0, 0),
        (500_000, 500_000),
        ("612", 612),
        (612.0, 612),
        (Decimal("612.9"), 612),  # floored, never rounded up
        # Indonesian abbreviations from the rendered page. "rb" = ribu = 1 000.
        ("10RB+", 10_000),
        ("10rb", 10_000),
        ("1,5RB", 1_500),  # comma is the Indonesian decimal separator
        ("1.5RB", 1_500),  # some builds emit a dot instead
        ("500rb+", 500_000),
        ("5ribu", 5_000),
        # "jt" = juta = 1 000 000.
        ("1,2jt", 1_200_000),
        ("2,5JT", 2_500_000),
        ("5 juta", 5_000_000),
        # English-locale abbreviations.
        ("10K+", 10_000),
        ("1.5k", 1_500),
        ("2M", 2_000_000),
        ("1b", 1_000_000_000),
        # The "Terjual " ("sold") prefix the product card adds.
        ("Terjual 5rb+", 5_000),
        ("Terjual 1,5RB", 1_500),
        ("terjual 100+", 100),
        ("Terjual 612", 612),
        # Grouped integers, Indonesian dot-grouping and English comma-grouping.
        ("1.000", 1_000),
        ("5.052.825", 5_052_825),
        ("1,000", 1_000),
        ("1 234", 1_234),
        # Trailing "+" is a lower bound, not extra precision.
        ("1000+", 1_000),
        # Absent / unparseable / sentinel -> None, never 0.
        (None, None),
        ("", None),
        ("   ", None),
        ("-", None),
        ("N/A", None),
        ("Terjual", None),
        (-1, None),
        ("-1", None),
        (True, None),  # bool is an int subclass; must not become 1
        (False, None),
    ],
)
def test_parse_sold(raw: object, expected: int | None) -> None:
    assert parse_sold(raw) == expected  # type: ignore[arg-type]


def test_parse_sold_returns_real_ints() -> None:
    result = parse_sold("1,5RB")
    assert isinstance(result, int) and not isinstance(result, bool)


def test_parse_sold_does_not_eat_following_words() -> None:
    """A 'k'/'m' starting the next word must not be read as a multiplier."""
    assert parse_sold("612 kaos") == 612
    assert parse_sold("100 macam") == 100


def test_count_fields_accept_display_strings() -> None:
    """Whatever parse_sold accepts, the count fields accept."""
    snap = PriceSnapshot(item_id=1, sold="10RB+", historical_sold="1,5jt", stock="1.000")
    assert snap.sold == 10_000
    assert snap.historical_sold == 1_500_000
    assert snap.stock == 1_000


def test_negative_counts_become_none_not_zero() -> None:
    snap = PriceSnapshot(item_id=1, sold=-1, stock=-1, rating_count=-1)
    assert snap.sold is None and snap.stock is None and snap.rating_count is None


def test_sold_and_historical_sold_are_independent() -> None:
    """The captured payload carried both: sold=612 (recent), historical_sold=500000."""
    snap = PriceSnapshot(item_id=REAL_ITEM_ID, sold=612, historical_sold=500_000)
    assert snap.sold == 612
    assert snap.historical_sold == 500_000


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------


def test_slugify() -> None:
    assert slugify("Kaos Polos Pria") == "kaos-polos-pria"
    assert slugify("Erigo  Chino/Pants — 100% Katun!") == "erigo-chino-pants-100-katun"
    assert slugify("   ") == ""
    assert slugify("!!!") == ""


def test_slugify_truncates_on_a_dash_boundary() -> None:
    slug = slugify(" ".join(["katun"] * 60))
    assert len(slug) <= 100
    assert not slug.endswith("-")


def test_build_product_url_shopee() -> None:
    url = build_product_url(Marketplace.SHOPEE, REAL_ITEM_ID, REAL_SHOP_ID, name="Kaos Polos")
    assert url == f"https://shopee.co.id/kaos-polos-i.{REAL_SHOP_ID}.{REAL_ITEM_ID}"


def test_build_product_url_shopee_falls_back_to_numeric_path() -> None:
    """A title with no alphanumerics still yields a resolvable URL."""
    url = build_product_url(Marketplace.SHOPEE, REAL_ITEM_ID, REAL_SHOP_ID, name="???")
    assert url == f"https://shopee.co.id/product/{REAL_SHOP_ID}/{REAL_ITEM_ID}"


def test_build_product_url_tokopedia_needs_username() -> None:
    url = build_product_url(
        Marketplace.TOKOPEDIA, 1, 2, name="Kaos Polos", username="erigostore"
    )
    assert url == "https://www.tokopedia.com/erigostore/kaos-polos"


def test_product_url_is_autobuilt_when_missing() -> None:
    product = Product(
        marketplace=Marketplace.SHOPEE,
        item_id=REAL_ITEM_ID,
        shop_id=REAL_SHOP_ID,
        name=REAL_NAME,
    )
    assert product.url is not None
    assert product.url.endswith(f"-i.{REAL_SHOP_ID}.{REAL_ITEM_ID}")
    assert product.url.startswith("https://shopee.co.id/erigo-chino-pants-sirius-black")


def test_supplied_product_url_is_preserved() -> None:
    supplied = "https://shopee.co.id/some-canonical-url-i.1.2"
    product = Product(
        marketplace=Marketplace.SHOPEE, item_id=2, shop_id=1, name="x", url=supplied
    )
    assert product.url == supplied


def test_ensure_url_fills_tokopedia_with_the_shop_username() -> None:
    product = Product(
        marketplace=Marketplace.TOKOPEDIA, item_id=7, shop_id=9, name="Kaos Polos"
    )
    # Tokopedia URLs are slug-addressed, so they cannot be built without the shop.
    assert product.url is None
    filled = product.ensure_url(username="erigostore")
    assert filled.url == "https://www.tokopedia.com/erigostore/kaos-polos"


def test_ensure_url_is_idempotent() -> None:
    product = Product(marketplace=Marketplace.SHOPEE, item_id=2, shop_id=1, name="x")
    assert product.ensure_url() is product


# ---------------------------------------------------------------------------
# Whitespace normalisation
# ---------------------------------------------------------------------------


def test_product_name_whitespace_is_stripped_and_collapsed() -> None:
    product = Product(
        marketplace=Marketplace.SHOPEE,
        item_id=1,
        shop_id=2,
        name="  Erigo   Chino Pants\n\tSirius Black  ",
    )
    assert product.name == "Erigo Chino Pants Sirius Black"


def test_store_text_fields_are_normalised() -> None:
    store = Store(
        marketplace=Marketplace.SHOPEE,
        shop_id=REAL_SHOP_ID,
        username="  @erigostore ",
        name="  ERIGO   Official Shop ",
        location="  KAB.  TANGERANG  ",
    )
    assert store.username == "erigostore"
    assert store.name == "ERIGO Official Shop"
    assert store.location == "KAB. TANGERANG"


def test_store_username_accepts_a_full_profile_url() -> None:
    store = Store(
        marketplace=Marketplace.SHOPEE,
        shop_id=1,
        username="https://shopee.co.id/erigostore",
    )
    assert store.username == "erigostore"


def test_blank_optional_text_becomes_none() -> None:
    store = Store(marketplace=Marketplace.SHOPEE, shop_id=1, username="x", name="   ")
    assert store.name is None


def test_scrape_run_target_is_normalised() -> None:
    run = ScrapeRun(
        marketplace=Marketplace.SHOPEE, mode=RunMode.KEYWORD, target="  kaos   polos \n"
    )
    assert run.target == "kaos polos"


def test_scrape_run_error_keeps_newlines() -> None:
    """A traceback must stay readable — only the ends are stripped."""
    run = ScrapeRun(
        marketplace=Marketplace.SHOPEE,
        mode=RunMode.KEYWORD,
        target="k",
        status=RunStatus.FAILED,
        error="\nTraceback:\n  line 1\n  line 2\n",
    )
    assert run.error == "Traceback:\n  line 1\n  line 2"


def test_scrape_run_error_accepts_an_exception() -> None:
    run = ScrapeRun(
        marketplace=Marketplace.SHOPEE,
        mode=RunMode.KEYWORD,
        target="k",
        status=RunStatus.FAILED,
        error=ValueError("boom"),  # type: ignore[arg-type]
    )
    assert run.error is not None and "boom" in run.error


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------


def test_utcnow_is_timezone_aware_utc() -> None:
    now = utcnow()
    assert now.tzinfo is not None
    assert now.utcoffset() == timedelta(0)


def test_scraped_at_defaults_to_tz_aware_utc_now() -> None:
    before = utcnow()
    snap = PriceSnapshot(item_id=1)
    after = utcnow()

    assert snap.scraped_at is not None
    assert snap.scraped_at.tzinfo is not None
    assert snap.scraped_at.utcoffset() == timedelta(0)
    assert before <= snap.scraped_at <= after


def test_two_snapshots_get_independent_defaults() -> None:
    """default_factory, not a shared mutable default."""
    first = PriceSnapshot(item_id=1)
    second = PriceSnapshot(item_id=2)
    assert first.scraped_at is not None and second.scraped_at is not None
    assert first.scraped_at <= second.scraped_at


def test_naive_scraped_at_is_assumed_utc() -> None:
    snap = PriceSnapshot(item_id=1, scraped_at=datetime(2026, 7, 27, 12, 0, 0))
    assert snap.scraped_at == datetime(2026, 7, 27, 12, 0, 0, tzinfo=UTC)


def test_aware_scraped_at_is_converted_to_utc() -> None:
    jakarta = timezone(timedelta(hours=7))
    snap = PriceSnapshot(item_id=1, scraped_at=datetime(2026, 7, 27, 19, 0, 0, tzinfo=jakarta))
    assert snap.scraped_at == datetime(2026, 7, 27, 12, 0, 0, tzinfo=UTC)
    assert snap.scraped_at.utcoffset() == timedelta(0)


def test_scrape_run_timestamps_are_normalised_to_utc() -> None:
    run = ScrapeRun(
        marketplace=Marketplace.SHOPEE,
        mode=RunMode.STORE,
        target="erigostore",
        started_at=datetime(2026, 7, 27, 12, 0, 0),
        finished_at=datetime(2026, 7, 27, 19, 0, 0, tzinfo=timezone(timedelta(hours=7))),
    )
    assert run.started_at == datetime(2026, 7, 27, 12, 0, 0, tzinfo=UTC)
    assert run.finished_at == datetime(2026, 7, 27, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Model shape / defaults
# ---------------------------------------------------------------------------


def test_scrape_run_defaults() -> None:
    run = ScrapeRun(marketplace=Marketplace.SHOPEE, mode=RunMode.KEYWORD, target="kaos")
    assert run.id is None
    assert run.status is RunStatus.RUNNING
    assert run.item_count == 0
    assert run.error is None
    assert run.finished_at is None


def test_models_forbid_unknown_fields() -> None:
    """extra='forbid' is what stops a renamed Shopee field from silently vanishing."""
    for factory in (
        lambda: Store(marketplace=Marketplace.SHOPEE, shop_id=1, username="x", bogus=1),
        lambda: Product(marketplace=Marketplace.SHOPEE, item_id=1, shop_id=2, name="n", bogus=1),
        lambda: PriceSnapshot(item_id=1, bogus=1),
        lambda: ScrapeRun(
            marketplace=Marketplace.SHOPEE, mode=RunMode.KEYWORD, target="t", bogus=1
        ),
    ):
        with pytest.raises(ValidationError):
            factory()  # type: ignore[call-arg]


def test_scraped_item_unpacks_positionally() -> None:
    store = Store(marketplace=Marketplace.SHOPEE, shop_id=REAL_SHOP_ID, username="erigostore")
    product = Product(
        marketplace=Marketplace.SHOPEE,
        item_id=REAL_ITEM_ID,
        shop_id=REAL_SHOP_ID,
        name=REAL_NAME,
    )
    snapshot = PriceSnapshot.from_shopee_micro(
        item_id=REAL_ITEM_ID, price=REAL_PRICE_MICRO, sold=612, historical_sold=500_000
    )
    item = ScrapedItem(store, product, snapshot)

    unpacked_store, unpacked_product, unpacked_snapshot = item
    assert unpacked_store is store
    assert unpacked_product is product
    assert unpacked_snapshot is snapshot
    assert item.store is store and item.product is product and item.snapshot is snapshot


def test_scraped_item_allows_a_missing_store() -> None:
    """Keyword search sometimes returns an item with no resolvable shop record."""
    product = Product(marketplace=Marketplace.SHOPEE, item_id=1, shop_id=2, name="n")
    item = ScrapedItem(None, product, PriceSnapshot(item_id=1))
    assert item.store is None


def test_five_required_output_fields_are_reachable() -> None:
    """username, name, price, sold, rating_star — the deliverable's columns."""
    store = Store(marketplace=Marketplace.SHOPEE, shop_id=REAL_SHOP_ID, username="erigostore")
    product = Product(
        marketplace=Marketplace.SHOPEE,
        item_id=REAL_ITEM_ID,
        shop_id=REAL_SHOP_ID,
        name=REAL_NAME,
    )
    snapshot = PriceSnapshot.from_shopee_micro(
        item_id=REAL_ITEM_ID, price=REAL_PRICE_MICRO, sold=612, rating_star=4.844464
    )
    item = ScrapedItem(store, product, snapshot)

    assert item.store is not None
    assert item.store.username == "erigostore"
    assert item.product.name == REAL_NAME
    assert item.snapshot.price == Decimal("152900")
    assert item.snapshot.sold == 612
    assert item.snapshot.rating_star == Decimal("4.844464")
