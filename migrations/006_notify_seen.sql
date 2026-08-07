-- How far the reader has seen. One row, one id.
--
-- Ids, not timestamps: scraped_at arrives out of order in this database (see
-- the abs() in scraper/store.py insert_snapshot_if_changed), and a clock-based
-- marker would file a genuinely new row as already read.
--
-- This marker never filters the notifications list. It decides which rows are
-- styled new. Filtering on it is what made the first draft render an empty page
-- on day one — see the design doc.

CREATE TABLE IF NOT EXISTS notify_seen (
    id                     integer     PRIMARY KEY,
    last_seen_snapshot_id  bigint      NOT NULL DEFAULT 0,
    updated_at             timestamptz,
    CONSTRAINT ck_notify_seen_singleton CHECK (id = 1)
);

-- Seeded in three arms, in this order.
--
-- The to_regclass guard is required, not defensive: a plain
-- `SELECT ... FROM notify_watermark` in a database that never had it is a parse
-- error that aborts the whole file, and db.py sends each migration as one
-- exec_driver_sql. An untaken plpgsql branch is never planned, so this is safe.
--
-- Arm two matters on its own. Falling straight to 0 on a database 005 never
-- reached would announce the entire history as unread.
DO $$
DECLARE seed bigint;
BEGIN
    IF to_regclass('public.notify_watermark') IS NOT NULL THEN
        SELECT w.last_snapshot_id INTO seed FROM notify_watermark w WHERE w.id = 1;
    END IF;
    seed := COALESCE(seed, (SELECT max(id) FROM price_snapshots), 0);

    -- DO NOTHING, never DO UPDATE: a second pass must neither rewind the marker
    -- nor fast-forward it past rows the reader has not seen.
    INSERT INTO notify_seen (id, last_seen_snapshot_id, updated_at)
    VALUES (1, seed, now())
    ON CONFLICT (id) DO NOTHING;
END $$;
