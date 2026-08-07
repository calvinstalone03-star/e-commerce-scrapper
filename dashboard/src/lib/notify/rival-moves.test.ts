import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { sql } from '@/lib/db';
import { rivalMoves, rivalMovesCeiling, type RivalMovesOptions } from '@/lib/notify/rival-moves';

/**
 * Rival price moves, against a real database.
 *
 * Two things here are not ordinary fixture bookkeeping and are the reason the
 * helpers look the way they do.
 *
 * **Everything is anchored on `now()`, not on a calendar date.** The query's
 * freshness predicate is `scraped_at > now() - windowDays`, so a fixture pinned
 * to a fixed `BASE` the way `positions.test.ts` pins its own would silently age
 * out of the window and this suite would start failing on its own, on a date
 * nobody chose, with no code change to blame.
 *
 * **The moving listing's newer capture sits 30 hours in the past**, not at
 * `now()`. A later unchanged capture has to land *after* it and still be in the
 * past to be a realistic fixture, and the case that matters puts that capture a
 * day later.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');
const HOUR = 3600 * 1000;

/** Our shop, and the shop we are watching. */
const OWN_STORE = 1;
const RIVAL_STORE = 2;

/** The set both sides carry. Any rival listing outside it is out of scope. */
const SET = '42218';

/** The own listing that puts `SET` in `own_sets`. Priced only when a test says so. */
const OWN_ANCHOR = 1;

/**
 * How far back the newer capture of every seeded move sits.
 *
 * Far enough that a capture a day later is still in the past, which is what
 * `seedUnchangedCapture` needs, and near enough that its `hoursApart`
 * predecessor stays inside the 14-day window for every case below.
 */
const MOVE_HOURS_AGO = 30;

const DEFAULTS: RivalMovesOptions = {
  gapHours: 24,
  threshold: 0.05,
  windowDays: 14,
  maxLookbackDays: 7,
  limit: 50,
  offset: 0,
};

function ago(hours: number): Date {
  return new Date(Date.now() - hours * HOUR);
}

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

/** Ids handed out to seeded listings, after the own anchor has taken 1. */
let nextProductId = OWN_ANCHOR + 1;
/** The listing `seedUnchangedCapture` appends to. */
let lastMoveProductId = 0;

beforeEach(async () => {
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
  nextProductId = OWN_ANCHOR + 1;
  lastMoveProductId = 0;
  await addStore(OWN_STORE, 'i_bricks', true);
  await addStore(RIVAL_STORE, 'rival-a', false);
  // Unpriced by default: `ourPrice` and `undercutsUs` are then null, which is
  // what the scoping cases want. `seedOurPrice` gives it a price.
  await addProduct(OWN_ANCHOR, OWN_STORE, SET);
});

async function addStore(id: number, username: string, isOwn: boolean): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (${id}, 'shopee', ${id * 1000}, ${username}, ${isOwn}, ${ago(24 * 30)}, ${ago(1)})`;
}

async function addProduct(id: number, storeId: number, setCode: string | null): Promise<void> {
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, url, first_seen, last_seen)
    VALUES (${id}, 'shopee', ${id * 100}, ${storeId}, ${'Test product ' + id}, ${setCode},
            ${'https://shopee.co.id/p/' + id}, ${ago(24 * 30)}, ${ago(1)})`;
}

/** `price` stays a string: it is a NUMERIC, and a float would round it. */
async function addSnapshot(productId: number, price: string, at: Date): Promise<void> {
  await sql`
    INSERT INTO price_snapshots (product_ref, price, sold, scraped_at)
    VALUES (${productId}, ${price}, 100, ${at})`;
}

/** Give our own anchor listing a price, so `ourPrice` and `undercutsUs` are not null. */
async function seedOurPrice(price: string): Promise<void> {
  await addSnapshot(OWN_ANCHOR, price, ago(1));
}

type MoveSpec = {
  isOwn?: boolean;
  setCode?: string;
  from: string;
  to: string;
  hoursApart: number;
};

/**
 * One listing, two captures `hoursApart`, the newer one `MOVE_HOURS_AGO` old.
 *
 * Both timestamps come from one `Date.now()` read, not two calls to `ago()`.
 * Two separate reads let the wall clock advance between them, so the true gap
 * between the captures would be `hoursApart` hours plus however many
 * milliseconds elapsed between the two `INSERT`s — invisible to every test that
 * only checks a threshold on one side of a boundary, but it would make a test
 * that wants to sit exactly on `gapHours` or `maxLookbackDays` a liar about what
 * it seeded.
 */
