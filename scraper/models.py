"""Pydantic v2 domain models — the contract between adapters, repository and DB.

These models are marketplace-agnostic. Nothing in here knows what Shopee's raw
JSON looks like: parsing raw payloads into these models is the job of
``scraper/adapters/shopee.py`` (and, later, ``tokopedia.py``). Keeping parsing
out of this module is what lets a second marketplace reuse the same storage and
reporting layer.

Identity conventions (important — several agents depend on these):

* ``shop_id`` and ``item_id`` are the **marketplace's own numeric ids**, not our
  database primary keys. They are ``int`` (Shopee returns 64-bit ints).
* Our database primary keys are called ``*_ref`` (``shop_ref``, ``product_ref``)
  and never appear on these models. Mapping marketplace id -> database ref is
  done in ``scraper/store.py``.
* ``Product.shop_id`` therefore points at ``Store.shop_id``, not ``stores.id``.

Money / rating conventions:

* All money and rating values are :class:`decimal.Decimal`, never ``float``.
  Shopee returns prices as integer micro-units (actual rupiah * 100_000); the
  adapter is responsible for dividing by 100_000 before constructing a
  :class:`PriceSnapshot`. By the time a value reaches this module it is already
  in whole rupiah.
* ``rating_star`` is a Decimal in the range 0..5.

Timestamp conventions:

* Every datetime is timezone-aware UTC. Use :func:`utcnow` so all modules agree.

Normalisation this module *does* perform
----------------------------------------

The models are not passive containers — they enforce the invariants that every
downstream module is allowed to assume:

* **Whitespace** in every free-text field is stripped and internally collapsed,
  so ``"  Kaos\\n  Polos "`` and ``"Kaos Polos"`` are the same value and cannot
  produce two rows that look different to a human but differ to Postgres.
  Optional text fields that collapse to nothing become ``None``.
* **Prices** are coerced to :class:`~decimal.Decimal` and **negative prices are
  rejected** — Shopee uses ``-1`` as a "no price" sentinel and a sentinel must
  never be persisted as if it were money. The adapter maps the sentinel to
  ``None``; anything negative that still reaches here is a bug and raises.
* **Scaled (micro-unit) prices** can be handed straight to
  :meth:`PriceSnapshot.from_shopee_micro`, which divides by
  :data:`SHOPEE_PRICE_DIVISOR`. Plain construction never rescales, so an adapter
  that already divided (``scraper.adapters.shopee.to_rupiah``) cannot
  double-scale by accident.
* **Ratings** are clamped into 0..5 and emit a :class:`RatingOutOfRangeWarning`
  when they had to be clamped — a silently wrong 48.4-star product is worse than
  a noisy one.
* **Product URLs** are constructed from the ids when the payload did not carry
  one, so required output field "url" is never empty for Shopee.
"""

from __future__ import annotations

import re
import warnings
from datetime import UTC, datetime
from decimal import Decimal, DecimalException, InvalidOperation, ROUND_FLOOR
from enum import Enum
from typing import Any, NamedTuple

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

__all__ = [
    "Marketplace",
    "RunMode",
    "RunStatus",
    "Store",
    "Product",
    "PriceSnapshot",
    "ScrapeRun",
    "ScrapedItem",
    "RatingOutOfRangeWarning",
    "SHOPEE_PRICE_DIVISOR",
    "MARKETPLACE_BASE_URL",
    "MAX_RATING_STAR",
    "utcnow",
    "parse_sold",
    "scale_shopee_price",
    "build_product_url",
    "slugify",
]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Divisor that turns Shopee's integer micro-price into whole rupiah.
#:
#: WHY 100_000, and why this is a *fact* rather than folklore: the browser-capture
#: recon pass observed a live ``/api/v4/shop/get_shop_seo`` payload carrying
#: ``price = 15_290_000_000`` and ``price_before_discount = 50_000_000_000`` for
#: the same listing, alongside Shopee's own rendered ``discount = "-69%"``.
#: Dividing both by 100_000 gives Rp 152.900 and Rp 500.000, and
#: 1 - 152900/500000 = 69.42% — which matches Shopee's own displayed discount.
#: Two independent numbers plus the site's own arithmetic agree, so the divisor
#: is confirmed, not assumed. (The earlier plain-curl recon never saw a price
#: field at all because every item-bearing endpoint returned HTTP 403, so it
#: could neither confirm nor refute this — the browser capture is the source of
#: truth here, per the "trust empirical over researched" rule.)
#:
#: Kept as a Decimal so the division never touches binary floating point.
SHOPEE_PRICE_DIVISOR: Decimal = Decimal(100_000)

