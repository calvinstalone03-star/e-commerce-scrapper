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
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "Marketplace",
    "RunMode",
    "RunStatus",
    "Store",
    "Product",
    "PriceSnapshot",
    "ScrapeRun",
    "utcnow",
]


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


def utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC ``datetime``.

    Single source of truth for "now" across the package so that ``first_seen``,
    ``last_seen`` and ``scraped_at`` in one run share a consistent clock and are
    trivially patchable in tests.

    Returns:
        Timezone-aware ``datetime`` with ``tzinfo`` set to UTC.
    """
    raise NotImplementedError


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


class Product(BaseModel):
    """A listing on a marketplace.

    Natural key is ``(marketplace, item_id)``, matching the unique constraint on
    the ``products`` table. Holds only the *slow-changing* attributes of a
    listing; everything that moves (price, stock, sold, rating) belongs on
    :class:`PriceSnapshot` so the same product accumulates a time series.
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


class PriceSnapshot(BaseModel):
    """One point-in-time observation of a listing's volatile fields.

    Append-only: never updated, one row per (product, scrape). This is the table
    that turns the scraper into a price/velocity tracker — diffing consecutive
    snapshots for a ``product_ref`` gives price movement and units sold between
    scrapes.

    ``item_id`` is carried here (rather than a DB ref) so an adapter can build a
    snapshot without touching the database; ``store.insert_snapshot`` resolves it
    to ``products.id`` and writes that into ``price_snapshots.product_ref``.
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
        default=None,
        description="UTC observation time. Set by the repository on insert if left None.",
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
