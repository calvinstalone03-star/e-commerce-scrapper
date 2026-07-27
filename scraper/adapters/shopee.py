"""Shopee Indonesia adapter — all Shopee-specific knowledge lives in this file.

Nothing outside this module may know Shopee's payload shapes. If a downstream
module needs a field, it gets it as a populated attribute on a
:class:`scraper.models.Product` / :class:`scraper.models.PriceSnapshot`, not as
a dict key.

Endpoints used (paths relative to ``https://shopee.co.id``):

======================================  ================================================
``/api/v4/search/search_items``         Keyword search. Params: ``keyword``, ``limit``
                                        (60), ``newest`` (offset), ``by=relevancy``,
                                        ``order=desc``, ``page_type=search``,
                                        ``scenario=PAGE_GLOBAL_SEARCH``, ``version=2``.
``/api/v4/shop/get_shop_detail``        Username -> shop metadata. Param: ``username``.
``/api/v4/shop/get_shop_base``          Same, older name. Used only as a fallback.
``/api/v4/recommend/recommend``         Shop listing. Params: ``bundle=shop_page_
                                        category_tab_main``, ``shopid``, ``limit`` (30),
                                        ``offset``.
``/api/v4/shop/rcmd_items``             Shop listing, modern shop-page variant. Params:
                                        ``shop_id`` (underscore!), ``limit``, ``offset``.
``/api/v4/shop/get_shop_seo``           Shop listing, SEO side door. Param: ``shopid``.
                                        Unpaginated, bounded item set.
======================================  ================================================

Reality check, from ``.recon`` (2026-07-27, logged out, from a residential IP):

* ``get_shop_detail`` returned **200 with real data** — verified from both plain
  httpx and a real browser.
* ``get_shop_seo`` returned **200 with a real ``items[]`` array** — verified from
  a real browser. It is the only listing surface that answered at all.
* ``search_items``, ``rcmd_items``, ``pdp/get_pc`` and ``shop/get_shop_tab`` all
  returned the anti-bot envelope ``{"error": 90309999, ...}`` — a 403 from httpx
  and a 200-with-error body from the browser. A genuine Chromium carrying every
  one of Shopee's own JS-generated signing headers was refused just the same, so
  the gate is the logged-out session, not header fidelity.

That is why every listing path below is a *strategy* rather than a hard-coded
call: :meth:`ShopeeAdapter.search_shop` walks them in order, tolerates a block on
any one of them, and only fails the target when all of them are blocked. It also
means the field map for search-only fields (per-item rating, per-item location)
is **documented but unverified** — hence the uniformly defensive ``.get()``
traversal in :func:`parse_item`. A shape change degrades a field to ``None``; it
never raises past the single item it belongs to.

Payload conventions this module is responsible for absorbing:

* **Prices are integer micro-units** — divide by ``PRICE_DIVISOR`` (100_000) to
  get whole rupiah. ``price``, ``price_min``, ``price_max`` all need it. Verified
  against a real capture: ``15_290_000_000`` -> Rp 152.900, cross-checked against
  the same payload's ``price_before_discount`` and its ``"discount": "-69%"``.
* **Ratings arrive as ``item_rating``** — ``{"rating_star": 4.83, "rating_count":
  [total, n1, n2, n3, n4, n5]}``. The count we store is ``rating_count[0]``.
* **Item envelopes vary** — search returns ``item_basic`` per entry, the
  recommend and SEO endpoints return the fields inline. :func:`parse_item`
  normalises both, which is why it takes a raw dict rather than a typed structure.
* **Sold counts may be redacted to a display bucket** — an exact ``612`` from one
  endpoint and a ``"1RB+"`` string from another. :func:`parse_sold` accepts both.
* **Shop detail is sparse in search results** — a search hit gives ``shopid``
  and often ``shop_location`` but rarely a username. Build the best Store you
  can and let ``store.upsert_store`` avoid clobbering better data scraped later.
* A missing/None numeric field means "not exposed", not zero. Leave it None.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any, NamedTuple
from urllib.parse import quote, urlparse

from scraper.adapters import ScrapedItem
from scraper.client import (
    BlockedError,
    ScraperHTTPError,
    ShopeeClient,
    has_v4_error,
    is_soft_block,
)
from scraper.models import (
    MARKETPLACE_BASE_URL,
    SHOPEE_PRICE_DIVISOR,
    Marketplace,
    PriceSnapshot,
    Product,
    Store,
    parse_sold,
    scale_shopee_price,
)
from scraper.models import build_product_url as _model_product_url

__all__ = [
    "ShopeeAdapter",
    "PRICE_DIVISOR",
    "SEARCH_PAGE_SIZE",
    "SHOP_PAGE_SIZE",
    "IMAGE_CDN_BASE",
    "SITE_BASE",
    "parse_item",
    "parse_shop",
    "parse_rating",
    "parse_sold_field",
    "to_rupiah",
    "build_product_url",
    "build_image_url",
    "normalise_username",
    "placeholder_username",
    "is_placeholder_username",
    "ParseStats",
    "PageVerdict",
    "classify_payload",
]

log = logging.getLogger(__name__)


class ParseStats(NamedTuple):
    """How a search call's raw payload entries fared through :func:`parse_item`.

    Exists so that the three genuinely different ways a call can end with zero
    items stop looking identical downstream. All three are worth telling apart,
    and each has a different owner:

    ============== ==================================== ======================
    State          How it is recognised                 What the runner records
    ============== ==================================== ======================
    **BLOCKED**    :func:`classify_payload` returns     FAILED — the walk
                   :attr:`PageVerdict.BLOCKED` and the  raises
                   walk raises, so *these stats are     :class:`~scraper.client.BlockedError`
                   never consulted*. They stay          before returning.
                   ``(0, 0, 0)``, i.e. not drifted.
    **empty**      ``raw_seen == 0`` and ``parsed ==    SUCCESS with 0 items.
                   0``: a 200 with ``"error": 0`` and
                   an empty item list.
    **drift**      ``raw_seen > 0`` and ``parsed ==     PARTIAL, with the
                   0``: entries arrived, none of them   drift message.
                   parsed — a renamed field.
    ============== ==================================== ======================

    The middle column is the whole contract: BLOCKED is kept out of these
    numbers deliberately, because a block that reached here as ``(0, 0, 0)``
    would be indistinguishable from an honestly empty shop, which is exactly the
    silent-zero failure this type was introduced to end.

    Attributes:
        raw_seen: Entries :func:`_extract_items` recognised as listings.
        parsed: Entries that became a :class:`ScrapedItem`.
        skipped: Entries dropped as malformed, plus duplicates within the call.
    """

    raw_seen: int
    parsed: int
    skipped: int

    @property
    def drifted(self) -> bool:
        """True when the endpoint returned entries but none of them parsed.

        Returns:
            Whether this looks like a schema change rather than an empty result.
        """
        return self.raw_seen > 0 and self.parsed == 0

    @property
    def empty(self) -> bool:
        """True when the endpoint genuinely returned nothing to parse.

        Distinct from :attr:`drifted` (entries arrived and were unusable) and
        from a block (which never reaches these stats at all).

        Returns:
            Whether this call saw no listing entries whatsoever.
        """
        return self.raw_seen == 0


class PageVerdict(Enum):
    """What one decoded listing page actually is.

    Three states, deliberately not two. A 200 OK from Shopee can be any of them
    and they have nothing in common but their status line:

    * :attr:`USABLE` — parse it. It may hold zero items; an ``"error": 0``
      envelope with an empty list is a *successful* empty answer and must be
      recorded as SUCCESS.
    * :attr:`BLOCKED` — Shopee refused us. The 119-byte
      ``{"error": 90309999, ...}`` body arrives with **HTTP 200**, so nothing but
      the payload distinguishes it from an empty page. It must fail the target,
      never end pagination as "no more items".
    * :attr:`ERROR` — some other non-zero ``error`` (``{"error": 4, "error_msg":
      "shop not found"}``). Not a block, still not data: zero rows here are
      unknown, not observed.
    """

    USABLE = "usable"
    BLOCKED = "blocked"
    ERROR = "error"


def classify_payload(payload: Any) -> PageVerdict:
    """Decide which of the three :class:`PageVerdict` states a body is in.

    Delegates the block rule to :func:`scraper.client.is_soft_block` rather than
    re-deriving it, so the adapter and the transport can never disagree about
    what a block looks like — a disagreement would mean one layer counting a
    refusal as data. Bodies reach the adapter only through
    :meth:`scraper.client.ShopeeClient.get_json`, which returns exclusively
    sub-400 responses, so the "success status" precondition of
    :func:`~scraper.client.is_soft_block` always holds here.

    Args:
        payload: Decoded JSON body.

    Returns:
        The verdict for this page.
    """
    if not isinstance(payload, Mapping):
        return PageVerdict.ERROR
    if is_soft_block(payload):
        return PageVerdict.BLOCKED
    if has_v4_error(payload):
        return PageVerdict.ERROR
    return PageVerdict.USABLE


#: Alias of :data:`scraper.models.SHOPEE_PRICE_DIVISOR`, kept because this
#: module's public surface names it ``PRICE_DIVISOR``. There is exactly one
#: value; do not redefine it here.
PRICE_DIVISOR = SHOPEE_PRICE_DIVISOR
SEARCH_PAGE_SIZE = 60
SHOP_PAGE_SIZE = 30

SITE_BASE = MARKETPLACE_BASE_URL["shopee"]
IMAGE_CDN_BASE = "https://down-id.img.susercontent.com/file/"

SEARCH_PATH = "/api/v4/search/search_items"
SHOP_DETAIL_PATH = "/api/v4/shop/get_shop_detail"
SHOP_BASE_PATH = "/api/v4/shop/get_shop_base"
SHOP_ITEMS_PATH = "/api/v4/recommend/recommend"
SHOP_RCMD_PATH = "/api/v4/shop/rcmd_items"
SHOP_SEO_PATH = "/api/v4/shop/get_shop_seo"

#: Prefix for the synthetic username :func:`parse_item` invents when a payload
#: carries a ``shopid`` but no slug (every keyword-search hit). ``Store.username``
#: is a required field, so *something* must be there; this makes the placeholder
#: recognisable rather than silently wrong. See
#: :meth:`ShopeeAdapter.resolve_username` for how it gets replaced by the real one.
PLACEHOLDER_USERNAME_PREFIX = "shop-"

#: Shopee's "you are not a trusted client" code. Seen as a 403 body from httpx
#: (``.recon/A_search_kaos_polos.json``) and as a **119-byte HTTP 200 body** from
#: a real logged-out browser (``.recon/browser_capture.json`` #6 and #27), so the
#: adapter classifies payloads independently of whatever the status code said.
#:
#: Used for *naming* the refusal in logs only. Detection itself is the general
#: rule in :func:`scraper.client.is_soft_block`, so a renumbered refusal is still
#: caught — see :data:`scraper.client.BLOCK_ERROR_CODES`.
ANTIBOT_ERROR_CODE = 90309999

#: Keys a bucketed sold-count dict hides its number under, in preference order.
_SOLD_DISPLAY_KEYS = (
    "sold_count",
    "sold_count_text",
    "historical_sold_count",
    "text",
    "value",
    "count",
)


# --------------------------------------------------------------------------- #
# Scalar coercion helpers
# --------------------------------------------------------------------------- #


def _as_int(value: Any) -> int | None:
    """Coerce a payload value to ``int``, or ``None`` when it is not a number.

    Tolerates the string ints Shopee occasionally emits for 64-bit ids and the
    floats that ride in on JSON numbers.

    Args:
        value: Raw payload value.

    Returns:
        The integer value, or None when absent/blank/unparseable.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str):
        text = value.strip().replace("_", "")
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            try:
                return int(float(text))
            except ValueError:
                return None
    return None