#: Marketplace -> site root, used to construct canonical product URLs.
MARKETPLACE_BASE_URL: dict[str, str] = {
    "shopee": "https://shopee.co.id",
    "tokopedia": "https://www.tokopedia.com",
}

#: Upper bound of a star rating on both marketplaces.
MAX_RATING_STAR: Decimal = Decimal(5)

#: Longest slug segment we will put in a constructed product URL. Shopee resolves
#: purely on the numeric ``-i.<shop_id>.<item_id>`` suffix, so truncating the
#: cosmetic slug is lossless.
_MAX_SLUG_LENGTH = 100

_WHITESPACE_RE = re.compile(r"\s+")
_NON_SLUG_RE = re.compile(r"[^a-z0-9]+")

#: Suffixes Shopee (and Tokopedia) use in human-readable sold counts.
#: ``rb``/``ribu`` = ribu = thousand, ``jt``/``juta`` = juta = million,
#: ``m``/``mn`` = million (English-locale builds), ``b``/``miliar``/``milyar``
#: = billion. ``k`` is the English-locale thousand.
_SOLD_SUFFIXES: dict[str, int] = {
    "rb": 1_000,
    "ribu": 1_000,
    "k": 1_000,
    "jt": 1_000_000,
    "juta": 1_000_000,
    "m": 1_000_000,
    "mn": 1_000_000,
    "b": 1_000_000_000,
    "miliar": 1_000_000_000,
    "milyar": 1_000_000_000,
}

# Longest alternatives first so "ribu" is not matched as "rb"-then-junk and
# "juta" is not matched as "jt". ``num`` must both start and end on a digit so a
# trailing separator ("612." ending a sentence) is not swallowed, and the
# trailing ``(?![a-z])`` stops the "k"/"m" suffixes from eating the first letter
# of an ordinary word ("612 kaos" is 612, not 612 000).
_SOLD_RE = re.compile(
    r"(?P<num>\d(?:[\d.,\s]*\d)?)\s*"
    r"(?P<suffix>ribu|rb|juta|jt|milyar|miliar|mn|k|m|b)?(?![a-z])",
    re.IGNORECASE,
)

# "1.000", "5.052.825", "1,000" — a digit group of 1-3 followed by one or more
# groups of exactly 3. That shape is thousands separation, never a decimal.
_GROUPED_NUMBER_RE = re.compile(r"^\d{1,3}(?:[.,]\d{3})+$")

#: Context key that opts a :class:`PriceSnapshot` into micro-unit rescaling.
_PRICE_SCALE_KEY = "price_scale"
_PRICE_SCALE_SHOPEE_MICRO = "shopee_micro"


class RatingOutOfRangeWarning(UserWarning):
    """Emitted when a ``rating_star`` outside 0..5 had to be clamped.

    Its own class (rather than a bare ``UserWarning``) so tests and log filters
    can target it precisely, and so a burst of these in production is an
    unambiguous signal that a marketplace changed its rating scale.
    """


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class Marketplace(str, Enum):
    """Which marketplace a row came from.

    The value (not the member name) is what gets written to the ``marketplace``
    text column in Postgres, so these strings are part of the DB contract and
    must not be renamed.
    """

    SHOPEE = "shopee"
    TOKOPEDIA = "tokopedia"


class RunMode(str, Enum):
    """How a scrape run selected its targets.

    ``KEYWORD`` — the target is a search phrase; the adapter walks search result
    pages. ``STORE`` — the target is a shop username; the adapter walks that
    shop's product listing. Written to ``scrape_runs.mode``.
    """

    KEYWORD = "keyword"
    STORE = "store"


