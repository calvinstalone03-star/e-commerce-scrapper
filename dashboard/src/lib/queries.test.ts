import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * `unstable_cache` needs a real Next.js server behind it — specifically the
 * incremental cache the server process hangs off `globalThis` — and throws
 * outright when that is missing, rather than quietly skipping the cache.
 * Vitest never starts that server, so the throw happens no matter where the
 * cache boundary sits in `queries.ts`. Next's own client-bundle build hits the
 * same gap and closes it the same way: caching becomes a no-op and the
 * wrapped function is called directly. This is that fallback, applied to this
 * process instead — the tests below prove the pairing is correct, not that
 * caching works, so a no-op cache is exactly what they need.
 *
 * A silent passthrough would erase the one thing worth checking about this
 * stub, though: whether `getPairingSnapshot` really is the wrapped function
 * and `computePairingSnapshot` really is not — the inversion that would let
 * the cache boundary end up around the wrong export. So the stub marks
 * whatever it wraps and records the key parts and options it was called
 * with; `describe('cache boundary', ...)` below asserts on both, which is
 * also how it pins the exact revalidate window and tag against a silent
 * change to either.
 */
const cacheStub = vi.hoisted(() => {
  const calls: Array<{ keyParts: unknown; options: unknown }> = [];
  const WRAPPED = Symbol('wrapped by the unstable_cache stub');
  return { calls, WRAPPED };
});

vi.mock('next/cache', () => ({
  unstable_cache: <Fn extends (...args: readonly unknown[]) => unknown>(
    fn: Fn,
    keyParts: unknown,
    options: unknown,
  ): Fn => {
    cacheStub.calls.push({ keyParts, options });
    const wrapped = ((...args: Parameters<Fn>) => fn(...args)) as Fn;
    Reflect.set(wrapped, cacheStub.WRAPPED, true);
    return wrapped;
  },
}));

