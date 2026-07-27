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
* leave ``first_seen``/``last_seen`` as None and let the repository stamp them.
  ``scraped_at`` is *not* in that list: ``PriceSnapshot`` defaults it to
  ``utcnow()`` and ``store.insert_snapshot`` only fills it when it is None, so an
  adapter should simply not pass it and let the model's default stand;
* convert Shopee-style integer micro-prices to whole-rupiah ``Decimal`` before
  constructing the snapshot;
* **skip, not raise, on a single malformed item** — one bad entry in a page of
  60 must not lose the other 59. Log it and continue;
* raise :class:`scraper.client.BlockedError` upward untouched so the runner can
  fail that target cleanly.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Protocol, runtime_checkable

from scraper.models import Marketplace, ScrapedItem

__all__ = [
    "ScrapedItem",
    "MarketplaceAdapter",
    "AdapterFactory",
    "get_adapter",
    "register_adapter",
    "available_marketplaces",
    "ADAPTER_PATHS",
]


# ``ScrapedItem`` is re-exported from :mod:`scraper.models`, not redeclared here.
#
# The scaffold defined it in both places. Two structurally identical NamedTuples
# are still two distinct classes, so ``isinstance(item, adapters.ScrapedItem)``
# would have been False for an item built from ``models.ScrapedItem`` — a bug
# that only shows up at integration time. ``scraper.models`` is the canonical
# definition (it is the module every other layer already depends on, and its
# ``store`` is ``Store | None``, which the runner needs for keyword hits with no
# resolvable shop). ``from scraper.adapters import ScrapedItem`` keeps working
# exactly as before.


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


AdapterFactory = Callable[..., MarketplaceAdapter]

#: Marketplace -> ``"module.path:ClassName"`` of its adapter.
#:
#: Import is *lazy* (resolved inside :func:`get_adapter`) for two reasons: the
#: concrete modules import ``ScrapedItem`` from this package, so an eager import
#: here would be circular; and a marketplace whose adapter needs an optional
#: dependency must not break ``import scraper.adapters`` for everyone else.
#:
#: Adding Tokopedia is exactly one line here — no runner, CLI or store change.
ADAPTER_PATHS: dict[Marketplace, str] = {
    Marketplace.SHOPEE: "scraper.adapters.shopee:ShopeeAdapter",
}

#: Explicitly registered factories, which take precedence over
#: :data:`ADAPTER_PATHS`. Populated by :func:`register_adapter`.
_FACTORIES: dict[Marketplace, AdapterFactory] = {}


def register_adapter(marketplace: Marketplace | str, factory: AdapterFactory) -> None:
    """Register (or override) the factory used for a marketplace.

    Lets a test substitute a fake adapter, and lets an out-of-tree marketplace
    implementation opt into :func:`get_adapter` without editing this module.

    Args:
        marketplace: Marketplace the factory serves.
        factory: Any callable returning a :class:`MarketplaceAdapter`; it
            receives the ``**kwargs`` passed to :func:`get_adapter`.

    Raises:
        ValueError: If ``marketplace`` is not a known :class:`Marketplace`.
    """
    _FACTORIES[_coerce(marketplace)] = factory


def available_marketplaces() -> tuple[Marketplace, ...]:
    """List the marketplaces :func:`get_adapter` can currently build.

    Returns:
        Marketplaces with a registered factory or a mapped import path, in
        declaration order.
    """
    known = list(ADAPTER_PATHS) + [m for m in _FACTORIES if m not in ADAPTER_PATHS]
    return tuple(known)


def _coerce(marketplace: Marketplace | str) -> Marketplace:
    """Normalise a marketplace argument to a :class:`Marketplace` member.

    Args:
        marketplace: Enum member, or its string value (``"shopee"``).

    Returns:
        The corresponding enum member.

    Raises:
        ValueError: If the string is not a valid marketplace value.
    """
    if isinstance(marketplace, Marketplace):
        return marketplace
    try:
        return Marketplace(str(marketplace).strip().lower())
    except ValueError as exc:  # pragma: no cover - message construction only
        valid = ", ".join(m.value for m in Marketplace)
        raise ValueError(f"unknown marketplace {marketplace!r}; expected one of: {valid}") from exc


def get_adapter(marketplace: Marketplace | str, **kwargs: object) -> MarketplaceAdapter:
    """Registry lookup: marketplace -> concrete adapter instance.

    The one place that maps an enum member to an implementation, so the CLI and
    the runner never import a concrete adapter module. Adding Tokopedia means
    adding one entry to :data:`ADAPTER_PATHS`.

    Args:
        marketplace: Which marketplace to build an adapter for. Accepts the enum
            member or its string value, so ``get_adapter("shopee")`` works.
        **kwargs: Forwarded to the adapter's constructor (e.g. ``client=``).

    Returns:
        A ready-to-use adapter satisfying :class:`MarketplaceAdapter`.

    Raises:
        ValueError: If ``marketplace`` is not a valid marketplace value at all.
        NotImplementedError: If the marketplace has no adapter yet — the
            expected outcome for ``Marketplace.TOKOPEDIA`` today.
    """
    member = _coerce(marketplace)

    factory = _FACTORIES.get(member)
    if factory is None:
        path = ADAPTER_PATHS.get(member)
        if path is None:
            supported = ", ".join(m.value for m in available_marketplaces())
            raise NotImplementedError(
                f"no adapter implemented for marketplace {member.value!r}; "
                f"currently supported: {supported}"
            )
        module_name, _, class_name = path.partition(":")
        factory = getattr(importlib.import_module(module_name), class_name)

    return factory(**kwargs)
