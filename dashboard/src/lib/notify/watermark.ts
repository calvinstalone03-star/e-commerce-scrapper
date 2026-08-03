import 'server-only';

import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db';

/**
 * Where the notifier left off.
 *
 * `notify_watermark` is one of the two tables this app writes to —
 * `app_credentials` (`lib/auth.ts`) is the other — and both are its own. The
 * rule `db.ts` sets out still holds everywhere it matters: nothing here touches
 * `stores`, `products`, `price_snapshots` or `scrape_runs`, and the schema is
 * still created by a Python migration.
 *
 * Ids rather than timestamps throughout. `price_snapshots.id` is bigserial and
 * the other two are serial, so "larger than the watermark" is a total order
 * that no clock can disagree with.
 */

/** The client, or a transaction handle over it. Both accept the same tags. */
export type Sql = typeof sql | TransactionSql<Record<string, never>>;

export type Watermark = {
  /** `bigint`, so a string: it is compared by Postgres, never by JavaScript. */
  lastSnapshotId: string;
  lastProductId: number;
  lastStoreId: number;
  lastStaleWarningAt: Date | null;
};

export type Ceilings = {
  snapshotId: string;
  productId: number;
  storeId: number;
};

/**
 * Read the watermark and hold it for the rest of the transaction.
 *
 * `FOR UPDATE` is what makes two triggers firing at once safe: the second waits
 * for the first to commit, then reads a watermark that has already moved past
 * everything the first sent, and finds nothing to do. Without it both would read
 * the same starting point and send the same digest twice.
 */
export async function readWatermarkForUpdate(tx: Sql): Promise<Watermark> {
  const [row] = await tx<
    {
      last_snapshot_id: string;
      last_product_id: number;
      last_store_id: number;
      last_stale_warning_at: Date | null;
    }[]
  >`
    SELECT last_snapshot_id, last_product_id, last_store_id, last_stale_warning_at
      FROM notify_watermark
     WHERE id = 1
       FOR UPDATE`;

  if (!row) {
    // The migration seeds this row, so its absence means the migration has not
    // been applied to whichever database DATABASE_URL names. Saying so beats a
    // TypeError on `undefined.last_snapshot_id` three frames away.
    throw new Error(
      'notify_watermark has no row. Apply migrations/005_notify_watermark.sql ' +
        'to this database (`ecom-scraper initdb`).',
    );
  }

  return {
    lastSnapshotId: String(row.last_snapshot_id),
    lastProductId: row.last_product_id,
    lastStoreId: row.last_store_id,
    lastStaleWarningAt: row.last_stale_warning_at,
  };
}

/**
 * The largest committed id in each source table, read once per run.
 *
 * Every query below bounds itself by these rather than by "whatever is in the
 * table now", and the watermark advances to exactly these. That is what stops a
 * row from being examined twice, and it closes the race a bare `max(id)` at the
 * end would open: a row that arrives while the run is in flight sits above the
 * ceiling and waits for the next run, which starts precisely where this one
 * stopped looking.
 *
 * What it does not promise is that nothing is ever skipped, and the word
 * "committed" above is where the gap is. A sequence hands out ids before the
 * transaction holding one commits, so a writer can be sitting on id 500 while
 * `max(id)` answers 499. This run then advances the watermark to 499, that
 * writer commits, and its row is below the watermark for good: never examined,
 * never reported. Both writers are real — `runner.py:1202` and
 * `ingest.py:396`, and ingest commits once per captured page — so the window is
 * genuinely open, not theoretical.
 *
 * It is left open deliberately. Closing it properly means reading the ceilings
 * from `pg_snapshot_xmin(pg_current_snapshot())` rather than `max(id)`, or
 * taking a lock the scraper would then have to respect, and the cost of the
 * failure does not justify either: the window is the moment between one
 * `max(id)` and one `UPDATE`, the loss is one run's worth of one page's rows,
 * and the same product's next price change is reported normally. A missed
 * notification is recoverable by opening the dashboard. Blocking the scraper to
 * prevent it is not.
 */
export async function readCeilings(tx: Sql): Promise<Ceilings> {
  const [row] = await tx<{ snapshot_id: string; product_id: number; store_id: number }[]>`
    SELECT COALESCE((SELECT max(id) FROM price_snapshots), 0) AS snapshot_id,
           COALESCE((SELECT max(id) FROM products), 0)        AS product_id,
           COALESCE((SELECT max(id) FROM stores), 0)          AS store_id`;

  return {
    snapshotId: String(row.snapshot_id),
    productId: row.product_id,
    storeId: row.store_id,
  };
}

export async function advanceWatermark(tx: Sql, ceilings: Ceilings): Promise<void> {
  await tx`
    UPDATE notify_watermark
       SET last_snapshot_id = ${ceilings.snapshotId},
           last_product_id  = ${ceilings.productId},
           last_store_id    = ${ceilings.storeId},
           updated_at       = now()
     WHERE id = 1`;
}

/**
 * Remember that a staleness warning went out, so a database that has been
 * frozen for weeks does not become the source of its own daily spam.
 */
export async function stampStaleWarning(tx: Sql, at: Date): Promise<void> {
  await tx`
    UPDATE notify_watermark
       SET last_stale_warning_at = ${at}
     WHERE id = 1`;
}
