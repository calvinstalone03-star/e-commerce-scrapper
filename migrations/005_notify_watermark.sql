-- Where the Telegram notifier left off.
--
-- One row, three ids. The notifier asks "what has an id larger than this?" and
-- sends what comes back. Keyed on ids rather than timestamps because all three
-- source columns are serial and therefore monotonic, which makes this immune to
-- clock skew between the scraping laptop and the hosted database, to a scrape
-- whose `scraped_at` arrives out of order (real here — see the `abs()` in
-- scraper/store.py's insert_snapshot_if_changed), and to the overlap window a
-- time-based watermark has to guess at.
--
-- This is the one table the dashboard writes to. Its schema still lives here,
-- with every other table, so there is exactly one migration authority.
--
-- Idempotent like its neighbours: there is no applied-migrations ledger in this
-- directory, so re-running is the recovery path.

CREATE TABLE IF NOT EXISTS notify_watermark (
    id                    integer     PRIMARY KEY,
    last_snapshot_id      bigint      NOT NULL DEFAULT 0,
    last_product_id       integer     NOT NULL DEFAULT 0,
    last_store_id         integer     NOT NULL DEFAULT 0,
    last_stale_warning_at timestamptz,
    updated_at            timestamptz,
    -- Singleton enforced by the schema rather than by convention: a second row
    -- would mean two notifiers with two opinions about what has been sent.
    CONSTRAINT ck_notify_watermark_singleton CHECK (id = 1)
);

-- Seeded to the current maximums, not to zero. Everything already in the
-- database predates the notifier, and announcing 32 long-known shops as new
-- shops is not a useful first notification.
--
-- ON CONFLICT DO NOTHING rather than DO UPDATE: re-running this migration must
-- never rewind the watermark and re-send what has already been sent.
INSERT INTO notify_watermark (id, last_snapshot_id, last_product_id, last_store_id, updated_at)
VALUES (1,
        COALESCE((SELECT max(id) FROM price_snapshots), 0),
        COALESCE((SELECT max(id) FROM products), 0),
        COALESCE((SELECT max(id) FROM stores), 0),
        now())
ON CONFLICT (id) DO NOTHING;
