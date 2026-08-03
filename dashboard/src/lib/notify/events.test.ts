import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { sql } from '@/lib/db';
import { collectEvents, latestScrapedAt } from '@/lib/notify/events';
import { readCeilings, readWatermarkForUpdate } from '@/lib/notify/watermark';

/**
 * What counts as news, against a real database.
 *
 * The load-bearing case is the minimum gap. The production data contains 38
 * snapshot pairs captured 1.5-3.5 hours apart, 37 of which differ in price,
 * against 1,335 pairs captured 111.9 hours apart, 3 of which differ. A 400x
 * difference in rate, with `sold` identical across the near pairs — one payload
 * read twice, not 37 sellers repricing. These cases pin the rule that keeps
 * those out.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');
const HOUR = 3600 * 1000;
const BASE = new Date('2026-08-01T00:00:00Z');

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
  await sql`
    UPDATE notify_watermark
       SET last_snapshot_id = 0, last_product_id = 0, last_store_id = 0,
           last_stale_warning_at = NULL
     WHERE id = 1`;
});

async function addStore(id: number, username: string, isOwn = false): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (${id}, 'shopee', ${id * 1000}, ${username}, ${isOwn}, ${BASE}, ${BASE})`;
}

async function addProduct(id: number, storeId: number | null, name: string): Promise<void> {
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, url, first_seen, last_seen)
    VALUES (${id}, 'shopee', ${id * 100}, ${storeId}, ${name},
            ${name.match(/\b(\d{5})\b/)?.[1] ?? null},
            ${'https://shopee.co.id/p/' + id}, ${BASE}, ${BASE})`;
}

async function addSnapshot(productId: number, price: number, hoursAfterBase: number): Promise<void> {
  await sql`
    INSERT INTO price_snapshots (product_ref, price, sold, scraped_at)
    VALUES (${productId}, ${price}, 100, ${new Date(BASE.getTime() + hoursAfterBase * HOUR)})`;
}

/** Read the current watermark and ceilings, then collect. The whole run, once. */
async function collect(minGapHours: number) {
  return sql.begin(async (tx) => {
    const watermark = await readWatermarkForUpdate(tx);
    const ceilings = await readCeilings(tx);
    return collectEvents(tx, watermark, ceilings, minGapHours);
  });
}

describe('price changes', () => {
  test('reports a change when the comparison snapshot is old enough', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 186850, 0);
    await addSnapshot(1, 211850, 24);

    const { priceChanges } = await collect(12);

    expect(priceChanges).toHaveLength(1);
    expect(priceChanges[0]).toMatchObject({
      productId: 1,
      setCode: '42218',
      username: 'rival-a',
      isOwn: false,
      previousPrice: '186850',
      price: '211850',
    });
  });

  test('ignores a change whose only comparison is too recent', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 186850, 0);
    await addSnapshot(1, 211850, 3);

    expect((await collect(12)).priceChanges).toHaveLength(0);
  });

  test('reports the same pair once the threshold is lowered', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 186850, 0);
    await addSnapshot(1, 211850, 3);

    expect((await collect(0)).priceChanges).toHaveLength(1);
  });

  test('compares against the newest snapshot past the threshold, not the oldest', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 100000, 0); // too old to be the comparison
    await addSnapshot(1, 150000, 48); // this one is
    await addSnapshot(1, 175000, 72);

    const { priceChanges } = await collect(12);
    expect(priceChanges).toHaveLength(1);
    expect(priceChanges[0].previousPrice).toBe('150000');
  });

  test('emits one event for a product captured several times in one run', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 100000, 0);
    await addSnapshot(1, 150000, 48);
    await addSnapshot(1, 160000, 49);

    const { priceChanges } = await collect(12);
    expect(priceChanges).toHaveLength(1);
    // The newest capture is the one reported.
    expect(priceChanges[0].price).toBe('160000');
  });

  test('says nothing when a price becomes known for the first time', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await sql`
      INSERT INTO price_snapshots (product_ref, price, scraped_at)
      VALUES (1, NULL, ${BASE})`;
    await addSnapshot(1, 211850, 24);

    expect((await collect(12)).priceChanges).toHaveLength(0);
  });

  test('says nothing when the price is unchanged', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 186850, 0);
    await addSnapshot(1, 186850, 24);

    expect((await collect(12)).priceChanges).toHaveLength(0);
  });

  test('drops a product whose every snapshot is too close together', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 186850, 0);
    await addSnapshot(1, 211850, 1);
    await addSnapshot(1, 236850, 2);

    expect((await collect(12)).priceChanges).toHaveLength(0);
  });

  test('still reports the change when the shop was never resolved', async () => {
    // shop_ref IS NULL is real and expected (migrations/001_init.sql:50):
    // keyword search results occasionally omit shop detail. The LEFT JOIN in
    // selectPriceChanges then has no store row to read, so is_own, store_id
    // and username all come back SQL NULL. An unresolved shop must not
    // suppress a real price movement, and must not silently become "ours".
    await addProduct(1, null, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 186850, 0);
    await addSnapshot(1, 211850, 24);

    const { priceChanges } = await collect(12);

    expect(priceChanges).toHaveLength(1);
    expect(priceChanges[0].previousPrice).toBe('186850');
    expect(priceChanges[0].price).toBe('211850');
    // Exact matches, not truthiness: `?? false` must produce the literal
    // `false`, not merely something falsy, and the other two must be `null`
    // rather than `undefined` — either would let `row.is_own` slip through
    // unconverted if the `?? false` were ever dropped.
    expect(priceChanges[0].isOwn).toBe(false);
    expect(priceChanges[0].storeId).toBeNull();
    expect(priceChanges[0].username).toBeNull();
  });
});

describe('new stores', () => {
  test('reports a store above the watermark with its listing count', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addProduct(2, 1, 'LEGO City 60411 Fire Rescue');

    const { newStores } = await collect(12);
    expect(newStores).toHaveLength(1);
    expect(newStores[0]).toMatchObject({ storeId: 1, username: 'rival-a', products: 2 });
  });
});

describe('new products', () => {
  test('reports a new product in a store that was already known', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1 WHERE id = 1`;
    await addProduct(2, 1, 'LEGO City 60411 Fire Rescue');

    const { newProducts, newStores } = await collect(12);
    expect(newStores).toHaveLength(0);
    expect(newProducts).toHaveLength(1);
    expect(newProducts[0]).toMatchObject({ productId: 2, setCode: '60411', username: 'rival-a' });
  });

  test('does not announce a new store’s whole catalogue as new products', async () => {
    await addStore(1, 'rival-a');
    for (let id = 1; id <= 5; id += 1) await addProduct(id, 1, `LEGO set ${10000 + id}`);

    const { newStores, newProducts } = await collect(12);
    expect(newStores).toHaveLength(1);
    expect(newStores[0].products).toBe(5);
    // The store is the news. Its five listings are not five more pieces of news.
    expect(newProducts).toHaveLength(0);
  });
});

describe('latestScrapedAt', () => {
  test('is null on an empty database', async () => {
    expect(await latestScrapedAt(sql)).toBeNull();
  });

  test('reports the newest observation', async () => {
    await addStore(1, 'rival-a');
    await addProduct(1, 1, 'LEGO Technic 42218 John Deere');
    await addSnapshot(1, 100000, 0);
    await addSnapshot(1, 100000, 30);

    const latest = await latestScrapedAt(sql);
    expect(latest?.toISOString()).toBe(new Date(BASE.getTime() + 30 * HOUR).toISOString());
  });
});