class RunStatus(str, Enum):
    """Terminal (or in-flight) state of a :class:`ScrapeRun`.

    ``RUNNING`` is written by ``store.start_run`` and replaced by
    ``store.finish_run``. ``PARTIAL`` means some targets succeeded and at least
    one raised — the runner continues on error, so this is the normal outcome of
    a multi-target run with one bad target. Written to ``scrape_runs.status``.
    """

    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------


def utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC ``datetime``.

    Single source of truth for "now" across the package so that ``first_seen``,
    ``last_seen`` and ``scraped_at`` in one run share a consistent clock and are
    trivially patchable in tests.

    Returns:
        Timezone-aware ``datetime`` with ``tzinfo`` set to UTC.
    """
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# Text / number helpers
# ---------------------------------------------------------------------------


def _collapse_whitespace(value: str) -> str:
    """Strip a string and collapse every internal whitespace run to one space.

    Also folds the non-breaking spaces Shopee sprinkles through listing titles,
    which would otherwise survive ``str.strip`` and produce two DB rows that look
    identical to a human.
    """
    return _WHITESPACE_RE.sub(" ", value.replace(" ", " ")).strip()


def _clean_optional_text(value: Any) -> Any:
    """Normalise an optional free-text field; empty-after-cleaning becomes None."""
    if not isinstance(value, str):
        return value
    cleaned = _collapse_whitespace(value)
    return cleaned or None


def _clean_required_text(value: Any) -> Any:
    """Normalise a required free-text field, leaving non-strings for pydantic."""
    if not isinstance(value, str):
        return value
    return _collapse_whitespace(value)


def _parse_localized_number(text: str) -> Decimal:
    """Parse a number that may use Indonesian or English digit separators.

    Indonesian formatting uses ``.`` for thousands and ``,`` for the decimal
    point — exactly inverted from English — and Shopee serves both depending on
    the build. Resolution rules, in order:

    1. Both separators present: the *rightmost* one is the decimal point.
    2. A pure grouping shape (``1.000``, ``5.052.825``, ``1,000``): separators
       are thousands markers and are removed.
    3. Otherwise the single separator is a decimal point.

    Args:
        text: Numeric substring, e.g. ``"1,5"``, ``"5.052.825"``, ``"612"``.

    Returns:
        The parsed value.

    Raises:
        ValueError: If ``text`` holds no parseable number.
    """
    cleaned = text.replace(" ", "").replace(" ", "").strip()
    if not cleaned:
        raise ValueError("no numeric content")

    if "." in cleaned and "," in cleaned:
        decimal_sep = "." if cleaned.rfind(".") > cleaned.rfind(",") else ","
        group_sep = "," if decimal_sep == "." else "."
        cleaned = cleaned.replace(group_sep, "").replace(decimal_sep, ".")
    elif _GROUPED_NUMBER_RE.match(cleaned):
        cleaned = cleaned.replace(".", "").replace(",", "")
    else:
        cleaned = cleaned.replace(",", ".")

    try:
        return Decimal(cleaned)
    except (InvalidOperation, DecimalException) as exc:  # pragma: no cover - defensive
        raise ValueError(f"cannot parse number from {text!r}") from exc


def parse_sold(value: str | int | float | Decimal | None) -> int | None:
    """Normalise a Shopee/Tokopedia "units sold" value to a plain integer.

    Shopee reports sold counts three different ways depending on which surface
    served the payload: an exact integer in the JSON API (``sold: 612``), a
    localised abbreviation on the rendered page (``"10RB+"``, ``"1,5RB"``), and
    an English-locale abbreviation on some builds (``"10K+"``). This function
    accepts all of them plus the ``"Terjual "`` ("sold") prefix the page adds.

    Abbreviations are *lower* bounds: ``"10RB+"`` means "at least 10.000", and
    this returns exactly 10.000 rather than inventing precision. Fractional
    results are floored for the same reason.

    Examples::

        parse_sold(612)             -> 612
        parse_sold("10RB+")         -> 10_000
        parse_sold("1,5RB")         -> 1_500
        parse_sold("10K+")          -> 10_000
        parse_sold("Terjual 5rb+")  -> 5_000
        parse_sold("1,2jt")         -> 1_200_000
        parse_sold("5.052.825")     -> 5_052_825
        parse_sold(None)            -> None
        parse_sold("-")             -> None

    Args:
        value: Raw sold value — an int/float/Decimal, a display string, or None.

    Returns:
        Units sold as an int, or None when the value is absent, unparseable, or
        a negative sentinel. A missing number is None, never 0.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, int):
        return value if value >= 0 else None

    if isinstance(value, (float, Decimal)):
        try:
            as_decimal = Decimal(str(value))
        except (InvalidOperation, DecimalException):
            return None
        if not as_decimal.is_finite() or as_decimal < 0:
            return None
        return int(as_decimal.to_integral_value(rounding=ROUND_FLOOR))

    text = str(value).strip()
    if not text:
        return None

    match = _SOLD_RE.search(text)
    if match is None:
        return None

    # "-1" and "-" are Shopee's "not exposed" sentinels; the regex only captures
    # digits, so check the character in front of the match for the sign.
    start = match.start("num")
    if start > 0 and text[start - 1] == "-":
        return None

    try:
        number = _parse_localized_number(match.group("num"))
    except ValueError:
        return None

    suffix = (match.group("suffix") or "").lower()
    total = number * _SOLD_SUFFIXES.get(suffix, 1)
    if total < 0:
        return None
    return int(total.to_integral_value(rounding=ROUND_FLOOR))


