import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { sql } from '@/lib/db';
import {
  advanceWatermark,
  readCeilings,
  readWatermarkForUpdate,
  stampStaleWarning,
} from '@/lib/notify/watermark';

/**
 * The notifier's memory, against a real database.
 *
 * What is at stake is not "does the UPDATE run" but "can an event be sent
 * twice, or missed entirely". Both failures are silent, so the cases below are
 * about the boundary: a ceiling read once and advanced to exactly, and rows
 * arriving mid-run landing on the correct side of it.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');

beforeAll(async () => {
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
  // notify_watermark is deliberately not in that TRUNCATE — it is not a
  // fixture table, and RESTART IDENTITY has nothing to restart on it. Reset it
  // by hand so each case starts from a stated position.
  await sql`
    UPDATE notify_watermark
       SET last_snapshot_id = 0, last_product_id = 0, last_store_id = 0,
           last_stale_warning_at = NULL
     WHERE id = 1`;
});

async function seedOneSnapshot(): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own)
    VALUES (1, 'shopee', 111, 'toko-a', false)`;
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name)
    VALUES (1, 'shopee', 222, 1, 'LEGO Technic 42218')`;
  await sql`
    INSERT INTO price_snapshots (product_ref, price, scraped_at)
    VALUES (1, 100000, now())`;
}

describe('readWatermarkForUpdate', () => {
  test('reads the singleton row', async () => {
    const watermark = await sql.begin((tx) => readWatermarkForUpdate(tx));
    expect(watermark.lastSnapshotId).toBe('0');
    expect(watermark.lastProductId).toBe(0);
    expect(watermark.lastStoreId).toBe(0);
    expect(watermark.lastStaleWarningAt).toBeNull();
  });
});

describe('readCeilings', () => {
  test('is zero on an empty database rather than null', async () => {
    const ceilings = await sql.begin((tx) => readCeilings(tx));
    expect(ceilings).toEqual({ snapshotId: '0', productId: 0, storeId: 0 });
  });

  test('reports the largest id present in each table', async () => {
    await seedOneSnapshot();
    const ceilings = await sql.begin((tx) => readCeilings(tx));
    expect(ceilings).toEqual({ snapshotId: '1', productId: 1, storeId: 1 });
  });
});

describe('advanceWatermark', () => {
  test('moves the watermark to the ceilings it was given', async () => {
    await seedOneSnapshot();
    await sql.begin(async (tx) => {
      const ceilings = await readCeilings(tx);
      await advanceWatermark(tx, ceilings);
    });

    const after = await sql.begin((tx) => readWatermarkForUpdate(tx));
    expect(after.lastSnapshotId).toBe('1');
    expect(after.lastProductId).toBe(1);
    expect(after.lastStoreId).toBe(1);
  });

  test('leaves a row that arrived after the ceiling was read for the next run', async () => {
    await seedOneSnapshot();

    await sql.begin(async (tx) => {
      const ceilings = await readCeilings(tx);
      // Stands in for a scrape landing mid-run. It must not be swallowed by an
      // advance that was computed before it existed.
      await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 120000, now())`;
      await advanceWatermark(tx, ceilings);
    });

    const after = await sql.begin((tx) => readWatermarkForUpdate(tx));
    expect(after.lastSnapshotId).toBe('1');

    const ceilings = await sql.begin((tx) => readCeilings(tx));
    expect(ceilings.snapshotId).toBe('2');
  });
});

describe('stampStaleWarning', () => {
  test('records when the last staleness warning went out', async () => {
    const at = new Date('2026-08-03T02:00:00Z');
    await sql.begin((tx) => stampStaleWarning(tx, at));

    const after = await sql.begin((tx) => readWatermarkForUpdate(tx));
    expect(after.lastStaleWarningAt?.toISOString()).toBe(at.toISOString());
  });
});
