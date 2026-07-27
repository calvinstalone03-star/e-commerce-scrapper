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
``/api/v4/shop/get_shop_base``          Username -> shop metadata. Param: ``username``.
``/api/v4/recommend/recommend``         Shop listing. Params: ``bundle=shop_page_
                                        category_tab_main``, ``shopid``, ``limit`` (30),
                                        ``offset``.
======================================  ================================================

Payload conventions this module is responsible for absorbing:

* **Prices are integer micro-units** — divide by ``PRICE_DIVISOR`` (100_000) to
  get whole rupiah. ``price``, ``price_min``, ``price_max`` all need it.
* **Ratings arrive as ``item_rating``** — ``{"rating_star": 4.83, "rating_count":
  [total, n1, n2, n3, n4, n5]}``. The count we store is ``rating_count[0]``.
* **Item envelopes vary** — search returns ``item_basic`` per entry, the
  recommend endpoint returns the fields inline. :func:`parse_item` normalises
  both, which is why it takes a raw dict rather than a typed structure.
* **Shop detail is sparse in search results** — a search hit gives ``shopid``
  and often ``shop_location`` but rarely a username. Build the best Store you
  can and let ``store.upsert_store`` avoid clobbering better data scraped later.
* A missing/None numeric field means "not exposed", not zero. Leave it None.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from scraper.adapters import ScrapedItem
from scraper.client import ShopeeClient
from scraper.models import Marketplace, PriceSnapshot, Product, Store

__all__ = [
    "ShopeeAdapter",
    "PRICE_DIVISOR",
    "SEARCH_PAGE_SIZE",
    "SHOP_PAGE_SIZE",
    "parse_item",
    "parse_shop",
    "to_rupiah",
    "build_product_url",
]

PRICE_DIVISOR = Decimal(100_000)
SEARCH_PAGE_SIZE = 60
SHOP_PAGE_SIZE = 30

SEARCH_PATH = "/api/v4/search/search_items"
SHOP_BASE_PATH = "/api/v4/shop/get_shop_base"
SHOP_ITEMS_PATH = "/api/v4/recommend/recommend"


def to_rupiah(micro: int | float | str | None) -> Decimal | None:
    """Convert a Shopee integer micro-price to whole rupiah.

    Shopee reports ``2_500_000_000`` for Rp 25.000. Division is done in
    :class:`~decimal.Decimal` so no float rounding is introduced before the
    value reaches the ``numeric`` column.

    Args:
        micro: Raw price value from the payload, or None.

    Returns:
        The price in whole rupiah, or None when ``micro`` is None or is a
        sentinel Shopee uses for "no price" (negative values, and ``0`` on a
        listing that also reports no stock).
    """
    raise NotImplementedError


def build_product_url(name: str, shop_id: int, item_id: int) -> str:
    """Construct the canonical Shopee product URL.

    Format: ``https://shopee.co.id/{slug}-i.{shop_id}.{item_id}`` where ``slug``
    is the listing name lowercased with non-alphanumerics collapsed to ``-``.
    The slug is cosmetic — Shopee resolves on the numeric suffix alone — so an
    imperfect slug is acceptable, but the numeric suffix must be exact.

    Args:
        name: Listing title.
        shop_id: Marketplace shop id.
        item_id: Marketplace item id.

    Returns:
        An absolute product URL.
    """
    raise NotImplementedError


def parse_shop(raw: dict[str, Any], *, username: str | None = None) -> Store:
    """Map a Shopee shop payload onto a :class:`Store`.

    Accepts both the ``get_shop_base`` envelope (``{"data": {...}}``) and a bare
    inner data dict. Also accepts the thin shop fragment embedded in a search
    result, in which case most descriptive fields come back None.

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
    raise NotImplementedError


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
        raw: One entry from a search or recommend payload.

    Returns:
        The parsed triple, with all timestamps left None.

    Raises:
        ValueError: If ``itemid`` or ``shopid`` is missing or unparseable — the
            caller is expected to catch this, log it, and skip the item.
    """
    raise NotImplementedError


class ShopeeAdapter:
    """Concrete :class:`scraper.adapters.MarketplaceAdapter` for Shopee Indonesia.

    Holds a :class:`scraper.client.ShopeeClient` and turns its raw JSON into
    domain models. Stateless apart from a small per-instance username -> Store
    cache so a store-mode run does not re-resolve the same shop on every page.
    """

    marketplace: Marketplace = Marketplace.SHOPEE

    def __init__(self, client: ShopeeClient | None = None) -> None:
        """Bind an HTTP client to the adapter.

        Args:
            client: Transport to use. Defaults to a fresh :class:`ShopeeClient`
                built from ``config.get_settings()``. When the adapter creates
                the client itself it also owns closing it.
        """
        raise NotImplementedError

    def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk ``/api/v4/search/search_items`` for a keyword.

        Pagination uses ``newest = page_index * SEARCH_PAGE_SIZE`` with
        ``limit = SEARCH_PAGE_SIZE``. Stops early when a page returns fewer than
        ``SEARCH_PAGE_SIZE`` items or when the payload sets ``nomore``. Sends a
        ``Referer`` of ``https://shopee.co.id/search?keyword=<encoded>``.

        Items that fail :func:`parse_item` are logged and skipped; a page-level
        failure that is not a block ends pagination and returns what was
        collected so far.

        Args:
            keyword: Search phrase.
            pages: Maximum pages to walk, >= 1.

        Returns:
            De-duplicated :class:`ScrapedItem` list in result order.

        Raises:
            ValueError: If ``pages`` < 1.
            scraper.client.BlockedError: If blocked and re-bootstrap failed.
        """
        raise NotImplementedError

    def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk one shop's listings via ``/api/v4/recommend/recommend``.

        Resolves the shop with :meth:`get_shop` first, then paginates with
        ``offset = page_index * SHOP_PAGE_SIZE`` and ``limit = SHOP_PAGE_SIZE``.
        Every returned :class:`ScrapedItem` carries the rich Store from
        :meth:`get_shop`, not the thin one :func:`parse_item` derives, so
        ``username`` (required output field #1) is always populated in store mode.

        Args:
            username: Shop URL slug.
            pages: Maximum pages to walk, >= 1.

        Returns:
            De-duplicated :class:`ScrapedItem` list.

        Raises:
            ValueError: If ``pages`` < 1.
            LookupError: If the shop does not exist.
            scraper.client.BlockedError: If blocked and re-bootstrap failed.
        """
        raise NotImplementedError

    def get_shop(self, username: str) -> Store:
        """Resolve a slug to a full :class:`Store` via ``/api/v4/shop/get_shop_base``.

        Memoised per adapter instance. Strips a leading ``@`` and tolerates a
        full profile URL being passed instead of a bare slug.

        Args:
            username: Shop URL slug.

        Returns:
            A populated Store.

        Raises:
            LookupError: If Shopee reports the shop as missing (``error`` set, or
                a null ``data``).
            scraper.client.BlockedError: If blocked and re-bootstrap failed.
        """
        raise NotImplementedError

    def close(self) -> None:
        """Close the underlying client if this adapter created it. Idempotent."""
        raise NotImplementedError