def _as_decimal(value: Any) -> Decimal | None:
    """Coerce a payload value to ``Decimal`` without going through binary float.

    Args:
        value: Raw payload value.

    Returns:
        The decimal value, or None when absent/unparseable.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return Decimal(text)
        except (InvalidOperation, ValueError):
            return None
    return None


def _as_text(value: Any) -> str | None:
    """Coerce a payload value to a non-empty stripped ``str``, else ``None``.

    Args:
        value: Raw payload value.

    Returns:
        The trimmed string, or None when absent or blank.
    """
    if value is None or isinstance(value, (dict, list, tuple)):
        return None
    text = str(value).strip()
    return text or None


def _first(raw: Mapping[str, Any], *keys: str) -> Any:
    """Return the first present, non-None value among ``keys``.

    Shopee renames the same datum across endpoints (``shopid``/``shop_id``,
    ``itemid``/``item_id``), so nearly every read goes through this.

    Args:
        raw: Mapping to read from.
        *keys: Candidate keys, in preference order.

    Returns:
        The first non-None value, or None when no key is present.
    """
    for key in keys:
        value = raw.get(key)
        if value is not None:
            return value
    return None


def _dig(raw: Any, *path: str | int) -> Any:
    """Walk a nested payload without raising on a missing or retyped level.

    Args:
        raw: Root object.
        *path: Mapping keys and/or sequence indices to follow.

    Returns:
        The value at ``path``, or None if any level is absent or the wrong type.
    """
    node = raw
    for step in path:
        if isinstance(step, int):
            if not isinstance(node, Sequence) or isinstance(node, (str, bytes)):
                return None
            if step >= len(node) or step < -len(node):
                return None
            node = node[step]
        else:
            if not isinstance(node, Mapping):
                return None
            node = node.get(step)
        if node is None:
            return None
    return node


# --------------------------------------------------------------------------- #
# Field parsers
# --------------------------------------------------------------------------- #


def to_rupiah(micro: int | float | str | Decimal | None) -> Decimal | None:
    """Convert a Shopee integer micro-price to whole rupiah.

    Shopee reports ``2_500_000_000`` for Rp 25.000. The division itself is
    :func:`scraper.models.scale_shopee_price`, so the divisor has exactly one
    implementation in the package; what this adds is the *sentinel* rule, which
    is Shopee-specific and so belongs here rather than in the models layer.

    Args:
        micro: Raw price value from the payload, or None.

    Returns:
        The price in whole rupiah, or None when ``micro`` is None or is a
        sentinel Shopee uses for "no price". Negative values are the documented
        sentinel on variant listings; ``0`` is treated the same way, because
        Shopee has no genuinely free listings and a zero micro-price in the wild
        means "not exposed on this envelope, look at ``price_min``". This is a
        deliberate narrowing of :func:`~scraper.models.scale_shopee_price`,
        which returns ``Decimal(0)`` for 0 and leaves the reading to the adapter.
    """
    value = _as_decimal(micro)
    if value is None:
        return None
    scaled = scale_shopee_price(value)
    if scaled is None or scaled <= 0:
        return None
    return scaled


def parse_sold_field(value: Any) -> int | None:
    """Normalise a units-sold value, including the display-dict envelope.

    :func:`scraper.models.parse_sold` already handles exact integers and the
    redacted display strings (``"1RB+"``, ``"10k+"``, ``"1,2jt"``,
    ``"Terjual 5rb+"``), and owns the "a bucket resolves to its lower bound"
    rule. Newer Shopee item cards wrap the same datum in a small object —
    ``{"sold_count_text": "1RB+ terjual"}`` — so this unwraps that first and then
    delegates, rather than reimplementing the parsing.

    Args:
        value: Raw payload value — int, float, str, or a display dict.

    Returns:
        Units sold as a non-negative int, or None when absent/unparseable.
    """
    if isinstance(value, Mapping):
        return parse_sold_field(_first(value, *_SOLD_DISPLAY_KEYS))
    if isinstance(value, (list, tuple, set)):
        return None
    try:
        return parse_sold(value)
    except (ValueError, TypeError, ArithmeticError):
        return None


def parse_rating(raw: Mapping[str, Any]) -> tuple[Decimal | None, int | None]:
    """Pull ``(rating_star, rating_count)`` out of an item payload.

    Handles the canonical ``item_rating`` envelope
    (``{"rating_star": 4.83, "rating_count": [total, n1..n5]}``), the flattened
    ``rating_star`` / ``rating_count`` pair, and the case where ``rating_count``
    is a bare int rather than the per-star histogram. Returns ``(None, None)``
    when the endpoint does not expose ratings at all — which is what the
    verified ``get_shop_seo`` listing does.

    A star of ``0`` backed by a rating count of ``0`` (or none at all) is read as
    "no ratings yet" and returned as ``None``, not as a zero-star rating.

    Values are coerced but deliberately **not** range-checked here: an
    out-of-range star is clamped by :class:`~scraper.models.PriceSnapshot`, which
    emits a :class:`~scraper.models.RatingOutOfRangeWarning` while doing so.
    Dropping it silently here would suppress that warning. Non-numeric junk still
    degrades to None, so a retyped field cannot fail the whole item.

    Args:
        raw: An already-unwrapped item payload.

    Returns:
        A ``(rating_star, rating_count)`` pair, either element possibly None.
    """
    rating = raw.get("item_rating")
    if not isinstance(rating, Mapping):
        rating = raw.get("rating") if isinstance(raw.get("rating"), Mapping) else {}

    star = _as_decimal(_first(rating, "rating_star", "star", "rating"))
    if star is None:
        star = _as_decimal(_first(raw, "rating_star", "item_rating_star"))

    counts = _first(rating, "rating_count", "count")
    if counts is None:
        counts = raw.get("rating_count")

    count: int | None
    if isinstance(counts, Sequence) and not isinstance(counts, (str, bytes)):
        count = _as_int(counts[0]) if counts else None
    else:
        count = _as_int(counts)
    if count is not None and count < 0:
        count = None

    # "Never reviewed" and "reviewed, and the average is 0.0" are different facts
    # and Shopee spells both `"rating_star": 0`. The rating count disambiguates:
    # a 0 with no ratings behind it is an absent measurement, so it degrades to
    # None per this module's rule that a missing numeric means "not exposed", not
    # zero. Without this, every unreviewed listing sorts below a genuine 1-star
    # product, drags each shop's AVG(rating_star) toward zero, and is silently
    # excluded by a "rating >= 4" filter.
    if star is not None and star == 0 and not count:
        star = None

    return star, count


def placeholder_username(shop_id: int) -> str:
    """Build the synthetic slug used when a payload exposes no real username.

    Args:
        shop_id: Marketplace shop id.

    Returns:
        A recognisable placeholder, e.g. ``"shop-30203584"``.
    """
    return f"{PLACEHOLDER_USERNAME_PREFIX}{shop_id}"


def is_placeholder_username(username: str | None) -> bool:
    """Whether a username is one this module invented rather than scraped.

    The runner uses this to decide a Store is worth enriching, and
    ``store.upsert_store`` to avoid overwriting a real slug with a synthetic one.

    Args:
        username: Username to test.

    Returns:
        True when the value is a :func:`placeholder_username` product.
    """
    return bool(username) and str(username).startswith(PLACEHOLDER_USERNAME_PREFIX)


def normalise_username(username: str) -> str:
    """Reduce whatever the user pasted to a bare shop slug.

    Accepts ``erigostore``, ``@erigostore``, ``shopee.co.id/erigostore`` and
    ``https://shopee.co.id/erigostore?smtt=1``.

    Args:
        username: Raw slug, handle or profile URL.

    Returns:
        The bare slug.

    Raises:
        ValueError: If nothing slug-like remains.
    """
    text = (username or "").strip()
    if not text:
        raise ValueError("shop username is empty")

    if "://" in text or text.lower().startswith("shopee."):
        candidate = text if "://" in text else f"https://{text}"
        path = urlparse(candidate).path
        text = path.strip("/").split("/")[-1] if path.strip("/") else ""

    text = text.split("?")[0].split("#")[0].strip().lstrip("@").strip("/")
    if not text:
        raise ValueError(f"could not extract a shop username from {username!r}")
    return text


def build_product_url(name: str, shop_id: int, item_id: int) -> str:
    """Construct the canonical Shopee product URL.

    Format: ``https://shopee.co.id/{slug}-i.{shop_id}.{item_id}`` where ``slug``
    is the listing name lowercased with non-alphanumerics collapsed to ``-``.
    The slug is cosmetic — Shopee resolves on the numeric suffix alone — so an
    imperfect slug is acceptable, but the numeric suffix must be exact.

    Delegates to :func:`scraper.models.build_product_url`; this wrapper exists
    only to keep the Shopee-flavoured ``(name, shop_id, item_id)`` argument order
    that the rest of this module reads with, and so that
    :class:`~scraper.models.Product`'s own URL auto-fill and this call can never
    disagree about the slug.

    Args:
        name: Listing title.
        shop_id: Marketplace shop id.
        item_id: Marketplace item id.

    Returns:
        An absolute product URL.
    """
    return _model_product_url(Marketplace.SHOPEE, item_id, shop_id, name=name)


def build_image_url(image: Any) -> str | None:
    """Turn Shopee's opaque image hash into an absolute CDN URL.

    Payloads carry ``"image": "id-11134201-7rbkc-m7umx9q1utm11c"`` — a hash, not
    a URL. The ``down-id`` host is the Indonesian edge for
    ``susercontent.com``. An already-absolute URL is passed through untouched.

    Args:
        image: Image hash, absolute URL, or None.

    Returns:
        An absolute image URL, or None when no hash was present.
    """
    text = _as_text(image)
    if text is None:
        return None
    if text.startswith(("http://", "https://")):
        return text
    if text.startswith("//"):
        return f"https:{text}"
    return f"{IMAGE_CDN_BASE}{text.lstrip('/')}"


# --------------------------------------------------------------------------- #
# Payload parsers
# --------------------------------------------------------------------------- #


def unwrap_item(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    """Strip the per-entry envelope search results wrap items in.

    ``search_items`` yields ``{"item_basic": {...}, "adsid": ...}`` while
    ``recommend`` and ``get_shop_seo`` yield the fields inline. Newer builds use
    ``item_card_displayed_asset`` alongside an ``item_basic``. This returns the
    innermost dict that actually holds ``itemid``, merging the outer envelope's
    own keys underneath so nothing is lost.

    Args:
        raw: One raw entry from any listing payload.

    Returns:
        A mapping with the item fields at the top level.
    """
    if not isinstance(raw, Mapping):
        return {}

    for key in ("item_basic", "item", "item_data"):
        inner = raw.get(key)
        if isinstance(inner, Mapping) and inner:
            merged = dict(raw)
            merged.pop(key, None)
            merged.update(inner)
            return merged
    return raw


def parse_shop(raw: dict[str, Any], *, username: str | None = None) -> Store:
    """Map a Shopee shop payload onto a :class:`Store`.

    Accepts both the ``get_shop_detail`` / ``get_shop_base`` envelope
    (``{"data": {...}}``) and a bare inner data dict. Also accepts the thin shop
    fragment embedded in a search result, in which case most descriptive fields
    come back None.

    Args:
        raw: Shopee shop payload, enveloped or bare.
        username: Fallback username when the payload omits ``account.username``
            — pass the slug the caller looked up.

    Returns:
        A Store with ``marketplace=Marketplace.SHOPEE`` and ``shop_id``
        populated; timestamps left None for the repository to stamp.

    Raises:
        ValueError: If no shop id can be found in ``raw``.
    """
    if not isinstance(raw, Mapping):
        raise ValueError(f"shop payload is not a mapping: {type(raw).__name__}")

    inner = raw.get("data")
    data: Mapping[str, Any] = inner if isinstance(inner, Mapping) else raw

    shop_id = _as_int(_first(data, "shopid", "shop_id", "shopId"))
    if shop_id is None:
        shop_id = _as_int(_first(raw, "shopid", "shop_id", "shopId"))
    if shop_id is None:
        raise ValueError("shop payload carries no shopid")

    slug = _as_text(_dig(data, "account", "username"))
    if slug is None:
        slug = _as_text(_first(data, "username", "shop_username", "shop_name_slug"))
    if slug is None and username:
        try:
            slug = normalise_username(username)
        except ValueError:
            slug = None
    if slug is None:
        canonical = _as_text(data.get("canonical_url"))
        if canonical:
            tail = urlparse(canonical).path.strip("/").split("/")[-1]
            slug = tail or None
    if slug is None:
        slug = placeholder_username(shop_id)

    # Not range-checked: Store clamps and warns, which is more informative than
    # silently dropping a rating scale change.
    rating = _as_decimal(_first(data, "rating_star", "shop_rating"))

    return Store(
        marketplace=Marketplace.SHOPEE,
        shop_id=shop_id,
        username=slug,
        name=_as_text(_first(data, "name", "shop_name", "display_name")),
        location=_as_text(_first(data, "shop_location", "location", "shop_city")),
        follower_count=_as_int(_first(data, "follower_count", "followers")),
        rating_star=rating,
    )


def parse_item(raw: dict[str, Any]) -> ScrapedItem:
    """Map one Shopee item payload onto a full :class:`ScrapedItem`.

    Unwraps an ``item_basic`` envelope when present, then produces the Store /
    Product / PriceSnapshot triple. The Store here is the thin one derivable
    from the item payload (``shopid`` plus whatever shop fields ride along);
    :meth:`ShopeeAdapter.search_shop` overwrites it with the rich Store from
    :meth:`ShopeeAdapter.get_shop`.

    Field mapping::

        itemid                  -> Product.item_id, PriceSnapshot.item_id
        shopid                  -> Store.shop_id, Product.shop_id
        name                    -> Product.name
        image                   -> Product.image (prefix with the CDN base)
        price                   -> PriceSnapshot.price       (/ PRICE_DIVISOR)
        price_min / price_max   -> PriceSnapshot.price_min / price_max
        stock                   -> PriceSnapshot.stock
        sold                    -> PriceSnapshot.sold
        historical_sold         -> PriceSnapshot.historical_sold
        item_rating.rating_star -> PriceSnapshot.rating_star
        item_rating.rating_count[0] -> PriceSnapshot.rating_count
        shop_location           -> Store.location

    Args:
        raw: One entry from a search, recommend or SEO payload.

    Returns:
        The parsed triple, with all timestamps left None.

    Raises:
        ValueError: If ``itemid`` or ``shopid`` is missing or unparseable, or if
            the listing has no usable title — the caller is expected to catch
            this, log it, and skip the item.
    """
    if not isinstance(raw, Mapping):
        raise ValueError(f"item payload is not a mapping: {type(raw).__name__}")

    item = unwrap_item(raw)

    item_id = _as_int(_first(item, "itemid", "item_id", "itemId"))
    if item_id is None:
        raise ValueError("item payload carries no itemid")

    shop_id = _as_int(_first(item, "shopid", "shop_id", "shopId"))
    if shop_id is None:
        raise ValueError(f"item {item_id} carries no shopid")

    name = _as_text(_first(item, "name", "title", "item_name"))
    if name is None:
        raise ValueError(f"item {item_id} carries no name")

    # Price: the flat field first, then the variant bounds, then the newer
    # item-card envelope. A variant listing reports price as 0 or -1, which
    # to_rupiah maps to None so the fallbacks get their turn.
    price_min = to_rupiah(_first(item, "price_min", "priceMin"))
    price_max = to_rupiah(_first(item, "price_max", "priceMax"))
    price = to_rupiah(_first(item, "price", "current_price"))
    if price is None:
        price = to_rupiah(_dig(item, "item_card_display_price", "price"))
    if price is None:
        price = price_min or price_max

    star, rating_count = parse_rating(item)

    sold = parse_sold_field(
        _first(item, "sold", "monthly_sold_count", "item_card_display_sold_count")
    )
    historical = parse_sold_field(
        _first(item, "historical_sold", "global_sold_count", "historical_sold_count")
    )

    store = Store(
        marketplace=Marketplace.SHOPEE,
        shop_id=shop_id,
        username=_as_text(_first(item, "shop_username", "username"))
        or placeholder_username(shop_id),
        name=_as_text(_first(item, "shop_name", "shopname")),
        location=_as_text(_first(item, "shop_location", "location")),
    )

    product = Product(
        marketplace=Marketplace.SHOPEE,
        item_id=item_id,
        shop_id=shop_id,
        name=name,
        url=build_product_url(name, shop_id, item_id),
        image=build_image_url(_first(item, "image", "cover_image")),
        category=_as_text(
            _first(item, "category_name", "main_category")
            or _dig(item, "categories", -1, "display_name")
        ),
    )

    snapshot = PriceSnapshot(
        item_id=item_id,
        price=price,
        price_min=price_min,
        price_max=price_max,
        stock=_as_int(_first(item, "stock", "normal_stock")),
        sold=sold,
        historical_sold=historical,
        rating_star=star,
        rating_count=rating_count,
    )

    return ScrapedItem(store=store, product=product, snapshot=snapshot)


def _extract_items(payload: Any) -> list[dict[str, Any]]:
    """Find the item array in any of Shopee's listing envelopes.

    Known shapes, in the order tried:

    * ``{"items": [...]}``                        — search_items
    * ``{"data": {"items": [...]}}``              — get_shop_seo, newer search
    * ``{"data": {"sections": [{"data": {"item": [...]}}]}}`` — recommend
    * ``{"data": {"item": [...]}}`` / ``{"data": {"products": [...]}}``

    Args:
        payload: Decoded JSON body.

    Returns:
        The item dicts from **every** recognised container, concatenated in the
        order tried and de-duplicated on ``itemid``. Empty when the payload
        carries none. Never raises — an unrecognised shape reads as "no items",
        which pagination treats as the end of the results.

    Note:
        Accumulating rather than returning the first non-empty container is
        load-bearing. ``/recommend`` genuinely answers with a *list* of sections,
        and short-circuiting on section 0 both dropped the rest of the page and —
        because the truncated count then looks like a short page — convinced
        :meth:`ShopeeAdapter._is_last_page` that pagination was finished, so the
        remainder of a 2000-item shop was never requested and the run still
        recorded SUCCESS.
    """
    if not isinstance(payload, Mapping):
        return []

    candidates: list[Any] = [
        payload.get("items"),
        _dig(payload, "data", "items"),
        _dig(payload, "data", "item"),
        _dig(payload, "data", "products"),
    ]

    sections = _dig(payload, "data", "sections")
    if isinstance(sections, Sequence) and not isinstance(sections, (str, bytes)):
        for section in sections:
            candidates.append(_dig(section, "data", "item"))
            candidates.append(_dig(section, "data", "items"))

    merged: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    seen_objects: set[int] = set()
    for candidate in candidates:
        if not isinstance(candidate, Sequence) or isinstance(candidate, (str, bytes)):
            continue
        for entry in candidate:
            if not isinstance(entry, Mapping):
                continue
            # The same list can be reachable by two of the paths above (a
            # payload with both `data.item` and one section carrying it), so
            # de-duplicate on the marketplace id, falling back to object
            # identity for entries that have none.
            item_id = _as_int(_first(entry, "itemid", "item_id", "itemId"))
            if item_id is not None:
                if item_id in seen_ids:
                    continue
                seen_ids.add(item_id)
            else:
                if id(entry) in seen_objects:
                    continue
                seen_objects.add(id(entry))
            merged.append(dict(entry))
    return merged


def _describe_error(payload: Any) -> str:
    """Render a payload's error code as something readable in a log line.

    Calls out an anti-bot refusal by name, because "error 90309999" and "Shopee
    anti-bot refusal" lead an operator to very different next steps: the latter
    means the session needs re-bootstrapping (or that the endpoint is simply
    gated for logged-out traffic), not that the shop or keyword is bad. A refusal
    whose code is *not* :data:`ANTIBOT_ERROR_CODE` is still named as a refusal —
    the code is evidence, not the definition.

    Args:
        payload: Decoded JSON body.

    Returns:
        A short human-readable description of the failure.
    """
    if not isinstance(payload, Mapping):
        return f"non-object body ({type(payload).__name__})"
    error = payload.get("error")
    if classify_payload(payload) is PageVerdict.BLOCKED:
        tracking = _as_text(payload.get("tracking_id"))
        suffix = f", tracking_id={tracking}" if tracking else ""
        known = "" if _as_int(error) == ANTIBOT_ERROR_CODE else " (unrecognised code)"
        return f"anti-bot refusal (error {error!r}{suffix}){known}"
    message = _as_text(payload.get("error_msg"))
    return f"error {error!r}" + (f": {message}" if message else "")


def _payload_excerpt(payload: Any) -> str:
    """Render a payload compactly for an exception's ``body_excerpt``.

    Args:
        payload: Decoded JSON body.

    Returns:
        A single-line excerpt, truncated to a log-friendly length.
    """
    try:
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(payload)
    return text[:500]


# --------------------------------------------------------------------------- #
# Adapter
# --------------------------------------------------------------------------- #


class _ShopListingStrategy:
    """One way of asking Shopee for a shop's items.

    Shopee has three shop-listing endpoints with mutually incompatible parameter
    spellings and response shapes, and which of them answers depends on the day,
    the session and the shop. Rather than hard-code the one that happened to work
    during recon, :meth:`ShopeeAdapter.search_shop` tries them in order and keeps
    the first that returns items.

    Attributes:
        name: Human label for logs.
        path: API path.
        paginated: False for ``get_shop_seo``, which takes no offset and returns
            a bounded SEO subset — pagination stops after its single page.
        build_params: ``(shop_id, offset, limit) -> query params``.
    """

    __slots__ = ("name", "path", "paginated", "build_params")

    def __init__(
        self,
        name: str,
        path: str,
        paginated: bool,
        build_params: Callable[[int, int, int], dict[str, Any]],
    ) -> None:
        """Store the strategy definition. See the class docstring for arguments."""
        self.name = name
        self.path = path
        self.paginated = paginated
        self.build_params = build_params


SHOP_LISTING_STRATEGIES: tuple[_ShopListingStrategy, ...] = (
    _ShopListingStrategy(
        name="recommend",
        path=SHOP_ITEMS_PATH,
        paginated=True,
        # NOTE the spelling: this endpoint wants `shopid`, rcmd_items wants
        # `shop_id`. Getting it wrong returns an empty list, not an error.
        build_params=lambda shop_id, offset, limit: {
            "bundle": "shop_page_category_tab_main",
            "shopid": shop_id,
            "limit": limit,
            "offset": offset,
        },
    ),
    _ShopListingStrategy(
        name="rcmd_items",
        path=SHOP_RCMD_PATH,
        paginated=True,
        build_params=lambda shop_id, offset, limit: {
            "bundle": "shop_page_category_tab_main",
            "item_card_use_scene": "category_product_list_topsales",
            "shop_id": shop_id,
            "limit": limit,
            "offset": offset,
            "sort_type": 1,
            "upstream": "",
        },
    ),
    _ShopListingStrategy(
        name="shop_seo",
        path=SHOP_SEO_PATH,
        paginated=False,
        build_params=lambda shop_id, offset, limit: {"shopid": shop_id},
    ),
)


class ShopeeAdapter:
    """Concrete :class:`scraper.adapters.MarketplaceAdapter` for Shopee Indonesia.

    Holds a :class:`scraper.client.ShopeeClient` and turns its raw JSON into
    domain models. Stateless apart from a small per-instance username -> Store
    cache so a store-mode run does not re-resolve the same shop on every page,
    and a shop_id -> username cache backing :meth:`resolve_username`.
    """

    marketplace: Marketplace = Marketplace.SHOPEE

    def __init__(
        self,
        client: ShopeeClient | None = None,
        *,
        username_resolver: Callable[[int], str | None] | None = None,
    ) -> None:
        """Bind an HTTP client to the adapter.

        Args:
            client: Transport to use. Defaults to a fresh :class:`ShopeeClient`
                built from ``config.get_settings()``. When the adapter creates
                the client itself it also owns closing it.
            username_resolver: Optional ``shop_id -> username`` hook used to
                enrich keyword-search hits, which carry ``shopid`` but no slug.
                Left None by default so keyword mode fires **zero** extra
                requests; the runner opts in — and gets cross-target caching —
                by passing its own memoised callable, or this adapter's
                :meth:`lookup_username` for the built-in one-request-per-shop
                behaviour.
        """
        self._owns_client = client is None
        self._client = client if client is not None else ShopeeClient()
        self._username_resolver = username_resolver
        self._shop_cache: dict[str, Store] = {}
        self._username_cache: dict[int, str | None] = {}
        self._closed = False
        #: Raw-vs-parsed tally for the most recent search call. The runner reads
        #: it (duck-typed, via ``getattr``) to tell "Shopee returned nothing"
        #: apart from "Shopee returned entries we no longer recognise" — without
        #: it, a field rename downstream of a 200 OK reads exactly like an empty
        #: shop and the run goes green while collecting nothing.
        self.last_parse_stats = ParseStats(0, 0, 0)

    # -- properties ------------------------------------------------------- #

    @property
    def client(self) -> ShopeeClient:
        """The bound HTTP transport.

        Returns:
            The :class:`ShopeeClient` this adapter issues requests through.
        """
        return self._client

    # -- public API ------------------------------------------------------- #

    def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk ``/api/v4/search/search_items`` for a keyword.

        Pagination uses ``newest = page_index * SEARCH_PAGE_SIZE`` with
        ``limit = SEARCH_PAGE_SIZE``. Stops early when a page returns fewer than
        ``SEARCH_PAGE_SIZE`` items or when the payload sets ``nomore``. Sends a
        ``Referer`` of ``https://shopee.co.id/search?keyword=<encoded>``.

        Items that fail :func:`parse_item` are logged and skipped. A page-level
        failure — a block, an error envelope, or an HTTP error — keeps the pages
        already walked when there are any, and otherwise **fails the target**:
        with nothing collected, returning ``[]`` would report a refused scrape
        as a successful keyword with no results. See
        :meth:`_refuse_unusable_page`.

        Args:
            keyword: Search phrase.
            pages: Maximum pages to walk, >= 1.

        Returns:
            De-duplicated :class:`ScrapedItem` list in result order. Empty only
            when Shopee genuinely answered ``"error": 0`` with no items.

        Raises:
            ValueError: If ``pages`` < 1.
            scraper.client.BlockedError: If the first page was blocked — whether
                by a 403 the client raised on, or by a soft block: an HTTP 200
                whose body is Shopee's refusal envelope.
            scraper.client.ScraperHTTPError: If the first page came back with a
                non-block error envelope or an HTTP failure.
        """
        self._check_pages(pages)
        self._reset_parse_stats()
        term = (keyword or "").strip()
        if not term:
            raise ValueError("keyword is empty")

        referer = f"{SITE_BASE}/search?keyword={quote(term)}"
        collected: list[ScrapedItem] = []
        seen: set[int] = set()

        for page in range(pages):
            params = {
                "by": "relevancy",
                "keyword": term,
                "limit": SEARCH_PAGE_SIZE,
                "newest": page * SEARCH_PAGE_SIZE,
                "order": "desc",
                "page_type": "search",
                "scenario": "PAGE_GLOBAL_SEARCH",
                "version": 2,
            }
            try:
                payload = self._client.get_json(SEARCH_PATH, params, referer=referer)
            except BlockedError:
                # Mirror _walk_shop_strategy: pages already walked are real data
                # and must survive a mid-walk block. Keyword mode is the mode
                # most likely to be blocked, so discarding its partials here lost
                # the most data of any path in the scraper.
                if collected:
                    log.warning(
                        "keyword %r blocked at page %d; keeping %d items collected so far",
                        term,
                        page,
                        len(collected),
                    )
                    break
                raise
            except ScraperHTTPError as exc:
                if not collected:
                    # Nothing was ever observed, so "no items" would be a claim
                    # we cannot make. Fail the target instead of reporting an
                    # empty-but-successful keyword.
                    raise
                log.warning(
                    "keyword %r page %d failed (%s); returning %d items collected so far",
                    term,
                    page,
                    exc,
                    len(collected),
                )
                break

            verdict = classify_payload(payload)
            if verdict is not PageVerdict.USABLE:
                self._refuse_unusable_page(
                    payload,
                    verdict,
                    collected=bool(collected),
                    url=f"{SITE_BASE}{SEARCH_PATH}",
                    context=f"keyword {term!r} page {page}",
                    kept=len(collected),
                )
                break

            raw_items = _extract_items(payload)
            collected.extend(self._parse_many(raw_items, seen, context=f"keyword {term!r}"))

            if self._is_last_page(payload, raw_items, SEARCH_PAGE_SIZE):
                break

        # Enrichment is a bonus, never a gate. lookup_username raises BlockedError
        # on a refusal, and running it *after* the walk meant one refused
        # get_shop_seo threw away a whole successful harvest — undoing, three
        # lines up, the partial-keeping the block handler above deliberately does.
        # The items keep their placeholder slugs; a later store-mode run backfills
        # them, and the block is still reported by the endpoint that hit it.
        try:
            self._enrich_usernames(collected)
        except BlockedError as exc:
            log.warning(
                "keyword %r: username enrichment blocked (%s); keeping %d items with "
                "placeholder usernames",
                term,
                exc,
                len(collected),
            )
        return collected

    def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk one shop's listings.

        Resolves the shop with :meth:`get_shop` first, then tries each entry of
        :data:`SHOP_LISTING_STRATEGIES` in order, keeping the first that returns
        items and paginating it with ``offset = page_index * SHOP_PAGE_SIZE``.
        A strategy that is blocked or errors is logged and the next is tried.

        A soft block (HTTP 200 carrying Shopee's refusal envelope) is raised out
        of the walk as a :class:`~scraper.client.BlockedError`, so it falls
        through to the next strategy on exactly the same rails as a 403 and is
        counted the same way here.

        The target fails whenever nothing came back and no *listing* endpoint
        ever answered. "This shop is empty" is a claim only a paginated listing
        endpoint can support: ``get_shop_seo`` is SEO metadata that answers
        ``error: 0`` with no ``items`` key at all, so counting its silence as
        proof of an empty catalogue would report a fully refused shop as a
        successful run with zero items. One blocked endpoint next to a listing
        endpoint that answered 200 with an empty catalogue is still an empty
        shop, not a block.

        Every returned :class:`ScrapedItem` carries the rich Store from
        :meth:`get_shop`, not the thin one :func:`parse_item` derives, so
        ``username`` (required output field #1) is always populated in store mode.

        Args:
            username: Shop URL slug.
            pages: Maximum pages to walk, >= 1.

        Returns:
            De-duplicated :class:`ScrapedItem` list. Empty only when a listing
            endpoint answered and reported no listings.

        Raises:
            ValueError: If ``pages`` < 1.
            LookupError: If the shop does not exist.
            scraper.client.BlockedError: If no listing endpoint gave a usable
                answer and at least one endpoint was blocked.
            scraper.client.ScraperHTTPError: If no listing endpoint gave a usable
                answer and none of the failures was a block.
        """
        self._check_pages(pages)
        self._reset_parse_stats()
        store = self.get_shop(username)
        referer = f"{SITE_BASE}/{store.username}"

        collected: list[ScrapedItem] = []
        seen: set[int] = set()
        blocked: BlockedError | None = None
        failed: ScraperHTTPError | None = None
        blocked_count = 0
        unusable_count = 0
        # Only a *paginated listing* endpoint can testify that a catalogue is
        # empty. get_shop_seo is SEO metadata: it answers error:0 with no items
        # key whether the shop has a thousand listings or none, so its silence
        # is not evidence about the catalogue.
        answered_listing = False
        total = len(SHOP_LISTING_STRATEGIES)

        for strategy in SHOP_LISTING_STRATEGIES:
            try:
                items = self._walk_shop_strategy(
                    strategy, store.shop_id, pages, referer, seen, store.username
                )
            except BlockedError as exc:
                # A soft block arrives here identically to a 403: both are a
                # BlockedError raised out of the walk, so a 200-with-refusal
                # falls through to the next strategy exactly as a hard block
                # does, and is counted the same way below.
                blocked = exc
                blocked_count += 1
                unusable_count += 1
                log.warning(
                    "shop %s: listing endpoint %s blocked; trying next strategy",
                    store.username,
                    strategy.name,
                )
                continue
            except ScraperHTTPError as exc:
                failed = exc
                unusable_count += 1
                log.warning(
                    "shop %s: listing endpoint %s gave no usable answer (%s); "
                    "trying next strategy",
                    store.username,
                    strategy.name,
                    exc,
                )
                continue

            if strategy.paginated:
                answered_listing = True

            if items:
                collected = items
                log.debug(
                    "shop %s: %d items via %s", store.username, len(items), strategy.name
                )
                break
            log.debug("shop %s: %s returned no items", store.username, strategy.name)

        # "The shop is empty" is a claim, and only a *listing* endpoint that
        # actually answered can support it. When none did, nothing observed the
        # catalogue, so the target fails — a block is re-raised in preference to
        # a plain error because it is the more actionable diagnosis.
        #
        # Requiring `unusable_count == total` instead was the silent-zero bug:
        # with both paginated endpoints refused, get_shop_seo answering
        # {"error":0,"data":{"page_title":...}} — no items key, because it is SEO
        # metadata and not a listing — left 2 of 3 unusable, skipped the raise
        # and returned []. The runner then recorded SUCCESS with 0 items and,
        # seeing no block, reset its consecutive-block counter and kept walking
        # every remaining target while fully blocked.
        #
        # Counting merely *tried* strategies would be the opposite bug: it
        # re-raised a stale BlockedError whenever one endpoint was blocked and
        # the others answered 200 with an empty catalogue, reporting a shop with
        # no active listings as FAILED and sending an operator chasing an
        # anti-bot problem that two HTTP 200s had already disproved.
        if not collected and unusable_count and not answered_listing:
            failure = blocked if blocked is not None else failed
            if failure is not None:
                raise failure
        if not collected and unusable_count:
            log.warning(
                "shop %s: %d of %d listing endpoints unusable (%d blocked), but a "
                "listing endpoint answered with no items; reporting an empty shop "
                "rather than a block",
                store.username,
                unusable_count,
                total,
                blocked_count,
            )

        return [item._replace(store=store) for item in collected]

    def get_shop(self, username: str) -> Store:
        """Resolve a slug to a full :class:`Store` via the shop-detail endpoint.

        Tries ``/api/v4/shop/get_shop_detail`` (verified working logged-out
        during recon) and falls back to ``/api/v4/shop/get_shop_base``. Memoised
        per adapter instance. Strips a leading ``@`` and tolerates a full profile
        URL being passed instead of a bare slug.

        Args:
            username: Shop URL slug.

        Returns:
            A populated Store.

        Raises:
            ValueError: If ``username`` is blank.
            LookupError: If Shopee reports the shop as missing (an explained
                ``error``, or a null ``data``) on every path, and none of them
                was blocked.
            scraper.client.BlockedError: If every path was tried and at least one
                was blocked — either the client raised, or the body was a refusal
                envelope under a success status. A block is never downgraded to
                LookupError: "you are refused" and "this shop does not exist"
                send an operator to opposite fixes.
        """
        slug = normalise_username(username)
        cached = self._shop_cache.get(slug)
        if cached is not None:
            return cached

        referer = f"{SITE_BASE}/{slug}"
        last_error: str | None = None
        blocked: BlockedError | None = None

        for path in (SHOP_DETAIL_PATH, SHOP_BASE_PATH):
            params: dict[str, Any] = {"username": slug}
            if path == SHOP_BASE_PATH:
                params.update(
                    {
                        "entry_point": "ShopByPDP",
                        "need_cancel_rate": "true",
                        "request_source": "shop_home_page",
                        "version": 1,
                    }
                )
            try:
                payload = self._client.get_json(path, params, referer=referer)
            except BlockedError as exc:
                # Shopee refuses per *endpoint*, not per session: the recon
                # capture has get_shop_base_v2 answering in full (#26) in the
                # same page session where get_shop_tab returned the 119-byte
                # refusal (#27). Remember the refusal and give the fallback its
                # turn, exactly as search_shop does across listing strategies.
                blocked = exc
                log.warning("shop %s: %s blocked; trying the fallback endpoint", slug, path)
                continue
            except ScraperHTTPError as exc:
                last_error = str(exc)
                log.debug("shop %s: %s failed (%s)", slug, path, exc)
                continue

            verdict = classify_payload(payload)
            if verdict is PageVerdict.BLOCKED:
                # "Blocked" and "no such shop" are different facts with different
                # fixes, and a LookupError here would report the first as the
                # second — sending an operator to check a slug that is fine. The
                # refusal is kept and re-raised below only if the fallback fails
                # too; a soft block on one path says nothing about the other.
                log.warning("shop %s: %s -> %s", slug, path, _describe_error(payload))
                blocked = BlockedError(
                    f"shop {slug!r}: {path} returned a refusal envelope on an "
                    f"otherwise-successful response ({_describe_error(payload)})",
                    url=f"{SITE_BASE}{path}",
                    body_excerpt=_payload_excerpt(payload),
                )
                continue

            data = payload.get("data") if isinstance(payload, Mapping) else None
            if verdict is PageVerdict.ERROR or not isinstance(data, Mapping):
                last_error = f"{path} -> {_describe_error(payload)}"
                log.debug("shop %s: %s", slug, last_error)
                continue

            try:
                store = parse_shop(dict(payload), username=slug)
            except ValueError as exc:
                last_error = f"{path} -> {exc}"
                log.debug("shop %s: %s", slug, last_error)
                continue

            self._shop_cache[slug] = store
            self._username_cache[store.shop_id] = store.username
            return store

        if blocked is not None:
            # Every door was tried and one of them refused us: "blocked" is the
            # honest, actionable diagnosis, and outranks "not found".
            raise blocked
        raise LookupError(f"shop {slug!r} not found on Shopee ({last_error or 'no data'})")

    def resolve_username(self, shop_id: int) -> str | None:
        """Look up a shop's slug from its numeric id, via the injected hook.

        Memoised per adapter instance — including negative results — so a page of
        60 listings from the same seller costs at most one resolution. When no
        ``username_resolver`` was supplied this is a pure no-op returning None,
        which is why keyword mode issues no shop requests by default.

        Args:
            shop_id: Marketplace shop id.

        Returns:
            The shop's username, or None when unresolved.
        """
        if shop_id in self._username_cache:
            return self._username_cache[shop_id]
        if self._username_resolver is None:
            return None

        try:
            resolved = self._username_resolver(shop_id)
        except BlockedError:
            raise
        except Exception as exc:  # noqa: BLE001 - enrichment must never fail a run
            log.warning("username resolution failed for shop_id %s: %s", shop_id, exc)
            resolved = None

        resolved = _as_text(resolved)
        self._username_cache[shop_id] = resolved
        return resolved

    def lookup_username(self, shop_id: int) -> str | None:
        """Built-in ``shop_id -> username`` resolver, for use as the hook.

        Uses ``/api/v4/shop/get_shop_seo``, whose ``data.canonical_url`` was
        verified during recon to contain the slug
        (``https://shopee.co.id/erigostore``) — and which is one of the very few
        endpoints that still answers logged out. Costs one request per call, so
        pass it as ``username_resolver`` only when the slug is worth that; the
        memoisation in :meth:`resolve_username` keeps it to one per distinct shop.

        Args:
            shop_id: Marketplace shop id.

        Returns:
            The shop's username, or None when the endpoint did not expose it.

        Raises:
            scraper.client.BlockedError: If blocked and re-bootstrap failed.
        """
        try:
            payload = self._client.get_json(
                SHOP_SEO_PATH, {"shopid": shop_id}, referer=f"{SITE_BASE}/shop/{shop_id}"
            )
        except BlockedError:
            raise
        except ScraperHTTPError as exc:
            log.debug("lookup_username(%s) failed: %s", shop_id, exc)
            return None

        verdict = classify_payload(payload)
        if verdict is PageVerdict.BLOCKED:
            # Same treatment a 403 gets from get_json two lines up: a refusal is
            # a refusal whichever status it wore, and degrading it to "this shop
            # has no username" would hide an active block behind placeholder
            # slugs on every item of the run.
            raise BlockedError(
                f"lookup_username({shop_id}): {_describe_error(payload)} on an "
                f"otherwise-successful response",
                url=f"{SITE_BASE}{SHOP_SEO_PATH}",
                body_excerpt=_payload_excerpt(payload),
            )
        if verdict is PageVerdict.ERROR:
            return None

        canonical = _as_text(_dig(payload, "data", "canonical_url"))
        if canonical:
            tail = urlparse(canonical).path.strip("/").split("/")[-1]
            if tail:
                return tail
        return _as_text(_dig(payload, "data", "account", "username"))

    def close(self) -> None:
        """Close the underlying client if this adapter created it. Idempotent."""
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "ShopeeAdapter":
        """Enter a context manager so ``close`` is guaranteed.

        Returns:
            ``self``.
        """
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        """Close the adapter. Never suppresses exceptions."""
        self.close()

    # -- internals -------------------------------------------------------- #

    @staticmethod
    def _check_pages(pages: int) -> None:
        """Validate the ``pages`` argument shared by both search methods.

        Args:
            pages: Requested page count.

        Raises:
            ValueError: If ``pages`` < 1.
        """
        if pages < 1:
            raise ValueError(f"pages must be >= 1, got {pages}")

    @staticmethod
    def _refuse_unusable_page(
        payload: Any,
        verdict: PageVerdict,
        *,
        collected: bool,
        url: str,
        context: str,
        kept: int,
    ) -> None:
        """React to a page that carries no usable rows: never call it "no items".

        This is the single place the data-integrity rule is enforced, for every
        walk in the module. A page whose verdict is not
        :attr:`PageVerdict.USABLE` observed *nothing*; ending pagination on it
        and returning the empty list would let the runner record the target
        SUCCESS with ``item_count=0`` — a refused scrape indistinguishable, in
        the database and on the dashboard, from a genuinely empty shop.

        With items already in hand the walk keeps them and stops (a partial page
        set is real data, and matches how a hard
        :class:`~scraper.client.BlockedError` mid-walk is handled). With nothing
        in hand it raises, and the class of exception preserves the distinction:
        :class:`~scraper.client.BlockedError` for a refusal — the same type a 403
        produces, so shop-strategy fallback and the runner's block accounting
        treat soft and hard blocks identically — and
        :class:`~scraper.client.ScraperHTTPError` for any other error envelope.

        Args:
            payload: The decoded page body.
            verdict: Its classification from :func:`classify_payload`.
            collected: Whether the caller already holds items from earlier pages.
            url: Absolute URL of the endpoint, for the exception context.
            context: Human label for the log line, e.g. ``"keyword 'kaos' page 0"``.
            kept: How many items the caller is holding, for the log line.

        Raises:
            scraper.client.BlockedError: Refused, with nothing collected yet.
            scraper.client.ScraperHTTPError: Other error envelope, nothing
                collected yet.
        """
        description = _describe_error(payload)
        if collected:
            log.warning(
                "%s: %s; stopping pagination and keeping %d items collected so far",
                context,
                description,
                kept,
            )
            return

        log.warning("%s: %s; failing the target", context, description)
        excerpt = _payload_excerpt(payload)
        if verdict is PageVerdict.BLOCKED:
            raise BlockedError(
                f"{context}: {description} — Shopee returned a refusal envelope on an "
                f"otherwise-successful response; this is a block, not an empty result",
                url=url,
                body_excerpt=excerpt,
            )
        raise ScraperHTTPError(
            f"{context}: {description} — no usable rows were returned, so zero items "
            f"here is unknown, not observed",
            url=url,
            body_excerpt=excerpt,
        )

    @staticmethod
    def _is_last_page(payload: Any, raw_items: Sequence[Any], page_size: int) -> bool:
        """Decide whether pagination should stop after this page.

        Precondition: ``payload`` has already been classified
        :attr:`PageVerdict.USABLE` by :func:`classify_payload`. A blocked or
        error page must never reach here — "zero items" from one of those means
        "we were refused", and this method would read it as "last page".

        Args:
            payload: The decoded page body.
            raw_items: Items extracted from it.
            page_size: The ``limit`` that was requested.

        Returns:
            True when the page was empty, short, or explicitly flagged as last.
        """
        if not raw_items or len(raw_items) < page_size:
            return True
        if isinstance(payload, Mapping):
            if payload.get("nomore") is True or _dig(payload, "data", "nomore") is True:
                return True
        return False

    def _parse_many(
        self, raw_items: Iterable[Mapping[str, Any]], seen: set[int], *, context: str
    ) -> list[ScrapedItem]:
        """Parse a page of raw entries, skipping (never raising on) bad ones.

        One malformed listing in a page of 60 must not cost the other 59, so
        every failure mode here — a missing id, a retyped field, a pydantic
        validation error — is logged and skipped.

        Args:
            raw_items: Raw entries from one page.
            seen: Item ids already yielded in this call; mutated in place so
                de-duplication spans pages.
            context: Label for log lines, e.g. ``"keyword 'kaos polos'"``.

        Returns:
            The successfully parsed items, in payload order.
        """
        parsed: list[ScrapedItem] = []
        raw_seen = 0
        for raw in raw_items:
            raw_seen += 1
            try:
                item = parse_item(dict(raw) if isinstance(raw, Mapping) else raw)
            except (ValueError, TypeError, KeyError, AttributeError) as exc:
                log.warning("%s: skipping malformed item (%s)", context, exc)
                continue
            except Exception as exc:  # noqa: BLE001 - one bad item must not kill the page
                log.warning(
                    "%s: skipping item after unexpected %s (%s)",
                    context,
                    type(exc).__name__,
                    exc,
                )
                continue

            if item.product.item_id in seen:
                continue
            seen.add(item.product.item_id)
            parsed.append(item)

        self.last_parse_stats = ParseStats(
            raw_seen=self.last_parse_stats.raw_seen + raw_seen,
            parsed=self.last_parse_stats.parsed + len(parsed),
            skipped=self.last_parse_stats.skipped + raw_seen - len(parsed),
        )
        if raw_seen and not parsed:
            # Every entry on a page failing is not "a bad item" — it is the shape
            # of a schema change, and the only place it is visible.
            log.error(
                "%s: all %d entries on this page failed to parse — Shopee's payload "
                "shape may have changed",
                context,
                raw_seen,
            )
        return parsed

    def _reset_parse_stats(self) -> None:
        """Zero :attr:`last_parse_stats` at the start of a search call."""
        self.last_parse_stats = ParseStats(0, 0, 0)

    def _walk_shop_strategy(
        self,
        strategy: _ShopListingStrategy,
        shop_id: int,
        pages: int,
        referer: str,
        seen: set[int],
        slug: str,
    ) -> list[ScrapedItem]:
        """Paginate one shop-listing strategy.

        Args:
            strategy: Endpoint definition to drive.
            shop_id: Numeric shop id.
            pages: Maximum pages to walk.
            referer: Referer header to send.
            seen: Shared de-duplication set, mutated in place.
            slug: Shop username, for log lines.

        Returns:
            Parsed items from this strategy — empty only when the endpoint
            answered and had nothing to list.

        Raises:
            scraper.client.BlockedError: A hard block from the client, or a soft
                block this method classified itself, with no items yet in hand.
                Propagated so the caller can fall through to the next strategy.
            scraper.client.ScraperHTTPError: A non-block failure with no items
                yet in hand, so the caller does not mistake this strategy's
                silence for proof that the shop is empty.
        """
        collected: list[ScrapedItem] = []
        effective_pages = pages if strategy.paginated else 1
        if pages > 1 and not strategy.paginated:
            log.debug(
                "shop %s: %s is unpaginated; requesting its single bounded page",
                slug,
                strategy.name,
            )

        for page in range(effective_pages):
            params = strategy.build_params(shop_id, page * SHOP_PAGE_SIZE, SHOP_PAGE_SIZE)
            try:
                payload = self._client.get_json(strategy.path, params, referer=referer)
            except BlockedError:
                if collected:
                    # Already have data from earlier pages — keep it rather than
                    # failing the whole target on a mid-walk block.
                    log.warning(
                        "shop %s: %s blocked at page %d; keeping %d items",
                        slug,
                        strategy.name,
                        page,
                        len(collected),
                    )
                    return collected
                raise
            except ScraperHTTPError as exc:
                log.warning("shop %s: %s page %d failed (%s)", slug, strategy.name, page, exc)
                if not collected:
                    # This strategy never produced a usable answer, so it has not
                    # shown the shop to be empty. Propagate so search_shop counts
                    # it as a failed strategy rather than as a clean empty one.
                    raise
                break

            verdict = classify_payload(payload)
            if verdict is not PageVerdict.USABLE:
                self._refuse_unusable_page(
                    payload,
                    verdict,
                    collected=bool(collected),
                    url=f"{SITE_BASE}{strategy.path}",
                    context=f"shop {slug!r}/{strategy.name} page {page}",
                    kept=len(collected),
                )
                break

            raw_items = _extract_items(payload)
            collected.extend(
                self._parse_many(raw_items, seen, context=f"shop {slug!r}/{strategy.name}")
            )

            if not strategy.paginated:
                break
            if self._is_last_page(payload, raw_items, SHOP_PAGE_SIZE):
                break

        return collected

    def _enrich_usernames(self, items: list[ScrapedItem]) -> None:
        """Replace placeholder usernames in-place using :meth:`resolve_username`.

        Groups by ``shop_id`` first, so a page of 60 hits from 12 sellers costs at
        most 12 resolutions — and zero when no resolver is configured.

        Args:
            items: Items to enrich; the list is rewritten in place.
        """
        if self._username_resolver is None and not self._username_cache:
            return

        # ScrapedItem.store is `Store | None` by contract. parse_item always
        # builds one, but guarding here keeps this loop honest against the type
        # rather than against one implementation's current behaviour.
        shop_ids = {
            item.store.shop_id
            for item in items
            if item.store is not None and is_placeholder_username(item.store.username)
        }
        if not shop_ids:
            return

        resolved = {shop_id: self.resolve_username(shop_id) for shop_id in shop_ids}

        for index, item in enumerate(items):
            if item.store is None:
                continue
            slug = resolved.get(item.store.shop_id)
            if slug and is_placeholder_username(item.store.username):
                items[index] = item._replace(
                    store=item.store.model_copy(update={"username": slug})
                )