import { sql } from '@/lib/db';
import {
  channelOfOwnProduct,
  computePairingSnapshot,
  getOwnShopScorecard,
  getOwnShops,
  getPairingSnapshot,
  getPricePositionDetail,
  getPricePositions,
  getPricingAnalytics,
  withNameMatching,
} from '@/lib/queries';
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

    const { rows, total } = await getPricePositions('shopee', anyFilter);

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

    const { rows } = await getPricePositions('shopee', anyFilter);
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

    const { rows } = await getPricePositions('shopee', anyFilter);
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

    const { rows } = await getPricePositions('shopee', anyFilter);
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

    const { rows } = await getPricePositions('shopee', anyFilter);
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

    const over = await getPricePositions('shopee', pricePositionFilterSchema.parse({ stance: 'over' }));
    expect(over.rows.map((row) => row.setCode)).toEqual(['10696']);

    const under = await getPricePositions('shopee', pricePositionFilterSchema.parse({ stance: 'under' }));
    expect(under.rows.map((row) => row.setCode)).toEqual(['60411']);

    const unmatched = await getPricePositions('shopee', pricePositionFilterSchema.parse({ matched: 'none' }));
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

    const hidden = await getPricePositions('shopee', pricePositionFilterSchema.parse({}));
    expect(hidden.rows.map((row) => row.setCode)).toEqual(['10696']);
    expect(hidden.total).toBe(1);

    const shown = await getPricePositions('shopee', pricePositionFilterSchema.parse({ extreme: 'show' }));
    expect(shown.rows.map((row) => row.setCode).sort()).toEqual(['10696', '71049']);
  });

  test('a product with no rival is never hidden as extreme', async () => {
    const mine = await addStore('i_bricks', { own: true });
    await addProduct(mine, { name: 'LEGO 11024 Baseplate', setCode: '11024', price: 100_000 });

    const { rows } = await getPricePositions('shopee', pricePositionFilterSchema.parse({}));
    expect(rows.map((row) => row.setCode)).toEqual(['11024']);
  });

  test('searches by name and by set number, whole or partial', async () => {
    const mine = await addStore('i_bricks', { own: true });
    await addProduct(mine, {
      name: 'LEGO Technic 42218 John Deere 9RX',
      setCode: '42218',
      price: 1_245_000,
    });
    await addProduct(mine, { name: 'LEGO City 60411 Fire Rescue', setCode: '60411', price: 164_550 });

    const byName = await getPricePositions('shopee', pricePositionFilterSchema.parse({ q: 'john deere' }));
    expect(byName.rows.map((row) => row.setCode)).toEqual(['42218']);

    const byCode = await getPricePositions('shopee', pricePositionFilterSchema.parse({ q: '42218' }));
    expect(byCode.rows.map((row) => row.setCode)).toEqual(['42218']);

    // Half-remembered numbers are the common case: the box is across the room.
    const byPrefix = await getPricePositions('shopee', pricePositionFilterSchema.parse({ q: '604' }));
    expect(byPrefix.rows.map((row) => row.setCode)).toEqual(['60411']);

    const nothing = await getPricePositions('shopee', pricePositionFilterSchema.parse({ q: 'zzzz' }));
    expect(nothing.rows).toHaveLength(0);
    expect(nothing.total).toBe(0);
    // The headline still describes the catalogue, not the search.
    expect(nothing.summary.products).toBe(2);
  });

  test('pages without dropping or repeating a row', async () => {
    const mine = await addStore('i_bricks', { own: true });
    for (let index = 0; index < 7; index += 1) {
      await addProduct(mine, {
        name: `LEGO Set nomor ${index}`,
        setCode: `1000${index}`,
        price: 100_000 + index,
      });
    }

    const first = await getPricePositions('shopee', pricePositionFilterSchema.parse({ pageSize: 3, page: 1 }));
    const second = await getPricePositions('shopee', pricePositionFilterSchema.parse({ pageSize: 3, page: 2 }));
    const third = await getPricePositions('shopee', pricePositionFilterSchema.parse({ pageSize: 3, page: 3 }));

    expect(first.total).toBe(7);
    const seen = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  test('the summary counts the catalogue, not the filtered page', async () => {
    const mine = await addStore('i_bricks', { own: true });
    const rival = await addStore('brickstore');

    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 577_940 });
    await addProduct(rival, { name: 'LEGO 10696 Classic Box', setCode: '10696', price: 449_300 });
    await addProduct(mine, { name: 'LEGO 60411 Fire Rescue', setCode: '60411', price: 164_550 });
    await addProduct(rival, { name: 'LEGO 60411 Fire Heli', setCode: '60411', price: 199_000 });
    await addProduct(mine, { name: 'Bundle tanpa nomor', setCode: null, price: 100_000 });

    const { summary } = await getPricePositions('shopee', pricePositionFilterSchema.parse({}));
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

  test('a channel sees only its own listings, never the other shop\'s', async () => {
    const shopeeMine = await addStore('i_bricks', { own: true, marketplace: 'shopee' });
    const tokopediaMine = await addStore('i-bricks', { own: true, marketplace: 'tokopedia' });
    const rival = await addStore('brickstore');
    await addProduct(shopeeMine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 500_000 });
    await addProduct(tokopediaMine, {
      name: 'LEGO 10696 Brick Box',
      setCode: '10696',
      price: 520_000,
      marketplace: 'tokopedia',
    });
    await addProduct(rival, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 400_000 });

    const shopee = await getPricePositions('shopee', anyFilter);
    const tokopedia = await getPricePositions('tokopedia', anyFilter);

    expect(shopee.rows).toHaveLength(1);
    expect(Number(shopee.rows[0].price)).toBe(500_000);
    expect(tokopedia.rows).toHaveLength(1);
    expect(Number(tokopedia.rows[0].price)).toBe(520_000);
    // The set exists in both our shops; neither screen may report two.
    expect(shopee.summary.products).toBe(1);
    expect(tokopedia.summary.products).toBe(1);
  });

  test('our listing in the other channel is never counted as a rival', async () => {
    const shopeeMine = await addStore('i_bricks', { own: true, marketplace: 'shopee' });
    const tokopediaMine = await addStore('i-bricks', { own: true, marketplace: 'tokopedia' });
    await addProduct(shopeeMine, { name: 'LEGO 21034 London', setCode: '21034', price: 700_000 });
    await addProduct(tokopediaMine, {
      name: 'LEGO 21034 London',
      setCode: '21034',
      price: 600_000,
      marketplace: 'tokopedia',
    });

    const { rows } = await getPricePositions('shopee', anyFilter);

    // Only the Shopee listing is ours in this channel. Asserting the count,
    // not just rows[0]'s shape, is what makes this fail if `ourListings` ever
    // reverted to unscoped `is_own`: the Tokopedia row would leak into `mine`
    // as a second row, and — because `pairs` already excludes any `is_own`
    // store from rivals regardless of channel — it too would show `rivals: 0`
    // and pass the checks below without a length assertion to catch it.
    expect(rows).toHaveLength(1);
    // Cheaper, same set, but it is us. Our own shelf is not competition.
    expect(rows[0].rivals).toBe(0);
    expect(rows[0].cheapestPrice).toBeNull();
  });

  test('a product knows which of our shops it belongs to', async () => {
    const tokopediaMine = await addStore('i-bricks', { own: true, marketplace: 'tokopedia' });
    const rival = await addStore('brickstore');
    const mine = await addProduct(tokopediaMine, {
      name: 'LEGO 21034 London',
      setCode: '21034',
      price: 700_000,
      marketplace: 'tokopedia',
    });
    const theirs = await addProduct(rival, {
      name: 'LEGO 21034 London',
      setCode: '21034',
      price: 650_000,
    });

    expect(await channelOfOwnProduct(mine)).toBe('tokopedia');
    // A rival's product is nobody's channel, and the detail page has to say so
    // rather than render someone else's shelf as ours.
    expect(await channelOfOwnProduct(theirs)).toBeNull();
  });

  test('a cheaper rival on the other marketplace still counts against us', async () => {
    const mine = await addStore('i_bricks', { own: true, marketplace: 'shopee' });
    const rival = await addStore('toko-brick-jkt', { marketplace: 'tokopedia' });
    await addProduct(mine, { name: 'LEGO 42218 John Deere', setCode: '42218', price: 1_245_000 });
    await addProduct(rival, {
      name: 'LEGO 42218 John Deere',
      setCode: '42218',
      price: 1_089_000,
      marketplace: 'tokopedia',
    });

    const { rows } = await getPricePositions('shopee', anyFilter);

    expect(rows[0].rivals).toBe(1);
    expect(Number(rows[0].cheapestPrice)).toBe(1_089_000);
    expect(rows[0].cheapestMarketplace).toBe('tokopedia');
  });
});

