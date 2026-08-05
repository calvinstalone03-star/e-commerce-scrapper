import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { sql } from '@/lib/db';
import { ownSetPositions } from '@/lib/notify/positions';
import { EXTREME_GAP } from '@/lib/queries';

/**
 * Where we stand on a set, against a real database.
 *
 * The load-bearing case is `8827`, modelled directly on the spec's example: a
 * `set_code` shared by a sealed box of sixty and a single loose minifigure.
 * `extreme` is what stops that pairing from producing a confidently wrong
 * position line.
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
});

async function addStore(id: number, username: string, isOwn = false): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (${id}, 'shopee', ${id * 1000}, ${username}, ${isOwn}, ${BASE}, ${BASE})`;
}

async function addProduct(id: number, storeId: number | null, setCode: string | null): Promise<void> {
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, url, first_seen, last_seen)
    VALUES (${id}, 'shopee', ${id * 100}, ${storeId}, ${'Test product ' + id}, ${setCode},
            ${'https://shopee.co.id/p/' + id}, ${BASE}, ${BASE})`;
}

async function addSnapshot(productId: number, price: number, hoursAfterBase = 0): Promise<void> {
  await sql`
    INSERT INTO price_snapshots (product_ref, price, sold, scraped_at)
    VALUES (${productId}, ${price}, 100, ${new Date(BASE.getTime() + hoursAfterBase * HOUR)})`;
}

describe('ownSetPositions', () => {
  test('picks the cheapest of two own shops, and only the latest price of each', async () => {
    await addStore(1, 'i_bricks_shopee', true);
    await addStore(2, 'i_bricks_toko', true);
    await addStore(3, 'rival-a', false);
    await addStore(4, 'rival-b', false);

    await addProduct(1, 1, '42218');
    await addSnapshot(1, 200000, 0); // superseded — must not win
    await addSnapshot(1, 180000, 5);

    await addProduct(2, 2, '42218');
    await addSnapshot(2, 190000, 0);

    await addProduct(3, 3, '42218');
    await addSnapshot(3, 150000, 0);

    await addProduct(4, 4, '42218');
    await addSnapshot(4, 160000, 0);

    const positions = await ownSetPositions(sql);

    expect(positions.get('42218')).toEqual({
      setCode: '42218',
      ourPrice: '180000',
      ourShop: 'i_bricks_shopee',
      cheapestRival: '150000',
      rivalCount: 2,
      extreme: false,
    });
  });

  test('a set with one own shop', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-c', false);
    await addProduct(1, 1, '60411');
    await addSnapshot(1, 100000);
    await addProduct(2, 2, '60411');
    await addSnapshot(2, 120000);

    const positions = await ownSetPositions(sql);

    expect(positions.get('60411')).toEqual({
      setCode: '60411',
      ourPrice: '100000',
      ourShop: 'i_bricks',
      cheapestRival: '120000',
      rivalCount: 1,
      extreme: false,
    });
  });

  test('a set our shops carry with no rivals', async () => {
    await addStore(1, 'i_bricks', true);
    await addProduct(1, 1, '71811');
    await addSnapshot(1, 250000);

    const positions = await ownSetPositions(sql);

    expect(positions.get('71811')).toEqual({
      setCode: '71811',
      ourPrice: '250000',
      ourShop: 'i_bricks',
      cheapestRival: null,
      rivalCount: 0,
      extreme: false,
    });
  });

  test('a set where we have no priced listing', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-d', false);
    await addProduct(1, 1, '75192'); // never scraped a price
    await addProduct(2, 2, '75192');
    await addSnapshot(2, 50000);

    const positions = await ownSetPositions(sql);

    expect(positions.get('75192')).toEqual({
      setCode: '75192',
      ourPrice: null,
      ourShop: null,
      cheapestRival: '50000',
      rivalCount: 1,
      extreme: false,
    });
  });

  test('flags the extreme gap modelled on set 8827', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'cupliss', false);
    await addProduct(1, 1, '8827'); // sealed box of sixty
    await addSnapshot(1, 8_500_000);
    await addProduct(2, 2, '8827'); // one loose minifigure
    await addSnapshot(2, 397_000);

    const positions = await ownSetPositions(sql);

    expect(positions.get('8827')).toEqual({
      setCode: '8827',
      ourPrice: '8500000',
      ourShop: 'i_bricks',
      cheapestRival: '397000',
      rivalCount: 1,
      extreme: true,
    });
  });

  test('does not flag a gap just under the threshold', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-e', false);
    const rivalPrice = 100_000;
    // Derived from EXTREME_GAP, not a literal 1.0, so this stays "just under"
    // if the dashboard's threshold ever moves.
    const ourPrice = Math.round(rivalPrice * (1 + EXTREME_GAP)) - 1000;
    await addProduct(1, 1, '10312');
    await addSnapshot(1, ourPrice);
    await addProduct(2, 2, '10312');
    await addSnapshot(2, rivalPrice);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10312')).toMatchObject({ extreme: false });
  });

  test('flags a gap exactly at the threshold, not only past it', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-f', false);
    const rivalPrice = 100_000;
    const ourPrice = Math.round(rivalPrice * (1 + EXTREME_GAP));
    await addProduct(1, 1, '10311');
    await addSnapshot(1, ourPrice);
    await addProduct(2, 2, '10311');
    await addSnapshot(2, rivalPrice);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10311')).toMatchObject({ extreme: true });
  });

  test('never includes a set no own shop carries', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-g', false);
    await addProduct(1, 1, '42218');
    await addSnapshot(1, 100000);
    // A rival-only set: no own shop lists it, so it must not appear.
    await addProduct(2, 2, '99999');
    await addSnapshot(2, 50000);

    const positions = await ownSetPositions(sql);

    expect(positions.has('42218')).toBe(true);
    expect(positions.has('99999')).toBe(false);
    expect(positions.size).toBe(1);
  });
});

describe('ownSetPositions — extreme gap is symmetric', () => {
  /**
   * `abs(ours - rival) / rival` only ever fires when WE are the dearer side:
   * when the rival is dearer, that ratio is `1 - ours/rival`, bounded below 1
   * for any positive pair of prices, so no multiple — however large — trips
   * a threshold of 1.0 in that direction. `abs(ours - rival) / least(ours,
   * rival)` fixes that without moving the case the old formula already got
   * right: when we are the dearer side, the rival's price already is the
   * smaller one, so `least()` picks the same denominator as before.
   */

  test('flags a gap where the rival is the dearer side by a huge multiple (set 75059)', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-h', false);
    await addProduct(1, 1, '75059');
    await addSnapshot(1, 350_000);
    await addProduct(2, 2, '75059');
    await addSnapshot(2, 12_500_000);

    const positions = await ownSetPositions(sql);

    expect(positions.get('75059')).toMatchObject({
      ourPrice: '350000',
      cheapestRival: '12500000',
      extreme: true,
    });
  });

  test('flags a gap just over the threshold when we are the dearer side', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-i', false);
    const rivalPrice = 100_000;
    const ourPrice = Math.round(rivalPrice * (1 + EXTREME_GAP)) + 1000;
    await addProduct(1, 1, '10321');
    await addSnapshot(1, ourPrice);
    await addProduct(2, 2, '10321');
    await addSnapshot(2, rivalPrice);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10321')).toMatchObject({ extreme: true });
  });

  test('flags a gap just over the threshold when the rival is the dearer side', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-j', false);
    const ourPrice = 100_000;
    const rivalPrice = Math.round(ourPrice * (1 + EXTREME_GAP)) + 1000;
    await addProduct(1, 1, '10322');
    await addSnapshot(1, ourPrice);
    await addProduct(2, 2, '10322');
    await addSnapshot(2, rivalPrice);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10322')).toMatchObject({ extreme: true });
  });

  test('does not flag a gap just under the threshold when the rival is the dearer side', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-k', false);
    const ourPrice = 100_000;
    const rivalPrice = Math.round(ourPrice * (1 + EXTREME_GAP)) - 1000;
    await addProduct(1, 1, '10323');
    await addSnapshot(1, ourPrice);
    await addProduct(2, 2, '10323');
    await addSnapshot(2, rivalPrice);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10323')).toMatchObject({ extreme: false });
  });
});