async function seedMove(spec: MoveSpec): Promise<number> {
  const productId = nextProductId++;
  await addProduct(productId, spec.isOwn ? OWN_STORE : RIVAL_STORE, spec.setCode ?? SET);
  const reference = Date.now();
  await addSnapshot(productId, spec.from, new Date(reference - (MOVE_HOURS_AGO + spec.hoursApart) * HOUR));
  await addSnapshot(productId, spec.to, new Date(reference - MOVE_HOURS_AGO * HOUR));
  lastMoveProductId = productId;
  return productId;
}

async function seedRivalMove(spec: Omit<MoveSpec, 'isOwn'>): Promise<number> {
  return seedMove({ ...spec, isOwn: false });
}

/**
 * The capture `scraper/store.py` writes anyway once the dedupe window has
 * passed: same price, later timestamp, on the listing that just moved.
 */
async function seedUnchangedCapture(spec: { price: string; hoursAfter: number }): Promise<void> {
  await addSnapshot(lastMoveProductId, spec.price, ago(MOVE_HOURS_AGO - spec.hoursAfter));
}

/** Three rival moves, largest first, so the top of the page is not the largest id. */
async function seedThreeRivalMoves(): Promise<void> {
  await seedRivalMove({ from: '100000', to: '40000', hoursApart: 48 }); // -60%
  await seedRivalMove({ from: '100000', to: '70000', hoursApart: 48 }); // -30%
  await seedRivalMove({ from: '100000', to: '90000', hoursApart: 48 }); // -10%
}

describe('rivalMoves — which snapshots qualify', () => {
  test('a move exactly at the threshold qualifies', async () => {
    await seedRivalMove({ from: '100000', to: '95000', hoursApart: 48 }); // -5.0%
    const rows = await rivalMoves(DEFAULTS);
    expect(rows).toHaveLength(1);
  });

  test('a move just under the threshold does not', async () => {
    await seedRivalMove({ from: '100000', to: '95001', hoursApart: 48 });
    expect(await rivalMoves(DEFAULTS)).toHaveLength(0);
  });

  test('a comparison younger than gapHours is not used', async () => {
    await seedRivalMove({ from: '100000', to: '50000', hoursApart: 23 });
    expect(await rivalMoves(DEFAULTS)).toHaveLength(0);
  });

  test('a comparison older than maxLookbackDays is not used', async () => {
    await seedRivalMove({ from: '100000', to: '50000', hoursApart: 24 * 8 });
    expect(await rivalMoves({ ...DEFAULTS, maxLookbackDays: 7 })).toHaveLength(0);
  });

  test('a zero previous price does not divide', async () => {
    await seedRivalMove({ from: '0', to: '50000', hoursApart: 48 });
    expect(await rivalMoves(DEFAULTS)).toHaveLength(0);
  });

  test('own listings are out of scope', async () => {
    await seedMove({ isOwn: true, from: '100000', to: '50000', hoursApart: 48 });
    expect(await rivalMoves(DEFAULTS)).toHaveLength(0);
  });

  test('a rival on a set we do not carry is out of scope', async () => {
    await seedMove({ isOwn: false, setCode: '99999', from: '100000', to: '50000', hoursApart: 48 });
    expect(await rivalMoves(DEFAULTS)).toHaveLength(0);
  });
});

describe('rivalMoves — the window parameters are honored, not hardcoded', () => {
  /**
   * Every case in the block above passes `DEFAULTS` outright, or overrides
   * `maxLookbackDays` to a value that is itself the default (7). That leaves
   * all four window parameters — `gapHours`, `threshold`, `windowDays`,
   * `maxLookbackDays` — unverified as *parameters*: an implementation with
   * `24`, `0.05`, `14` and `7` baked into the SQL as literals instead of bound
   * values passes every test above unchanged.
   *
   * These probe each one with a genuinely non-default value against the same
   * fixture — a rival move exactly at the default 5% threshold, its comparison
   * 48 hours before it — and check that the row count moves.
   */

  test('threshold above the move excludes it', async () => {
    await seedRivalMove({ from: '100000', to: '95000', hoursApart: 48 }); // -5.0%
    expect(await rivalMoves({ ...DEFAULTS, threshold: 0.1 })).toHaveLength(0);
  });

  test('threshold well below the move still includes it', async () => {
    await seedRivalMove({ from: '100000', to: '95000', hoursApart: 48 }); // -5.0%
    expect(await rivalMoves({ ...DEFAULTS, threshold: 0.01 })).toHaveLength(1);
  });

  test('gapHours wider than the pair excludes it', async () => {
    await seedRivalMove({ from: '100000', to: '95000', hoursApart: 48 });
    expect(await rivalMoves({ ...DEFAULTS, gapHours: 72 })).toHaveLength(0);
  });

  test('maxLookbackDays shorter than the pair excludes it', async () => {
    await seedRivalMove({ from: '100000', to: '95000', hoursApart: 48 });
    expect(await rivalMoves({ ...DEFAULTS, maxLookbackDays: 1 })).toHaveLength(0);
  });

  test('windowDays shorter than the snapshot age excludes it', async () => {
    await seedRivalMove({ from: '100000', to: '95000', hoursApart: 48 });
    expect(await rivalMoves({ ...DEFAULTS, windowDays: 1 })).toHaveLength(0);
  });
});

