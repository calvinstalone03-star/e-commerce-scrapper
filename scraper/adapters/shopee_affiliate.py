"""Shopee adapter backed by the Affiliate Open API instead of the web endpoints.

Same :class:`~scraper.adapters.MarketplaceAdapter` contract as
:class:`~scraper.adapters.shopee.ShopeeAdapter`, same
:class:`~scraper.models.Marketplace.SHOPEE` marketplace, so both write into the
same ``stores``/``products``/``price_snapshots`` rows and a product's price
history stays continuous whichever adapter collected it. That shared identity is
deliberate: a separate marketplace value would fork ``(marketplace, item_id)``
and split one product's history across two series.

``productOfferV2`` serves both modes:

* ``keyword`` — keyword mode, the thing the web path could never unblock;
* ``shopId`` — store mode, which lifts the scraper's one-item-per-shop ceiling.

Field mapping, all five of the project's required outputs:

======================  =========================================
project field           affiliate field
======================  =========================================
shop username           ``shopName``  (slug is not exposed; see below)
product name            ``productName``
price                   ``priceMin`` / ``priceMax``
units sold              ``sales``
rating star             ``ratingStar``
======================  =========================================

One honest wrinkle: the affiliate payload carries ``shopName`` (the display
name) and ``shopId``, but not the URL slug that ``config/stores.txt`` holds and
that ``stores.username`` stores. Store mode therefore takes a **numeric shop id**
directly, and :meth:`ShopeeAffiliateAdapter.get_shop` accepts either a slug it
cannot resolve (raising :class:`LookupError` with guidance) or a bare id. Mixing
the two adapters against the same shop is fine — ``upsert_store`` prefers a real
slug over a synthetic one — but this adapter alone cannot invent slugs it was
never given.

Prices come back as whole rupiah here, not the web endpoint's scaled integers,
so there is no divisor to apply. That difference is exactly why parsing lives in
the adapter rather than in :mod:`scraper.models`.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from scraper.affiliate_client import AffiliateClient
from scraper.models import Marketplace, PriceSnapshot, Product, ScrapedItem, Store

__all__ = ["ShopeeAffiliateAdapter", "PRODUCT_OFFER_QUERY", "PAGE_SIZE"]

log = logging.getLogger(__name__)

#: Affiliate API page size. Shopee caps ``limit`` at 50 for productOfferV2.
PAGE_SIZE = 50

#: sortType 2 = by sales. Most useful default for a competitor price tracker:
#: the products that actually move are the ones worth comparing on price.
SORT_BY_SALES = 2

PRODUCT_OFFER_QUERY = """
query productOfferV2($keyword: String, $shopId: Int64, $sortType: Int, $page: Int, $limit: Int) {
  productOfferV2(keyword: $keyword, shopId: $shopId, sortType: $sortType, page: $page, limit: $limit) {
    nodes {
      itemId
      shopId
      shopName
      productName
      priceMin
      priceMax
      priceDiscountRate
      sales
      ratingStar
      imageUrl
      productLink
      offerLink
      shopType
    }
    pageInfo {
      page
      limit
      hasNextPage
    }
  }
}
""".strip()


def _decimal(value: Any) -> Decimal | None:
    """Coerce an affiliate price to Decimal, or None when unusable.

    Affiliate prices arrive as strings ("152900.00") or numbers depending on the
    field and the region. Never float() them — money.
    """
    if value is None or value == "":
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return result if result >= 0 else None


def _int(value: Any) -> int | None:
    """Coerce to int, tolerating strings and None."""
    if value is None or value == "":
        return None
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


class ShopeeAffiliateAdapter:
    """Shopee listings via the Affiliate Open API.

    Args:
        client: A built :class:`~scraper.affiliate_client.AffiliateClient`.
        sort_type: Affiliate sort order. Defaults to sales-descending.
    """

    marketplace = Marketplace.SHOPEE

    def __init__(self, client: AffiliateClient, *, sort_type: int = SORT_BY_SALES) -> None:
        self.client = client
        self.sort_type = sort_type
        #: shop_id -> Store, so a shop seen on many pages is built once.
        self._shops: dict[int, Store] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __enter__(self) -> ShopeeAffiliateAdapter:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying client. Idempotent."""
        self.client.close()

    # ------------------------------------------------------------------
    # Protocol
    # ------------------------------------------------------------------

    def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk affiliate offers matching a keyword.

        Args:
            keyword: Search phrase.
            pages: Maximum pages to walk (50 offers per page).

        Returns:
            One :class:`ScrapedItem` per offer, de-duplicated on item id.

        Raises:
            ValueError: If ``pages`` < 1.
            scraper.affiliate_client.AffiliateError: On an API error envelope.
        """
        return self._walk({"keyword": keyword}, pages=pages, label=f"keyword {keyword!r}")

    def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk one shop's affiliate offers.

        Args:
            username: Numeric shop id, or a slug (see :meth:`get_shop`).
            pages: Maximum pages to walk.

        Returns:
            One :class:`ScrapedItem` per offer.

        Raises:
            ValueError: If ``pages`` < 1.
            LookupError: If ``username`` is a slug this adapter cannot resolve.
            scraper.affiliate_client.AffiliateError: On an API error envelope.
        """
        shop_id = self._as_shop_id(username)
        return self._walk({"shopId": shop_id}, pages=pages, label=f"shop {shop_id}")

    def get_shop(self, username: str) -> Store:
        """Resolve a shop to a :class:`Store`.

        The affiliate catalogue is keyed by numeric shop id and does not publish
        the URL slug, so a slug cannot be resolved here. Pass the numeric id, or
        resolve the slug once with the web adapter — ``get_shop_detail`` answers
        without a login — and put the id in ``config/stores.txt``.

        Args:
            username: Numeric shop id as a string, or a slug.

        Returns:
            A Store with ``shop_id`` populated; ``name`` filled in from the first
            offer seen for that shop, when one has been.

        Raises:
            LookupError: If ``username`` is not numeric.
        """
        shop_id = self._as_shop_id(username)
        cached = self._shops.get(shop_id)
        if cached is not None:
            return cached
        store = Store(marketplace=self.marketplace, shop_id=shop_id, username=str(shop_id))
        self._shops[shop_id] = store
        return store

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _as_shop_id(self, username: str) -> int:
        """Interpret a target as a numeric shop id."""
        text = str(username).strip()
        if text.isdigit():
            return int(text)
        raise LookupError(
            f"the affiliate API identifies shops by numeric id, and {username!r} is a slug. "
            "The affiliate payload does not publish shop slugs, so this adapter cannot "
            "resolve it. Resolve it once via the web adapter "
            "(GET /api/v4/shop/get_shop_detail?username=...&, which answers logged out) "
            "and put the numeric id in config/stores.txt."
        )

    def _walk(self, selector: dict[str, Any], *, pages: int, label: str) -> list[ScrapedItem]:
        """Page through productOfferV2 for one selector.

        Stops on the first page that reports no next page, returns nothing, or
        yields no *new* item id — the last of those guards against an API that
        keeps serving page 1 for an out-of-range page number.
        """
        if pages < 1:
            raise ValueError("pages must be >= 1")

        collected: list[ScrapedItem] = []
        seen: set[int] = set()

        for page in range(1, pages + 1):
            variables = {
                "sortType": self.sort_type,
                "page": page,
                "limit": PAGE_SIZE,
                **selector,
            }
            data = self.client.execute(PRODUCT_OFFER_QUERY, variables)
            offer = data.get("productOfferV2") or {}
            nodes = offer.get("nodes") or []
            if not nodes:
                log.debug("%s: page %d empty; stopping", label, page)
                break

            fresh = 0
            for node in nodes:
                item = self._parse(node)
                if item is None:
                    continue
                if item.product.item_id in seen:
                    continue
                seen.add(item.product.item_id)
                collected.append(item)
                fresh += 1

            log.info("%s: page %d -> %d offers (%d new)", label, page, len(nodes), fresh)

            if fresh == 0:
                log.debug("%s: page %d repeated known items; stopping", label, page)
                break

            page_info = offer.get("pageInfo") or {}
            if page_info.get("hasNextPage") is False:
                break
            if len(nodes) < PAGE_SIZE:
                break

        return collected

    def _parse(self, node: dict[str, Any]) -> ScrapedItem | None:
        """Map one affiliate offer onto the domain models.

        Returns None for an unusable entry rather than raising: one bad offer in
        a page of 50 must not lose the other 49.
        """
        try:
            item_id = _int(node.get("itemId"))
            shop_id = _int(node.get("shopId"))
            name = str(node.get("productName") or "").strip()
            # `is None`, not falsy: a 0 id is not a valid Shopee id, but writing
            # `not item_id` also silently drops it, and the difference between
            # "absent" and "zero" is exactly what a drift bug looks like.
            if item_id is None or shop_id is None or not name:
                log.debug("skipping offer with no itemId/shopId/productName: %s", str(node)[:120])
                return None

            shop_name = str(node.get("shopName") or "").strip() or None
            store = self._shops.get(shop_id)
            if store is None or (shop_name and not store.name):
                store = Store(
                    marketplace=self.marketplace,
                    shop_id=shop_id,
                    # No slug in this payload. Fall back to the id so the row is
                    # identifiable; upsert_store prefers a real slug when the web
                    # adapter later supplies one for the same shop.
                    username=str(shop_id),
                    name=shop_name,
                )
                self._shops[shop_id] = store

            price_min = _decimal(node.get("priceMin"))
            price_max = _decimal(node.get("priceMax"))
            price = price_min or price_max
            if price is None:
                log.debug("skipping offer %s with no usable price", item_id)
                return None

            product = Product(
                marketplace=self.marketplace,
                item_id=item_id,
                shop_id=shop_id,
                name=name,
                url=str(node.get("productLink") or "") or None,
                image=str(node.get("imageUrl") or "") or None,
            )
            snapshot = PriceSnapshot(
                item_id=item_id,
                price=price,
                price_min=price_min,
                price_max=price_max,
                sold=_int(node.get("sales")),
                historical_sold=_int(node.get("sales")),
                # Decimal, not float. PriceSnapshot.rating_star is a Decimal, and
                # routing "4.83" through float first is what produced the
                # 4.833337902673064 noise visible in the scraped rows.
                rating_star=_decimal(node.get("ratingStar")),
            )
            return ScrapedItem(store=store, product=product, snapshot=snapshot)
        except Exception as exc:  # noqa: BLE001 - one bad offer must not kill the walk
            log.warning("skipping malformed affiliate offer (%s): %s", exc, str(node)[:160])
            return None
