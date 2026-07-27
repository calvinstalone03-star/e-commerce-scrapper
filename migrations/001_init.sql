-- migrations/001_init.sql
--
-- Initial schema for ecom-scraper.
--
-- This file is the SQL twin of the ORM tables in scraper/db.py; the module
-- docstring there is the single source of truth. Column names, types, nullability,
-- constraint names and index names below match those ORM classes 1:1, so that
-- `init_db()` produces an identical schema whichever path it takes (this file, or
-- the `Base.metadata.create_all()` fallback).
--
-- Idempotency: every statement is IF NOT EXISTS. The UNIQUE constraints are
-- declared INLINE in their CREATE TABLE rather than via ALTER TABLE, because
-- Postgres has no `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS`; inlining makes
-- the whole statement a no-op on re-run. `ecom-scraper initdb` is therefore safe
-- to run repeatedly, which is the recovery path (there is no migration ledger yet).
--
-- Conventions:
--   * Every timestamp column is `timestamptz`; the application writes tz-aware UTC.
--   * Money and rating columns are `numeric` (never float/double). Shopee returns
--     integer micro-units (rupiah * 100000) and the adapter divides down, so values
--     arriving here are already whole rupiah.
--   * `shop_id` / `item_id` are the MARKETPLACE's ids. `shop_ref` / `product_ref`
--     are OUR primary keys. They are not interchangeable.
--   * Constraint and index names are fixed, because scraper/store.py targets them
--     by name in `ON CONFLICT ON CONSTRAINT ...` clauses. Renaming one breaks the
--     upserts at runtime, not at import time.


-- ---------------------------------------------------------------------------
-- stores — one row per seller/shop. Natural key: (marketplace, shop_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
    id             serial       PRIMARY KEY,
    marketplace    text         NOT NULL,
    shop_id        bigint       NOT NULL,
    username       text         NOT NULL,
    name           text,
    location       text,
    follower_count integer,
    rating_star    numeric,
    first_seen     timestamptz,
    last_seen      timestamptz,
    CONSTRAINT uq_stores_marketplace_shop_id UNIQUE (marketplace, shop_id)
);


-- ---------------------------------------------------------------------------
-- products — one row per listing. Natural key: (marketplace, item_id).
-- Slow-changing attributes only; everything volatile lives in price_snapshots.
-- shop_ref is nullable: keyword search results occasionally omit shop detail,
-- and a later store-mode scrape backfills it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id          serial   PRIMARY KEY,
    marketplace text     NOT NULL,
    item_id     bigint   NOT NULL,
    shop_ref    integer,
    name        text,
    url         text,
    image       text,
    category    text,
    first_seen  timestamptz,
    last_seen   timestamptz,
    CONSTRAINT uq_products_marketplace_item_id UNIQUE (marketplace, item_id),
    CONSTRAINT fk_products_shop_ref FOREIGN KEY (shop_ref) REFERENCES stores (id)
);


-- ---------------------------------------------------------------------------
-- price_snapshots — append-only time series. One row per (product, scrape).
-- Nothing ever UPDATEs a row here; diffing consecutive rows for a product_ref
-- is what yields price movement and units-sold velocity.
-- bigserial because this is the table that grows without bound.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_snapshots (
    id              bigserial PRIMARY KEY,
    product_ref     integer,
    price           numeric,
    price_min       numeric,
    price_max       numeric,
    stock           integer,
    sold            integer,
    historical_sold integer,
    rating_star     numeric,
    rating_count    integer,
    scraped_at      timestamptz,
    CONSTRAINT fk_price_snapshots_product_ref FOREIGN KEY (product_ref) REFERENCES products (id)
);

-- Serves both dashboard reads: "latest snapshot per product" (DISTINCT ON
-- (product_ref) ORDER BY product_ref, scraped_at DESC) and "history for one
-- product" (WHERE product_ref = ? ORDER BY scraped_at DESC). The DESC on
-- scraped_at matches the read order so Postgres can walk the index backwards-free.
CREATE INDEX IF NOT EXISTS ix_price_snapshots_product_ref_scraped_at
    ON price_snapshots (product_ref, scraped_at DESC);


-- ---------------------------------------------------------------------------
-- scrape_runs — audit log. One row PER TARGET per invocation (per keyword, or
-- per shop username), not one per CLI run, so a single bad target shows up as
-- one FAILED row without hiding the successful ones.
-- A row left at status='running' means the process died mid-target.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_runs (
    id          serial PRIMARY KEY,
    marketplace text,
    mode        text,
    target      text,
    started_at  timestamptz,
    finished_at timestamptz,
    status      text,
    item_count  integer,
    error       text
);