describe('rivalMoves — windowDays scopes both the page and the ceiling', () => {
  /**
   * `rivalMovesCeiling` shares `qualifyingMoves` with `rivalMoves` precisely so
   * the two cannot disagree about which rows qualify. If the freshness
   * predicate were dropped from that shared fragment — or from only one of the
   * two exports — a marker could advance past a row that had already aged out
   * of the page, or the ceiling could stay silent about a row the page still
   * shows. Every fixture elsewhere in this file sits at `MOVE_HOURS_AGO` = 30
   * hours old, comfortably inside the default 14-day window, so nothing above
   * exercises this predicate at all.
   */

  test('a move outside windowDays is absent from both the page and the ceiling', async () => {
    await seedRivalMove({ from: '100000', to: '50000', hoursApart: 48 }); // -50%, 30h old
    const narrowed = { ...DEFAULTS, windowDays: 1 }; // the move is 1.25 days old
    expect(await rivalMoves(narrowed)).toEqual([]);
    expect(await rivalMovesCeiling(narrowed)).toBeNull();
  });
});

describe('rivalMoves — one row per qualifying snapshot', () => {
  /**
   * The `DISTINCT ON (product_ref)` regression, and the reason the event set is
   * per snapshot rather than per product.
   *
   * `scraper/store.py` writes an unchanged snapshot anyway once the dedupe
   * window has passed. A day later that capture is the newest one for the
   * listing, and its own 24-hour-older comparison is the moved price — an
   * honest 0%. Take one row per product and the real move, which nobody has
   * read yet, disappears from the list AND from the unread badge with no record
   * that it was ever there. Measured against the hosted database: 57 qualifying
   * snapshots, 49 under `DISTINCT ON`, 8 already buried.
   */

  test('a later unchanged capture does not retract an earlier move', async () => {
    await seedRivalMove({ from: '100000', to: '50000', hoursApart: 48 });
    await seedUnchangedCapture({ price: '50000', hoursAfter: 25 });
    expect(await rivalMoves(DEFAULTS)).toHaveLength(1);
  });

  test('a capture too soon to see past the move reports it again', async () => {
    // The companion to the case above, and not a defect: a capture one hour
    // later still has the PRE-move price as its newest 24-hour-older
    // comparison, so it is a second honest report of the same move. That is why
    // the design folds repeats per set in the UI (`group.ts`) rather than in
    // SQL — collapsing them here is exactly what buries the row above.
    await seedRivalMove({ from: '100000', to: '50000', hoursApart: 48 });
    await seedUnchangedCapture({ price: '50000', hoursAfter: 1 });
    const rows = await rivalMoves(DEFAULTS);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.previousPrice)).toEqual(['100000', '100000']);
  });
});

