import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { sql } from '@/lib/db';
import { getOwnShops, getPricePositionDetail, getPricePositionSummary, getPricePositions } from '@/lib/queries';
import { pricePositionFilterSchema } from '@/lib/schemas';

/**
 * The price comparison, against a real database.
 *
 * What is actually at stake here is not "does the SQL run" but "does it pair the
 * right listings". A join that matched 42217 to 42218, or a trigram threshold
 * loose enough to pair a baseplate with a spaceship, would produce a screen full
 * of confident, wrong numbers — and someone would reprice against them. So the
 * fixtures below are built as traps: a near-miss set number, our own shop
 * sitting in the rival pool, a name close enough to be tempting and not close
 * enough to be right.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');

/** Base filter: every field at its default, as the page would parse an empty URL. */
const anyFilter = pricePositionFilterSchema.parse({});

beforeAll(async () => {
  // The Python side owns the schema; applying its own migration files is what
  // keeps this test honest about the columns the app will really see.
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
});

/** Insert a shop and return its id. */
async function addStore(
  username: string,
  { own = false, marketplace = 'shopee' }: { own?: boolean; marketplace?: string } = {},
): Promise<number> {
  const [row] = await sql`
    INSERT INTO stores (marketplace, shop_id, username, name, is_own, first_seen, last_seen)
    VALUES (${marketplace}, ${Math.floor(Math.random() * 1e9)}, ${username}, ${username}, ${own},
            now(), now())
    RETURNING id
  `;
  return row.id;
}

/** Insert a listing and its price. `setCode` is what the ingest layer derives. */
async function addProduct(
  storeId: number,
  {
    name,
    setCode,
    price,
    marketplace = 'shopee',
  }: { name: string; setCode: string | null; price: number | null; marketplace?: string },
): Promise<number> {
  const [product] = await sql`
    INSERT INTO products (marketplace, item_id, shop_ref, name, set_code, first_seen, last_seen)
    VALUES (${marketplace}, ${Math.floor(Math.random() * 1e12)}, ${storeId}, ${name}, ${setCode},
            now(), now())
    RETURNING id
  `;
  if (price !== null) {
    await sql`
      INSERT INTO price_snapshots (product_ref, price, scraped_at)
      VALUES (${product.id}, ${price}, now())
    `;
  }
  return product.id;
}