def scale_shopee_price(value: int | float | str | Decimal | None) -> Decimal | None:
    """Divide a Shopee integer micro-price down to whole rupiah.

    Shopee ships ``15_290_000_000`` for Rp 152.900 — see
    :data:`SHOPEE_PRICE_DIVISOR` for the proof of the constant. Division is done
    entirely in :class:`~decimal.Decimal` so no binary rounding is introduced
    before the value reaches the ``numeric`` column.

    Args:
        value: Raw micro-unit price, or None.

    Returns:
        Whole-rupiah price, or None when ``value`` is None or is one of Shopee's
        "no price" sentinels (any negative value). A zero micro-price is a
        genuine free/unavailable listing and is returned as ``Decimal(0)``; it is
        the adapter's job to decide whether that means "no price".

    Raises:
        ValueError: If ``value`` is a non-numeric string.
    """
    if value is None:
        return None
    decimal_value = _to_decimal(value)
    if decimal_value is None:
        return None
    if decimal_value < 0:
        return None
    return decimal_value / SHOPEE_PRICE_DIVISOR


def slugify(text: str) -> str:
    """Reduce a listing title to the cosmetic slug segment of a product URL.

    Lowercases, replaces every run of non-alphanumerics with a single ``-``, and
    truncates on a ``-`` boundary. Shopee resolves a product purely on the
    trailing ``-i.<shop_id>.<item_id>``, so the slug never has to be exact.

    Args:
        text: Listing title.

    Returns:
        A URL-safe slug, possibly empty when the title has no alphanumerics.
    """
    slug = _NON_SLUG_RE.sub("-", _collapse_whitespace(text).lower()).strip("-")
    if len(slug) > _MAX_SLUG_LENGTH:
        slug = slug[:_MAX_SLUG_LENGTH].rsplit("-", 1)[0].strip("-") or slug[:_MAX_SLUG_LENGTH]
    return slug