/**
 * Where the trigram threshold comes from.
 *
 * It used to be a startup parameter on the connection, which a pooled Neon
 * endpoint rejects outright — the connection never opens. Setting it per
 * transaction is what survives a pooler, and the two things worth pinning are
 * that it is actually in force where the matching happens, and that it does not
 * outlive the transaction: a pooled connection is handed to somebody else next,
 * and a leaked 0.45 would silently retighten their query.
 */
describe('name matching', () => {
  test('runs at this app’s threshold rather than pg_trgm’s default', async () => {
    const [row] = await withNameMatching((tx) => tx`SHOW pg_trgm.similarity_threshold`);
    expect(row['pg_trgm.similarity_threshold']).toBe('0.45');
  });

  test('leaves the connection it borrowed exactly as it found it', async () => {
    // The GUC is only recognised once pg_trgm's library is loaded in the
    // session, which any trigram call does.
    await sql`SELECT similarity('a', 'b')`;
    const [before] = await sql`SHOW pg_trgm.similarity_threshold`;

    await withNameMatching((tx) => tx`SELECT 1`);

    const [after] = await sql`SHOW pg_trgm.similarity_threshold`;
    expect(after).toEqual(before);
  });

  test('composes the shared query fragments, which belong to the outer handle', async () => {
    // `rivalMatch`, `ourListings` and `latestSnapshots` are built from `sql`, and
    // every wrapped query embeds them while running on a transaction handle.
    const mine = await addStore('i_bricks', { own: true });
    const theirs = await addStore('brickstore');
    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 500_000 });
    await addProduct(theirs, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 400_000 });

    const { rows } = await getPricePositions('shopee', anyFilter);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].cheapestPrice)).toBe(400_000);
  });
});