describe('rivalMoves — what a row says', () => {
  test('reports our price and that a dearer move does not undercut us', async () => {
    await seedOurPrice('100000');
    const productId = await seedRivalMove({ from: '200000', to: '150000', hoursApart: 48 });

    const rows = await rivalMoves(DEFAULTS);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      snapshotId: expect.any(String),
      productId,
      name: 'Test product ' + productId,
      setCode: SET,
      marketplace: 'shopee',
      storeId: RIVAL_STORE,
      username: 'rival-a',
      price: '150000',
      previousPrice: '200000',
      scrapedAt: expect.any(Date),
      previousScrapedAt: expect.any(Date),
      ourPrice: '100000',
      undercutsUs: false,
    });
    // NUMERIC and bigint stay strings all the way out.
    expect(typeof rows[0].price).toBe('string');
    expect(typeof rows[0].snapshotId).toBe('string');
  });

  test('undercutsUs is null when we have no price for the set', async () => {
    await seedRivalMove({ from: '200000', to: '150000', hoursApart: 48 });
    const rows = await rivalMoves(DEFAULTS);
    expect(rows[0].ourPrice).toBeNull();
    expect(rows[0].undercutsUs).toBeNull();
  });

  test('a move that undercuts us sorts above a bigger one that does not', async () => {
    await seedOurPrice('100000');
    // Seeded first, so it also holds the LOWER id: neither magnitude nor id may
    // outrank the fact that the other one went under our price.
    await seedRivalMove({ from: '1000000', to: '500000', hoursApart: 48 }); // -50%, dearer
    const undercutting = await seedRivalMove({ from: '100000', to: '90000', hoursApart: 48 });

    const rows = await rivalMoves(DEFAULTS);

    expect(rows).toHaveLength(2);
    expect(rows[0].productId).toBe(undercutting);
    expect(rows[0].undercutsUs).toBe(true);
    expect(rows[1].undercutsUs).toBe(false);
  });
});

describe('rivalMoves — our price is the cheapest of our shops', () => {
  /**
   * Every other case in this file that sets `ourPrice` (`seedOurPrice`) only
   * ever creates one own listing, so `min(latest.price)` and a wrong
   * `max(latest.price)` are indistinguishable everywhere above. This seeds the
   * SAME set in a second own shop at a dearer price and checks both that the
   * cheaper of the two is reported, and — the same fixture answers both
   * questions — that carrying a set in two own shops does not double the row
   * count for a rival's single move on it.
   */

  test('ourPrice is the cheaper of two own shops, and the rival still yields one row', async () => {
    await seedOurPrice('120000'); // OWN_ANCHOR, on OWN_STORE
    const OWN_STORE_2 = 3;
    await addStore(OWN_STORE_2, 'i-bricks-toko', true);
    const secondOwnProduct = nextProductId++;
    await addProduct(secondOwnProduct, OWN_STORE_2, SET);
    await addSnapshot(secondOwnProduct, '80000', ago(1)); // cheaper than the anchor's 120000

    const rivalId = await seedRivalMove({ from: '200000', to: '150000', hoursApart: 48 });

    const rows = await rivalMoves(DEFAULTS);

    expect(rows).toHaveLength(1);
    expect(rows[0].productId).toBe(rivalId);
    expect(rows[0].ourPrice).toBe('80000');
  });
});

describe('rivalMovesCeiling', () => {
  test('ceiling spans the whole window, not the page', async () => {
    await seedThreeRivalMoves();
    const page = await rivalMoves({ ...DEFAULTS, limit: 1 });
    const ceiling = await rivalMovesCeiling(DEFAULTS);
    expect(page).toHaveLength(1);
    // snapshotId is a bigint as a string — compared as BigInt, never Number(),
    // the exact conversion the type's own doc comment forbids.
    expect(ceiling).not.toBeNull();
    expect(BigInt(ceiling as string)).toBeGreaterThan(BigInt(page[0].snapshotId));
  });

  test('the ceiling is the largest qualifying id in the window', async () => {
    await seedThreeRivalMoves();
    const all = await rivalMoves(DEFAULTS);
    const largest = all
      .map((row) => BigInt(row.snapshotId))
      .reduce((a, b) => (a > b ? a : b), BigInt(0));

    expect(all).toHaveLength(3);
    const ceiling = await rivalMovesCeiling(DEFAULTS);
    expect(ceiling).not.toBeNull();
    expect(BigInt(ceiling as string)).toBe(largest);
  });

  test('offset walks the same ordering the ceiling was taken over', async () => {
    // Not incidental: the marker is only safe because every row it jumps past
    // is reachable by paging. A page that skipped or repeated a row would
    // strand it under a ceiling that had already counted it.
    await seedThreeRivalMoves();
    const all = await rivalMoves(DEFAULTS);

    const paged: string[] = [];
    for (let offset = 0; offset < all.length; offset++) {
      const [row] = await rivalMoves({ ...DEFAULTS, limit: 1, offset });
      paged.push(row.snapshotId);
    }

    expect(paged).toEqual(all.map((row) => row.snapshotId));
    expect(new Set(paged).size).toBe(3);
  });

  test('no qualifying move at all is a null ceiling, not a zero', async () => {
    await seedRivalMove({ from: '100000', to: '99999', hoursApart: 48 });
    expect(await rivalMovesCeiling(DEFAULTS)).toBeNull();
  });
});