def build_product_url(
    marketplace: Marketplace,
    item_id: int,
    shop_id: int,
    name: str | None = None,
    username: str | None = None,
) -> str:
    """Construct a canonical product URL from the identifying fields.

    Shopee: ``https://shopee.co.id/{slug}-i.{shop_id}.{item_id}``. When the title
    has no usable slug this degrades to the equally valid numeric form
    ``https://shopee.co.id/product/{shop_id}/{item_id}``.

    Tokopedia: ``https://www.tokopedia.com/{username}/{slug}``. Tokopedia URLs
    are *not* id-addressable, so ``username`` is required there; without it this
    falls back to the id-based Shopee-style path, which is wrong-but-inert and
    better than raising inside a validator.

    Args:
        marketplace: Which marketplace the listing belongs to.
        item_id: Marketplace item id.
        shop_id: Marketplace shop id.
        name: Listing title, used only for the cosmetic slug.
        username: Shop slug. Required for a correct Tokopedia URL, unused by
            Shopee (whose URLs address the shop numerically).

    Returns:
        An absolute product URL.
    """
    base = MARKETPLACE_BASE_URL.get(
        marketplace.value if isinstance(marketplace, Marketplace) else str(marketplace),
        MARKETPLACE_BASE_URL["shopee"],
    )
    slug = slugify(name) if name else ""

    if marketplace == Marketplace.TOKOPEDIA and username:
        shop_slug = slugify(username) or str(shop_id)
        return f"{base}/{shop_slug}/{slug}" if slug else f"{base}/{shop_slug}"

    if slug:
        return f"{base}/{slug}-i.{shop_id}.{item_id}"
    return f"{base}/product/{shop_id}/{item_id}"


def _to_decimal(value: Any) -> Decimal | None:
    """Coerce a raw JSON scalar to Decimal without ever going through float.

    Floats are stringified first so ``4.83`` becomes ``Decimal("4.83")`` rather
    than the 17-digit binary approximation.

    Returns:
        The value as a Decimal, or None for None / blank / non-finite input.

    Raises:
        ValueError: If the value is a non-numeric string or an unsupported type.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("boolean is not a valid numeric value")
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, int):
        result = Decimal(value)
    elif isinstance(value, float):
        result = Decimal(str(value))
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            result = _parse_localized_number(text)
        except ValueError as exc:
            raise ValueError(f"not a number: {value!r}") from exc
    else:
        raise ValueError(f"unsupported numeric type: {type(value).__name__}")

    if not result.is_finite():
        return None
    return result


def _validate_price(value: Any, info: ValidationInfo) -> Any:
    """Shared ``mode="before"`` validator for every money field.

    Coerces to Decimal, optionally applies :data:`SHOPEE_PRICE_DIVISOR` when the
    caller opted in via validation context, and rejects negatives.
    """
    decimal_value = _to_decimal(value)
    if decimal_value is None:
        return None

    context = info.context or {}
    if context.get(_PRICE_SCALE_KEY) == _PRICE_SCALE_SHOPEE_MICRO:
        decimal_value = decimal_value / SHOPEE_PRICE_DIVISOR

    if decimal_value < 0:
        raise ValueError(
            f"{info.field_name} must not be negative (got {decimal_value}); "
            "Shopee uses negative values as a 'no price' sentinel — map it to None "
            "in the adapter instead of persisting it"
        )
    return decimal_value


def _validate_rating(value: Any, info: ValidationInfo) -> Any:
    """Shared ``mode="before"`` validator clamping a star rating into 0..5."""
    decimal_value = _to_decimal(value)
    if decimal_value is None:
        return None

    if decimal_value < 0:
        warnings.warn(
            f"{info.field_name}={decimal_value} is below 0; clamping to 0",
            RatingOutOfRangeWarning,
            stacklevel=2,
        )
        return Decimal(0)
    if decimal_value > MAX_RATING_STAR:
        warnings.warn(
            f"{info.field_name}={decimal_value} is above {MAX_RATING_STAR}; "
            f"clamping to {MAX_RATING_STAR} (did the marketplace change its rating scale?)",
            RatingOutOfRangeWarning,
            stacklevel=2,
        )
        return MAX_RATING_STAR
    return decimal_value


def _validate_count(value: Any) -> Any:
    """Shared ``mode="before"`` validator for sold/stock/rating-count integers.

    Routes display strings through :func:`parse_sold` so ``"10RB+"`` is accepted
    anywhere a count is accepted, and maps negative sentinels to None.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("boolean is not a valid count")
    if isinstance(value, str):
        return parse_sold(value)
    if isinstance(value, (int, float, Decimal)):
        return parse_sold(value)
    return value


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class Store(BaseModel):
    """A seller/shop on a marketplace.

    Natural key is ``(marketplace, shop_id)``, matching the unique constraint on
    the ``stores`` table. ``username`` is the human-facing slug used in URLs
    (``https://shopee.co.id/<username>``) and is what ``config/stores.txt``
    contains — it is *not* stable enough to be the key, since sellers can rename
    themselves, but it is one of the five required output fields.
    """

    model_config = ConfigDict(extra="forbid")

    marketplace: Marketplace = Field(description="Which marketplace this shop lives on.")
    shop_id: int = Field(description="Marketplace's own numeric shop id (64-bit).")
    username: str = Field(description="URL slug / seller handle. Required output field #1.")
    name: str | None = Field(default=None, description="Display name of the shop.")
    location: str | None = Field(default=None, description="Seller location, e.g. 'JAKARTA BARAT'.")
    follower_count: int | None = Field(default=None, description="Follower count, if exposed.")
    rating_star: Decimal | None = Field(
        default=None, description="Shop-level average rating, 0..5. Not the product rating."
    )
    first_seen: datetime | None = Field(
        default=None,
        description="UTC time this shop was first inserted. Set by the repository on insert.",
    )
    last_seen: datetime | None = Field(
        default=None,
        description="UTC time this shop was last observed. Bumped by the repository on upsert.",
    )

    @field_validator("username", mode="before")
    @classmethod
    def _clean_username(cls, value: Any) -> Any:
        """Strip whitespace, a leading ``@``, and a full profile URL down to the slug."""
        if not isinstance(value, str):
            return value
        cleaned = _collapse_whitespace(value).lstrip("@")
        if "://" in cleaned:
            cleaned = cleaned.rstrip("/").rsplit("/", 1)[-1]
        return cleaned

    @field_validator("name", "location", mode="before")
    @classmethod
    def _clean_text(cls, value: Any) -> Any:
        return _clean_optional_text(value)

    @field_validator("follower_count", mode="before")
    @classmethod
    def _clean_follower_count(cls, value: Any) -> Any:
        return _validate_count(value)

    @field_validator("rating_star", mode="before")
    @classmethod
    def _clean_rating(cls, value: Any, info: ValidationInfo) -> Any:
        return _validate_rating(value, info)