describe('ownSetPositions — a zero price is not an extreme gap', () => {
  /**
   * `price` is a plain `numeric` with no CHECK (migrations/001_init.sql:78), so
   * a scrape that reads 0 stores 0. Dividing by `least()` then divides by zero,
   * and in JS that is `Infinity`, which clears any threshold — a free listing
   * would be reported as an extreme gap rather than as the bad datum it is.
   *
   * The three sibling copies of this rule in `queries.ts` all guard the zero
   * explicitly and answer `false`. This one must agree with them: the point of
   * deciding "is this extreme" in one place is lost if the four places that
   * still express the rule disagree about its edges.
   */

  test('does not flag a set where our price is zero', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-l', false);
    await addProduct(1, 1, '10324');
    await addSnapshot(1, 0);
    await addProduct(2, 2, '10324');
    await addSnapshot(2, 250_000);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10324')).toMatchObject({
      ourPrice: '0',
      cheapestRival: '250000',
      extreme: false,
    });
  });

  test('does not flag a set where the cheapest rival is zero', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-m', false);
    await addProduct(1, 1, '10325');
    await addSnapshot(1, 250_000);
    await addProduct(2, 2, '10325');
    await addSnapshot(2, 0);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10325')).toMatchObject({
      ourPrice: '250000',
      cheapestRival: '0',
      extreme: false,
    });
  });

  test('does not flag a set where both sides are zero', async () => {
    await addStore(1, 'i_bricks', true);
    await addStore(2, 'rival-n', false);
    await addProduct(1, 1, '10326');
    await addSnapshot(1, 0);
    await addProduct(2, 2, '10326');
    await addSnapshot(2, 0);

    const positions = await ownSetPositions(sql);

    expect(positions.get('10326')).toMatchObject({ extreme: false });
  });
});
