"""SQLAlchemy engine, session factory and declarative ORM tables.

This module is the single source of truth for the database schema.
``migrations/001_init.sql`` must agree with it column for column.

Canonical Postgres schema
-------------------------

::

    stores(
        id             serial       primary key,
        marketplace    text         not null,
        shop_id        bigint       not null,
        username       text         not null,
        name           text,
        location       text,
        follower_count int,
        rating_star    numeric,
        first_seen     timestamptz,
        last_seen      timestamptz,
        unique (marketplace, shop_id)          -- uq_stores_marketplace_shop_id
    )

    products(
        id           serial   primary key,
        marketplace  text     not null,
        item_id      bigint   not null,
        shop_ref     int      references stores(id),
        name         text,
        url          text,
        image        text,
        category     text,
        first_seen   timestamptz,
        last_seen    timestamptz,
        unique (marketplace, item_id)          -- uq_products_marketplace_item_id
    )

    price_snapshots(
        id              bigserial  primary key,
        product_ref     int        references products(id),
        price           numeric,
        price_min       numeric,
        price_max       numeric,
        stock           int,
        sold            int,
        historical_sold int,
        rating_star     numeric,
        rating_count    int,
        scraped_at      timestamptz,
        index on (product_ref, scraped_at desc)  -- ix_price_snapshots_product_ref_scraped_at
    )

    scrape_runs(
        id          serial  primary key,
        marketplace text,
        mode        text,
        target      text,
        started_at  timestamptz,
        finished_at timestamptz,
        status      text,
        item_count  int,
        error       text
    )

Rules that both this module and the SQL migration must honour:

* Every timestamp column is ``timestamptz`` (``DateTime(timezone=True)``); the
  application always writes timezone-aware UTC.
* Money and rating columns are ``numeric`` mapped to :class:`decimal.Decimal` —
  never float.
* ``shop_ref`` / ``product_ref`` are **our** primary keys. ``shop_id`` /
  ``item_id`` are the **marketplace's** ids. Do not conflate them.
* ``price_snapshots`` is append-only. Nothing updates a snapshot row.
* Constraint and index names are fixed (see comments above) because
  ``scraper/store.py`` targets them in ``ON CONFLICT`` clauses.

ORM class names are suffixed ``Row`` so they never collide with the Pydantic
models of the same concept in :mod:`scraper.models`.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

__all__ = [
    "Base",
    "StoreRow",
    "ProductRow",
    "PriceSnapshotRow",
    "ScrapeRunRow",
    "get_engine",
    "get_sessionmaker",
    "session_scope",
    "init_db",
    "run_migrations",
]


class Base(DeclarativeBase):
    """Declarative base for all ORM tables in this project."""


class StoreRow(Base):
    """ORM mapping for ``stores``. Natural key: ``(marketplace, shop_id)``."""

    __tablename__ = "stores"
    __table_args__ = (
        UniqueConstraint("marketplace", "shop_id", name="uq_stores_marketplace_shop_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    marketplace: Mapped[str] = mapped_column(Text, nullable=False)
    shop_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    username: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(Text)
    follower_count: Mapped[int | None] = mapped_column(Integer)
    rating_star: Mapped[Decimal | None] = mapped_column(Numeric)
    first_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    products: Mapped[list["ProductRow"]] = relationship(back_populates="shop")


class ProductRow(Base):
    """ORM mapping for ``products``. Natural key: ``(marketplace, item_id)``."""

    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("marketplace", "item_id", name="uq_products_marketplace_item_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    marketplace: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    shop_ref: Mapped[int | None] = mapped_column(Integer, ForeignKey("stores.id"))
    name: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    image: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)
    first_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    shop: Mapped["StoreRow | None"] = relationship(back_populates="products")
    snapshots: Mapped[list["PriceSnapshotRow"]] = relationship(back_populates="product")


class PriceSnapshotRow(Base):
    """ORM mapping for ``price_snapshots``. Append-only time series."""

    __tablename__ = "price_snapshots"
    __table_args__ = (
        Index(
            "ix_price_snapshots_product_ref_scraped_at",
            "product_ref",
            "scraped_at",
            postgresql_ops={"scraped_at": "DESC"},
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    product_ref: Mapped[int | None] = mapped_column(Integer, ForeignKey("products.id"))
    price: Mapped[Decimal | None] = mapped_column(Numeric)
    price_min: Mapped[Decimal | None] = mapped_column(Numeric)
    price_max: Mapped[Decimal | None] = mapped_column(Numeric)
    stock: Mapped[int | None] = mapped_column(Integer)
    sold: Mapped[int | None] = mapped_column(Integer)
    historical_sold: Mapped[int | None] = mapped_column(Integer)
    rating_star: Mapped[Decimal | None] = mapped_column(Numeric)
    rating_count: Mapped[int | None] = mapped_column(Integer)
    scraped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    product: Mapped["ProductRow | None"] = relationship(back_populates="snapshots")


class ScrapeRunRow(Base):
    """ORM mapping for ``scrape_runs``. One row per target per invocation."""

    __tablename__ = "scrape_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    marketplace: Mapped[str | None] = mapped_column(Text)
    mode: Mapped[str | None] = mapped_column(Text)
    target: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str | None] = mapped_column(Text)
    item_count: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)


def get_engine(database_url: str | None = None, *, echo: bool = False) -> Engine:
    """Build (and process-cache) the SQLAlchemy :class:`Engine`.

    Normalises the URL to the psycopg 3 driver: a bare ``postgresql://`` or a
    legacy ``postgres://`` prefix is rewritten to ``postgresql+psycopg://`` so
    the ``psycopg[binary]`` dependency is what actually connects.

    The engine must be cached per URL — creating one per call would leak
    connection pools across a long run.

    Args:
        database_url: Override URL. Defaults to ``get_settings().database_url``.
        echo: Log every emitted statement. Debugging aid only.

    Returns:
        A configured Engine with ``pool_pre_ping=True``.
    """
    raise NotImplementedError


def get_sessionmaker(database_url: str | None = None) -> sessionmaker[Session]:
    """Return the session factory bound to :func:`get_engine`.

    Configured with ``expire_on_commit=False`` so repository functions can return
    ORM rows (or ids read off them) that stay usable after the caller commits.

    Args:
        database_url: Override URL, forwarded to :func:`get_engine`.

    Returns:
        A ``sessionmaker`` producing :class:`sqlalchemy.orm.Session` objects.
    """
    raise NotImplementedError


@contextmanager
def session_scope(database_url: str | None = None) -> Iterator[Session]:
    """Context manager yielding a Session that commits on exit, rolls back on error.

    The runner opens one scope per target so a failing target cannot poison the
    inserts of a successful one.

    Args:
        database_url: Override URL, forwarded to :func:`get_sessionmaker`.

    Yields:
        An open Session.

    Raises:
        Exception: Re-raises whatever the body raised, after rolling back and
            closing the session.
    """
    raise NotImplementedError


def run_migrations(engine: Engine, migrations_dir: str = "migrations") -> list[str]:
    """Execute the ``.sql`` files in ``migrations_dir`` in lexicographic order.

    Each file is run in its own transaction. Files are expected to be idempotent
    (``CREATE TABLE IF NOT EXISTS`` etc.) because there is no applied-migrations
    ledger yet — re-running is the recovery path.

    Args:
        engine: Engine to execute against.
        migrations_dir: Directory holding numbered ``.sql`` files.

    Returns:
        Filenames applied, in the order they ran.

    Raises:
        sqlalchemy.exc.SQLAlchemyError: If any file fails; earlier files stay applied.
    """
    raise NotImplementedError


def init_db(database_url: str | None = None) -> None:
    """Create the schema. Backs ``ecom-scraper initdb``.

    Applies ``migrations/*.sql`` via :func:`run_migrations` when that directory
    contains real DDL, and otherwise falls back to
    ``Base.metadata.create_all(engine)`` so the project is usable before the db
    agent has filled in ``001_init.sql``. Either path must be idempotent.

    Args:
        database_url: Override URL. Defaults to ``get_settings().database_url``.

    Raises:
        sqlalchemy.exc.OperationalError: If Postgres is unreachable.
    """
    raise NotImplementedError