class Product(BaseModel):
    """A listing on a marketplace.

    Natural key is ``(marketplace, item_id)``, matching the unique constraint on
    the ``products`` table. Holds only the *slow-changing* attributes of a
    listing; everything that moves (price, stock, sold, rating) belongs on
    :class:`PriceSnapshot` so the same product accumulates a time series.

    ``url`` is auto-constructed from ``name``/``shop_id``/``item_id`` when the
    payload did not carry one, so it is never None for Shopee. Tokopedia URLs
    need the shop username, which this model does not hold — use
    :meth:`ensure_url` to fill those in.
    """

    model_config = ConfigDict(extra="forbid")

    marketplace: Marketplace = Field(description="Which marketplace this listing lives on.")
    item_id: int = Field(description="Marketplace's own numeric item id (64-bit).")
    shop_id: int = Field(
        description="Owning shop's marketplace id — matches Store.shop_id, NOT stores.id."
    )
    name: str = Field(description="Listing title. Required output field #2.")
    url: str | None = Field(default=None, description="Canonical product URL.")
    image: str | None = Field(default=None, description="Absolute URL of the primary image.")
    category: str | None = Field(default=None, description="Category label, if resolvable.")
    first_seen: datetime | None = Field(
        default=None, description="UTC time first inserted. Set by the repository on insert."
    )
    last_seen: datetime | None = Field(
        default=None, description="UTC time last observed. Bumped by the repository on upsert."
    )

    @field_validator("name", mode="before")
    @classmethod
    def _clean_name(cls, value: Any) -> Any:
        return _clean_required_text(value)

    @field_validator("url", "image", "category", mode="before")
    @classmethod
    def _clean_text(cls, value: Any) -> Any:
        return _clean_optional_text(value)

    @model_validator(mode="after")
    def _fill_url(self) -> Product:
        """Construct ``url`` from the ids when the payload did not supply one.

        Skipped for Tokopedia, whose URLs are slug-addressed and need the shop
        username this model does not carry — call :meth:`ensure_url` there.
        """
        if self.url is None and self.marketplace == Marketplace.SHOPEE:
            self.url = build_product_url(
                self.marketplace, self.item_id, self.shop_id, name=self.name
            )
        return self

    def ensure_url(self, username: str | None = None) -> Product:
        """Return a copy with ``url`` populated, using ``username`` when needed.

        Idempotent: a Product that already has a URL is returned unchanged. This
        is the hook a Tokopedia adapter uses once it knows the shop slug, and it
        is safe to call on Shopee products too.

        Args:
            username: Shop URL slug, required to build a correct Tokopedia URL.

        Returns:
            ``self`` if ``url`` was already set, else a copy with ``url`` filled.
        """
        if self.url is not None:
            return self
        return self.model_copy(
            update={
                "url": build_product_url(
                    self.marketplace,
                    self.item_id,
                    self.shop_id,
                    name=self.name,
                    username=username,
                )
            }
        )