describe('pairing snapshot', () => {
  /**
   * The overview scorecard and the analytics position mix are the same numbers
   * shown twice. They are computed once for that reason, and these tests are
   * what keep them from drifting apart again.
   */
  async function bothShopsWithOneRival() {
    const shopeeMine = await addStore('i_bricks', { own: true, marketplace: 'shopee' });
    const tokopediaMine = await addStore('i-bricks', { own: true, marketplace: 'tokopedia' });
    const rival = await addStore('brickstore');
    // One set in both our shops: cheapest on Shopee, dearest on Tokopedia.
    await addProduct(shopeeMine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 380_000 });
    await addProduct(tokopediaMine, {
      name: 'LEGO 10696 Brick Box',
      setCode: '10696',
      price: 460_000,
      marketplace: 'tokopedia',
    });
    await addProduct(rival, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: 400_000 });
    // A second Shopee listing nobody sells against.
    await addProduct(shopeeMine, { name: 'Bundle Baseplate 3pcs', setCode: null, price: 145_000 });
  }

  test('counts each channel on its own, so a shared set is never counted twice', async () => {
    await bothShopsWithOneRival();

    const shopee = await computePairingSnapshot('shopee');
    const tokopedia = await computePairingSnapshot('tokopedia');

    expect(shopee.listings).toBe(2);
    expect(shopee.withRivals).toBe(1);
    expect(shopee.position).toEqual({ cheapest: 1, middle: 0, dearest: 0, unmatched: 1 });

    expect(tokopedia.listings).toBe(1);
    expect(tokopedia.withRivals).toBe(1);
    expect(tokopedia.position).toEqual({ cheapest: 0, middle: 0, dearest: 1, unmatched: 0 });
  });

  test('money on the table is what this channel is leaving, not both', async () => {
    await bothShopsWithOneRival();

    // Shopee undercuts the rival, so nothing is on the table there.
    expect(Number((await computePairingSnapshot('shopee')).atStake)).toBe(0);
    // Tokopedia is Rp 60.000 above the cheapest rival.
    expect(Number((await computePairingSnapshot('tokopedia')).atStake)).toBe(60_000);
  });

  test('the scorecard and the analytics page cannot disagree', async () => {
    await bothShopsWithOneRival();
    const shop = (await getOwnShops()).find((row) => row.marketplace === 'shopee')!;

    const scorecard = await getOwnShopScorecard('shopee', shop);
    const analytics = await getPricingAnalytics('shopee');

    expect(scorecard.position).toEqual(analytics.position);
    expect(scorecard.channel).toBe('shopee');
    expect(scorecard.shopUsername).toBe('i_bricks');
  });

  test('a shop with no priced listing reports zeros rather than throwing', async () => {
    const mine = await addStore('i_bricks', { own: true, marketplace: 'shopee' });
    await addProduct(mine, { name: 'LEGO 10696 Brick Box', setCode: '10696', price: null });

    const snapshot = await computePairingSnapshot('shopee');

    expect(snapshot.listings).toBe(0);
    expect(snapshot.position).toEqual({ cheapest: 0, middle: 0, dearest: 0, unmatched: 0 });
    expect(Number(snapshot.atStake ?? 0)).toBe(0);
    expect(snapshot.rivals).toEqual([]);
  });
});

/**
 * The `unstable_cache` stub above is a no-op, on purpose — but a no-op cache
 * cannot tell "wrapped from outside, correctly" apart from "wrapped from
 * inside, by mistake" unless something marks what passed through it. These
 * two tests are that something: the brief's one hard requirement is that
 * `computePairingSnapshot` stays plain and directly callable — what every
 * test above calls — while `getPairingSnapshot` is the wrapped entry point
 * every page calls instead. Collapse that distinction (wrap
 * `computePairingSnapshot` itself, or make `getPairingSnapshot` an alias for
 * it) and every test above would keep passing, silently, for the wrong
 * reason — these are what would actually catch it.
 */
describe('cache boundary', () => {
  test('getPairingSnapshot is the wrapped export; computePairingSnapshot is not', () => {
    expect(Reflect.get(getPairingSnapshot, cacheStub.WRAPPED)).toBe(true);
    expect(Reflect.get(computePairingSnapshot, cacheStub.WRAPPED)).toBeUndefined();
  });

  test('the cache is keyed, windowed and tagged the way both screens depend on', () => {
    expect(cacheStub.calls).toHaveLength(1);
    expect(cacheStub.calls[0].keyParts).toEqual(['pairing']);
    expect(cacheStub.calls[0].options).toEqual({ revalidate: 300, tags: ['pairing'] });
  });
});
