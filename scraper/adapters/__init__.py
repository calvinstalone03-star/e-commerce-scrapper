"""Marketplace adapter contract.

An adapter is the only place that knows a marketplace's URLs, payload shapes and
pagination quirks. Everything downstream — :mod:`scraper.runner`,
:mod:`scraper.store`, the CLI — is written against this Protocol, which is what
makes Tokopedia a drop-in addition rather than a rewrite: implement the same
three methods, register the class, done.

The unit of exchange is :class:`ScrapedItem`, a 3-tuple of
``(Store, Product, PriceSnapshot)``. Every scraped listing yields exactly one of
these, fully denormalised, so the runner can persist a row without calling back
into the adapter. It is a NamedTuple, so ``for store, product, snapshot in
adapter.search_keyword(...)`` unpacks positionally.

Adapters must:

* return domain models from :mod:`scraper.models`, never raw dicts;
* leave ``first_seen``/``last_seen``/``scraped_at`` as None and let the
  repository stamp them (only exception: an adapter may set ``scraped_at`` when
  the payload carries a server-side observation time);
* convert Shopee-style integer micro-prices to whole-rupiah ``Decimal`` before
  constructing the snapshot;
* **skip, not raise, on a single malformed item** — one bad entry in a page of
  60 must not lose the other 59. Log it and continue;
* raise :class:`scraper.client.BlockedError` upward untouched so the runner can
  fail that target cleanly.
"""

from __future__ import annotations

from typing import NamedTuple, Protocol, runtime_checkable

from scraper.models import Marketplace, PriceSnapshot, Product, Store

__all__ = ["ScrapedItem", "MarketplaceAdapter", "get_adapter"]


class ScrapedItem(NamedTuple):
    """One fully-denormalised scraped listing.

    Attributes:
        store: The owning shop. Carries required output field #1 (``username``).
        product: The listing. Carries required output field #2 (``name``).
        snapshot: The volatile observation. Carries required output fields
            #3 ``price``, #4 ``sold`` and #5 ``rating_star``.
    """

    store: Store
    product: Product
    snapshot: PriceSnapshot


@runtime_checkable
class MarketplaceAdapter(Protocol):
    """What every marketplace implementation must provide.

    Implementations are constructed with an already-built client (see
    :class:`scraper.adapters.shopee.ShopeeAdapter`); the Protocol deliberately
    does not constrain ``__init__`` so a future adapter can take whatever
    transport it needs.
    """

    marketplace: Marketplace

    def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk search-result pages for a keyword.

        Pagination is the adapter's concern: it translates ``pages`` into
        whatever offset/limit scheme the marketplace uses, and stops early when a
        page comes back short or empty rather than requesting known-empty pages.

        Args:
            keyword: Raw search phrase, e.g. ``"sepatu pria"``. The adapter does
                its own URL encoding.
            pages: Maximum number of result pages to walk. Must be >= 1.

        Returns:
            One :class:`ScrapedItem` per listing found, in marketplace order,
            de-duplicated on ``item_id`` within the call. Empty list when the
            keyword has no results — that is not an error.

        Raises:
            ValueError: If ``pages`` < 1.
            scraper.client.BlockedError: If the marketplace blocked us and a
                cookie re-bootstrap did not clear it.
        """
        ...

    def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]:
        """Walk a single shop's product listing.

        Typically resolves ``username`` -> ``shop_id`` first (via
        :meth:`get_shop`, whose result should be reused for every
        ``ScrapedItem.store`` in the return value rather than re-fetched).

        Args:
            username: Shop URL slug, e.g. ``"erigostore"``.
            pages: Maximum number of listing pages to walk. Must be >= 1.

        Returns:
            One :class:`ScrapedItem` per listing, de-duplicated on ``item_id``.
            Empty list for a shop with no active listings.

        Raises:
            ValueError: If ``pages`` < 1.
            LookupError: If the shop does not exist.
            scraper.client.BlockedError: As above.
        """
        ...

    def get_shop(self, username: str) -> Store:
        """Resolve a shop username to a fully populated :class:`Store`.

        This is the ``username -> shop_id`` lookup the rest of the system needs,
        since ``config/stores.txt`` holds slugs but the natural key is the
        numeric id.

        Args:
            username: Shop URL slug.

        Returns:
            A Store with ``marketplace``, ``shop_id`` and ``username`` always
            populated; the descriptive fields on a best-effort basis.

        Raises:
            LookupError: If the shop does not exist.
            scraper.client.BlockedError: As above.
        """
        ...


def get_adapter(marketplace: Marketplace, **kwargs: object) -> MarketplaceAdapter:
    """Registry lookup: marketplace -> concrete adapter instance.

    The one place that maps an enum member to an implementation, so the CLI and
    the runner never import a concrete adapter module. Adding Tokopedia means
    adding one entry here.

    Args:
        marketplace: Which marketplace to build an adapter for.
        **kwargs: Forwarded to the adapter's constructor (e.g. ``client=``).

    Returns:
        A ready-to-use adapter satisfying :class:`MarketplaceAdapter`.

    Raises:
        NotImplementedError: If the marketplace has no adapter yet — the
            expected outcome for ``Marketplace.TOKOPEDIA`` today.
    """
    raise NotImplementedError