class PriceSnapshot(BaseModel):
    """One point-in-time observation of a listing's volatile fields.

    Append-only: never updated, one row per (product, scrape). This is the table
    that turns the scraper into a price/velocity tracker — diffing consecutive
    snapshots for a ``product_ref`` gives price movement and units sold between
    scrapes.

    ``item_id`` is carried here (rather than a DB ref) so an adapter can build a
    snapshot without touching the database; ``store.insert_snapshot`` resolves it
    to ``products.id`` and writes that into ``price_snapshots.product_ref``.

    Prices must already be in whole rupiah. If you are holding raw Shopee
    micro-units, use :meth:`from_shopee_micro` rather than dividing by hand —
    plain construction deliberately does **not** rescale, so an adapter that
    already called ``to_rupiah`` cannot double-scale.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: int = Field(
        description="Marketplace item id this observation belongs to — matches Product.item_id."
    )
    price: Decimal | None = Field(
        default=None,
        description=(
            "Current effective price in whole rupiah. Required output field #3. For listings "
            "with variations this is the representative/lowest price; see price_min/price_max."
        ),
    )
    price_min: Decimal | None = Field(
        default=None, description="Lowest variation price in whole rupiah."
    )
    price_max: Decimal | None = Field(
        default=None, description="Highest variation price in whole rupiah."
    )
    stock: int | None = Field(default=None, description="Units currently available.")
    sold: int | None = Field(
        default=None,
        description="Units sold in the marketplace's recent window (Shopee: ~30 days). "
        "Required output field #4.",
    )
    historical_sold: int | None = Field(
        default=None, description="Lifetime units sold, if exposed."
    )
    rating_star: Decimal | None = Field(
        default=None,
        description="Product average rating, 0..5. Required output field #5. "
        "Distinct from Store.rating_star.",
    )
    rating_count: int | None = Field(
        default=None, description="Number of ratings the average is computed over."
    )
    scraped_at: datetime | None = Field(
        default_factory=utcnow,
        description="UTC observation time. Defaults to now; the repository may override it "
        "so every snapshot in one target shares a clock.",
    )

    @field_validator("price", "price_min", "price_max", mode="before")
    @classmethod
    def _clean_price(cls, value: Any, info: ValidationInfo) -> Any:
        return _validate_price(value, info)

    @field_validator("rating_star", mode="before")
    @classmethod
    def _clean_rating(cls, value: Any, info: ValidationInfo) -> Any:
        return _validate_rating(value, info)

    @field_validator("stock", "sold", "historical_sold", "rating_count", mode="before")
    @classmethod
    def _clean_counts(cls, value: Any) -> Any:
        return _validate_count(value)

    @field_validator("scraped_at", mode="after")
    @classmethod
    def _require_utc(cls, value: datetime | None) -> datetime | None:
        """Force every timestamp to timezone-aware UTC.

        A naive datetime is assumed to be UTC rather than rejected — the failure
        mode of rejecting is a lost snapshot, the failure mode of assuming is a
        correctly-ordered time series, and everything in this project writes UTC.
        """
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    @classmethod
    def from_shopee_micro(cls, **fields: Any) -> PriceSnapshot:
        """Build a snapshot from raw Shopee values, dividing prices by the divisor.

        Opt-in counterpart to plain construction: ``price``, ``price_min`` and
        ``price_max`` are divided by :data:`SHOPEE_PRICE_DIVISOR` on the way in.
        Every other field behaves exactly as in ``__init__``.

        Example::

            PriceSnapshot.from_shopee_micro(item_id=1, price=15_290_000_000)
            # -> price == Decimal("152900")

        Args:
            **fields: Field values, with money fields still in micro-units.

        Returns:
            A validated PriceSnapshot with prices in whole rupiah.

        Raises:
            pydantic.ValidationError: On a negative price or any other invalid field.
        """
        return cls.model_validate(
            fields, context={_PRICE_SCALE_KEY: _PRICE_SCALE_SHOPEE_MICRO}
        )


class ScrapeRun(BaseModel):
    """Audit record for one target within one invocation of the runner.

    The runner writes one ``ScrapeRun`` **per target** (per keyword, or per shop
    username), not one per CLI invocation — that way a single bad keyword shows
    up as one FAILED row without hiding the successful ones.
    """

    model_config = ConfigDict(extra="forbid")

    id: int | None = Field(
        default=None, description="Database primary key. None until start_run inserts it."
    )
    marketplace: Marketplace = Field(description="Marketplace scraped.")
    mode: RunMode = Field(description="keyword or store.")
    target: str = Field(description="The keyword searched, or the shop username walked.")
    started_at: datetime | None = Field(default=None, description="UTC start time.")
    finished_at: datetime | None = Field(
        default=None, description="UTC finish time. None while status is RUNNING."
    )
    status: RunStatus = Field(default=RunStatus.RUNNING, description="Current run state.")
    item_count: int = Field(default=0, description="Snapshots persisted for this target.")
    error: str | None = Field(
        default=None, description="Exception repr when status is FAILED, else None."
    )

    @field_validator("target", mode="before")
    @classmethod
    def _clean_target(cls, value: Any) -> Any:
        return _clean_required_text(value)

    @field_validator("error", mode="before")
    @classmethod
    def _clean_error(cls, value: Any) -> Any:
        """Accept an exception object as well as a string; keep newlines intact.

        Unlike the other text fields this only strips the ends — collapsing
        internal whitespace would flatten a traceback into one unreadable line.
        """
        if value is None:
            return None
        if isinstance(value, BaseException):
            return repr(value)
        if isinstance(value, str):
            return value.strip() or None
        return repr(value)

    @field_validator("started_at", "finished_at", mode="after")
    @classmethod
    def _require_utc(cls, value: datetime | None) -> datetime | None:
        """Force run timestamps to timezone-aware UTC (naive input assumed UTC)."""
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class ScrapedItem(NamedTuple):
    """One fully-denormalised scraped listing — what an adapter returns.

    A NamedTuple so ``for store, product, snapshot in adapter.search_keyword(...)``
    unpacks positionally, and so it stays hashable and immutable while crossing
    module boundaries.

    ``store`` is optional because keyword-search payloads sometimes carry only a
    ``shopid`` with no resolvable shop record; the runner persists the product
    and snapshot anyway and backfills ``products.shop_ref`` on a later scrape
    that does know the shop.

    .. note::
       :mod:`scraper.adapters` currently declares its own structurally identical
       ``ScrapedItem``. This one is the canonical definition — ``adapters``
       should ``from scraper.models import ScrapedItem`` and re-export rather
       than redeclare, so ``isinstance`` checks agree across the package.

    Attributes:
        store: The owning shop, or None when the payload had no shop detail.
            Carries required output field #1 (``username``).
        product: The listing. Carries required output field #2 (``name``).
        snapshot: The volatile observation. Carries required output fields
            #3 ``price``, #4 ``sold`` and #5 ``rating_star``.
    """

    store: Store | None
    product: Product
    snapshot: PriceSnapshot
