import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';
import { DEFAULT_MIN_GAP_HOURS, resolveMinGapHours } from '@/lib/price-change';
import { getProducts } from '@/lib/queries';
import { productFilterSchema } from '@/lib/schemas';

/**
 * The price movement the product table shows, against a real database.
 *
 * What is at stake is not "does a subtraction work" but *which snapshot the
 * subtraction is against*. Adjacent captures in this database disagree about
 * price without anything having been repriced — 37 of 38 pairs 1.5-3.5 hours
 * apart differ — so a badge driven by the immediate predecessor would mark most
 * of the table as moving and mean nothing. The fixtures below are built to catch
 * exactly that: every case has a recent decoy snapshot sitting between the
 * current price and the one the badge is supposed to use.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');

/** Every field at its default, as the page parses an empty URL. */
const anyFilter = productFilterSchema.parse({});

beforeAll(async () => {
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
  vi.unstubAllEnvs();
});

async function addStore(username = 'tokobrick'): Promise<number> {
  const [row] = await sql`
    INSERT INTO stores (marketplace, shop_id, username, name, first_seen, last_seen)
    VALUES ('shopee', ${Math.floor(Math.random() * 1e9)}, ${username}, ${username}, now(), now())
    RETURNING id
  `;
  return row.id;
}

/**
 * One listing and its snapshots, each placed at an explicit age.
 *
 * Ages are hours before now and are what every case here is really about, so
 * they are stated per snapshot rather than derived from insertion order.
 */
async function addProduct(
  storeId: number,
  snapshots: { hoursAgo: number; price: number | null }[],
  name = 'LEGO Creator 31134 Space Shuttle',
): Promise<number> {
  const [product] = await sql`
    INSERT INTO products (marketplace, item_id, shop_ref, name, first_seen, last_seen)
    VALUES ('shopee', ${Math.floor(Math.random() * 1e12)}, ${storeId}, ${name}, now(), now())
    RETURNING id
  `;
  for (const snapshot of snapshots) {
    await sql`
      INSERT INTO price_snapshots (product_ref, price, scraped_at)
      VALUES (${product.id}, ${snapshot.price},
              now() - make_interval(hours => ${snapshot.hoursAgo}))
    `;
  }
  return product.id;
}

/** The single row the fixtures produce. */
async function onlyRow() {
  const { rows } = await getProducts(anyFilter);
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Which snapshot the badge compares against
// ---------------------------------------------------------------------------

describe('the comparison snapshot', () => {
  test('is the newest one at least the gap older, not the one just before', async () => {
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 30, price: 900_000 }, // older than the gap, but not the newest such
      { hoursAgo: 20, price: 1_000_000 }, // the comparison: newest beyond the gap
      { hoursAgo: 2, price: 1_200_000 }, // the decoy: too recent to trust
      { hoursAgo: 0, price: 1_300_000 }, // current
    ]);

    const row = await onlyRow();

    expect(row.price).toBe('1300000');
    expect(row.previousPrice).toBe('1000000');
  });

  test('is absent when nothing is old enough, rather than falling back to the nearest', async () => {
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 3, price: 1_100_000 },
      { hoursAgo: 1, price: 1_150_000 },
      { hoursAgo: 0, price: 1_200_000 },
    ]);

    const row = await onlyRow();

    // Three snapshots, all within the window: "cannot know yet", not "unchanged".
    expect(row.previousPrice).toBeNull();
    expect(row.previousScrapedAt).toBeNull();
  });

  test('is absent for a product seen once', async () => {
    const store = await addStore();
    await addProduct(store, [{ hoursAgo: 0, price: 1_200_000 }]);

    const row = await onlyRow();

    expect(row.previousPrice).toBeNull();
  });

  test('skips snapshots with no price', async () => {
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 40, price: 800_000 },
      { hoursAgo: 20, price: null }, // newer and old enough, but nothing to compare
      { hoursAgo: 0, price: 1_000_000 },
    ]);

    const row = await onlyRow();

    expect(row.previousPrice).toBe('800000');
  });

  test('reports a price that held steady, which is not the same as no comparison', async () => {
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 20, price: 1_000_000 },
      { hoursAgo: 0, price: 1_000_000 },
    ]);

    const row = await onlyRow();

    // The notifier drops equal prices — it has nothing to announce. The table
    // keeps them: "checked, did not move" is worth seeing.
    expect(row.previousPrice).toBe('1000000');
    expect(row.price).toBe('1000000');
  });

  test('carries the timestamp of whichever snapshot it settled on', async () => {
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 20, price: 1_000_000 },
      { hoursAgo: 0, price: 1_300_000 },
    ]);

    const row = await onlyRow();

    const age = (Date.now() - new Date(row.previousScrapedAt as string).getTime()) / 3_600_000;
    expect(age).toBeGreaterThan(19);
    expect(age).toBeLessThan(21);
  });
});

describe('the gap setting', () => {
  test('a gap of zero compares against the immediate predecessor', async () => {
    vi.stubEnv('NOTIFY_MIN_GAP_HOURS', '0');
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 20, price: 1_000_000 },
      { hoursAgo: 2, price: 1_200_000 },
      { hoursAgo: 0, price: 1_300_000 },
    ]);

    const row = await onlyRow();

    expect(row.previousPrice).toBe('1200000');
  });

  test('a gap of zero never compares the newest snapshot against itself', async () => {
    vi.stubEnv('NOTIFY_MIN_GAP_HOURS', '0');
    const store = await addStore();
    await addProduct(store, [{ hoursAgo: 0, price: 1_300_000 }]);

    const row = await onlyRow();

    // Without the `ps.id <> l.id` guard this row would compare to itself and
    // report a confident, permanent "tetap".
    expect(row.previousPrice).toBeNull();
  });

  test('a wider gap reaches further back', async () => {
    vi.stubEnv('NOTIFY_MIN_GAP_HOURS', '48');
    const store = await addStore();
    await addProduct(store, [
      { hoursAgo: 72, price: 700_000 },
      { hoursAgo: 20, price: 1_000_000 },
      { hoursAgo: 0, price: 1_300_000 },
    ]);

    const row = await onlyRow();

    expect(row.previousPrice).toBe('700000');
  });
});

// ---------------------------------------------------------------------------
// The setting itself
// ---------------------------------------------------------------------------

describe('resolveMinGapHours', () => {
  test('falls back to the documented default when unset or blank', () => {
    expect(resolveMinGapHours({})).toBe(DEFAULT_MIN_GAP_HOURS);
    expect(resolveMinGapHours({ NOTIFY_MIN_GAP_HOURS: '   ' })).toBe(DEFAULT_MIN_GAP_HOURS);
  });

  test('takes a whole number of hours, zero included', () => {
    expect(resolveMinGapHours({ NOTIFY_MIN_GAP_HOURS: '6' })).toBe(6);
    expect(resolveMinGapHours({ NOTIFY_MIN_GAP_HOURS: '0' })).toBe(0);
  });

  test.each(['1.5', 'banyak', '-3'])(
    'ignores %s rather than rounding or negating it',
    (raw) => {
      expect(resolveMinGapHours({ NOTIFY_MIN_GAP_HOURS: raw })).toBe(DEFAULT_MIN_GAP_HOURS);
    },
  );
});