describe('price position', () => {
  test('pairs listings on the set number and prices us against them', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rivalA = await addStore('brickstore');
    const rivalB = await addStore('toko_mainan');

    const productId = await addProduct(mine, {
      name: 'LEGO Technic 42218 John Deere 9RX',
      setCode: '42218',
      price: 1_245_000,
    });
    await addProduct(rivalA, {
      name: 'LEGO 42218 Technic John Deere Tractor',
      setCode: '42218',
      price: 1_089_000,
    });
    await addProduct(rivalB, {
      name: 'Lego Technic 42218 - John Deere 9RX',
      setCode: '42218',
      price: 1_199_000,
    });

    const { rows, total } = await getPricePositions(anyFilter);

    expect(total).toBe(1);
    expect(rows[0].id).toBe(productId);
    expect(rows[0].rivals).toBe(2);
    expect(rows[0].matchKind).toBe('set');
    expect(Number(rows[0].cheapestPrice)).toBe(1_089_000);
    expect(rows[0].cheapestStore).toBe('brickstore');
    // Dearest of three, and 14.3% above the cheapest.
    expect(rows[0].position).toBe(3);
    expect(rows[0].gapPercent).toBeCloseTo(14.3, 1);
  });

  test('a set number one digit apart is a different product', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brickstore');

    await addProduct(mine, {
      name: 'LEGO Technic 42218 John Deere 9RX',
      setCode: '42218',
      price: 1_245_000,
    });
    // Same theme, same words, one digit apart — the case trigram similarity
    // scores 0.86 and gets wrong.
    await addProduct(rival, {
      name: 'LEGO Technic 42217 John Deere',
      setCode: '42217',
      price: 900_000,
    });

    const { rows } = await getPricePositions(anyFilter);
    expect(rows[0].rivals).toBe(0);
    expect(rows[0].cheapestPrice).toBeNull();
    expect(rows[0].matchKind).toBeNull();
  });

  test('our own other listings are never our competition', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const alsoMine = await addStore('i_bricks_official', { own: true });

    await addProduct(mine, { name: 'LEGO 76950 Triceratops', setCode: '76950', price: 1_129_000 });
    await addProduct(alsoMine, {
      name: 'LEGO 76950 Triceratops Pickup',
      setCode: '76950',
      price: 999_000,
    });

    const { rows } = await getPricePositions(anyFilter);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.rivals).toBe(0);
  });

  test('a rival on another marketplace still counts', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brick-tokped', { marketplace: 'tokopedia' });

    await addProduct(mine, { name: 'LEGO 31379 Fierce Dinosaur', setCode: '31379', price: 500_000 });
    await addProduct(rival, {
      name: 'LEGO Creator 31379 Dinosaur',
      setCode: '31379',
      price: 458_550,
      marketplace: 'tokopedia',
    });

    const { rows } = await getPricePositions(anyFilter);
    expect(rows[0].rivals).toBe(1);
    expect(rows[0].cheapestMarketplace).toBe('tokopedia');
  });

  test('listings with no set number fall back to the name, and only close ones match', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brickstore');

    await addProduct(mine, {
      name: 'Bundle Baseplate Hijau 3pcs Alas Lego',
      setCode: null,
      price: 145_000,
    });
    await addProduct(rival, {
      name: 'Bundle Baseplate Hijau 3 pcs Alas Lego',
      setCode: null,
      price: 132_000,
    });
    // Same vocabulary, different product. Below the threshold, so it must not
    // pair — this is the failure the stricter-than-default 0.45 exists for.
    await addProduct(rival, {
      name: 'Mainan Balok Susun Edukasi Anak Laki Laki Murah',
      setCode: null,
      price: 50_000,
    });

    const { rows } = await getPricePositions(anyFilter);
    expect(rows[0].rivals).toBe(1);
    expect(rows[0].matchKind).toBe('name');
    expect(Number(rows[0].cheapestPrice)).toBe(132_000);
  });

  test('filters narrow to the products a decision is being made about', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brickstore');

    // Dearer than the rival.
    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 577_940 });
    await addProduct(rival, { name: 'LEGO 10696 Classic Box', setCode: '10696', price: 449_300 });
    // Cheaper than the rival.
    await addProduct(mine, { name: 'LEGO 60411 Fire Rescue', setCode: '60411', price: 164_550 });
    await addProduct(rival, { name: 'LEGO 60411 Fire Heli', setCode: '60411', price: 199_000 });
    // Nobody to compare against at all.
    await addProduct(mine, { name: 'LEGO 11024 Baseplate', setCode: '11024', price: 100_000 });

    const over = await getPricePositions(pricePositionFilterSchema.parse({ stance: 'over' }));
    expect(over.rows.map((row) => row.setCode)).toEqual(['10696']);

    const under = await getPricePositions(pricePositionFilterSchema.parse({ stance: 'under' }));
    expect(under.rows.map((row) => row.setCode)).toEqual(['60411']);

    const unmatched = await getPricePositions(pricePositionFilterSchema.parse({ matched: 'none' }));
    expect(unmatched.rows.map((row) => row.setCode)).toEqual(['11024']);
  });

  test('hides gaps too large to be a price decision, and shows them on request', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brickzproject');

    // One set number, two packages: our box of sixty against their single
    // minifigure. The pairing is correct and the percentage is meaningless.
    await addProduct(mine, {
      name: 'lego minifigures series 14 box isi 60 pieces',
      setCode: '71049',
      price: 5_250_000,
    });
    await addProduct(rival, {
      name: 'lego minifigures series 14 satuan',
      setCode: '71049',
      price: 25_000,
    });
    // An ordinary, actionable gap.
    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 577_940 });
    await addProduct(rival, { name: 'LEGO 10696 Classic Box', setCode: '10696', price: 449_300 });

    const hidden = await getPricePositions(pricePositionFilterSchema.parse({}));
    expect(hidden.rows.map((row) => row.setCode)).toEqual(['10696']);
    expect(hidden.total).toBe(1);

    const shown = await getPricePositions(pricePositionFilterSchema.parse({ extreme: 'show' }));
    expect(shown.rows.map((row) => row.setCode).sort()).toEqual(['10696', '71049']);
  });

  test('a product with no rival is never hidden as extreme', async () => {
    const mine = await addStore('i_bricks', { own: true });
    await addProduct(mine, { name: 'LEGO 11024 Baseplate', setCode: '11024', price: 100_000 });

    const { rows } = await getPricePositions(pricePositionFilterSchema.parse({}));
    expect(rows.map((row) => row.setCode)).toEqual(['11024']);
  });

  test('the summary counts the catalogue, not the filtered page', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brickstore');

    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 577_940 });
    await addProduct(rival, { name: 'LEGO 10696 Classic Box', setCode: '10696', price: 449_300 });
    await addProduct(mine, { name: 'LEGO 60411 Fire Rescue', setCode: '60411', price: 164_550 });
    await addProduct(rival, { name: 'LEGO 60411 Fire Heli', setCode: '60411', price: 199_000 });
    await addProduct(mine, { name: 'Bundle tanpa nomor', setCode: null, price: 100_000 });

    const summary = await getPricePositionSummary();
    expect(summary.products).toBe(3);
    expect(summary.matched).toBe(2);
    expect(summary.overpriced).toBe(1);
    expect(summary.cheapest).toBe(1);
    expect(summary.withoutSetCode).toBe(1);
  });

  test('the detail view lists rivals cheapest first', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rivalA = await addStore('brickstore');
    const rivalB = await addStore('toko_mainan');

    const productId = await addProduct(mine, {
      name: 'LEGO 77254 Ferrari SF90',
      setCode: '77254',
      price: 547_000,
    });
    await addProduct(rivalA, { name: 'LEGO 77254 Ferrari', setCode: '77254', price: 500_000 });
    await addProduct(rivalB, { name: 'LEGO 77254 SF90 XX', setCode: '77254', price: 407_200 });

    const detail = await getPricePositionDetail(productId);
    expect(detail).not.toBeNull();
    expect(detail!.rivals.map((rival) => rival.storeUsername)).toEqual(['toko_mainan', 'brickstore']);
    expect(detail!.rivals.every((rival) => rival.matchKind === 'set')).toBe(true);
    expect(detail!.product.position).toBe(3);
  });

  test('a product id that is not ours has no detail to show', async () => {
    const rival = await addStore('brickstore');
    const theirs = await addProduct(rival, {
      name: 'LEGO 77254 Ferrari',
      setCode: '77254',
      price: 500_000,
    });

    expect(await getPricePositionDetail(theirs)).toBeNull();
  });

  test('lists the shops marked as ours', async () => {
    const mine = await addStore('i_bricks', { own: true });
    await addStore('brickstore');
    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 1 });

    const shops = await getOwnShops();
    expect(shops.map((shop) => shop.username)).toEqual(['i_bricks']);
    expect(shops[0].products).toBe(1);
  });
});
