import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';
import { DEFAULT_WINDOW, rivalMovesCeiling } from '@/lib/notify/rival-moves';

/**
 * The route that moves the read marker, against a real database.
 *
 * What is actually under test here is not the two lines of the handler — it is
 * the one thing the handler is allowed to decide, which is *what id the marker
 * advances to*. An earlier design let the client send it: the page posted the
 * largest id it had rendered. Measured against the hosted database, with 56
 * qualifying events and a top-20 cap, all 36 remaining ids sat **below** the
 * largest one shown — the feed is ordered by consequence, never by id, so "what
 * was shown" is not a prefix of id order and the marker jumped 36 rows it had
 * never rendered. The marker only moves forward and there is no per-item state,
 * so those rows were unrecoverable without hand-written SQL.
 *
 * That is why the body carries no id and why these cases go out of their way to
 * post one anyway.
 */

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));

const auth = await import('@/lib/auth');
const route = await import('@/app/api/notifications/seen/route');

const MIGRATIONS = join(process.cwd(), '..', 'migrations');
const HOUR = 3600 * 1000;

const OWN_STORE = 1;
const RIVAL_STORE = 2;
const SET = '42218';
const OWN_ANCHOR = 1;

/**
 * How far back the newer capture of every seeded move sits — the same 30 hours
 * `rival-moves.test.ts` uses, and for the same reason: near enough that its
 * 48-hour-older predecessor stays inside the 14-day window, far enough that a
 * later capture is still in the past.
 */
const MOVE_HOURS_AGO = 30;

function ago(hours: number): Date {
  return new Date(Date.now() - hours * HOUR);
}

function post(body?: unknown): Promise<Response> {
  return route.POST(
    new NextRequest('http://localhost:3000/api/notifications/seen', {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
  );
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

let nextProductId = OWN_ANCHOR + 1;

beforeEach(async () => {
  jar.clear();
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM app_credentials`;
  nextProductId = OWN_ANCHOR + 1;

  await addStore(OWN_STORE, 'i_bricks', true);
  await addStore(RIVAL_STORE, 'rival-a', false);
  await addProduct(OWN_ANCHOR, OWN_STORE, SET);

  // Upserted rather than updated: `seen.test.ts` deletes this row in two of its
  // cases, and vitest runs these files against one shared database.
  await sql`
    INSERT INTO notify_seen (id, last_seen_snapshot_id, updated_at) VALUES (1, 0, now())
    ON CONFLICT (id) DO UPDATE SET last_seen_snapshot_id = 0, updated_at = now()`;

  await auth.createSession();
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

async function addSnapshot(productId: number, price: string, at: Date): Promise<void> {
  await sql`
    INSERT INTO price_snapshots (product_ref, price, sold, scraped_at)
    VALUES (${productId}, ${price}, 100, ${at})`;
}

/** One rival listing, two captures 48 hours apart, the newer `MOVE_HOURS_AGO` old. */
async function seedRivalMove(from: string, to: string): Promise<void> {
  const productId = nextProductId++;
  await addProduct(productId, RIVAL_STORE, SET);
  const reference = Date.now();
  await addSnapshot(productId, from, new Date(reference - (MOVE_HOURS_AGO + 48) * HOUR));
  await addSnapshot(productId, to, new Date(reference - MOVE_HOURS_AGO * HOUR));
}

/**
 * A snapshot that qualifies for nothing but takes the next id.
 *
 * Ours, so `rivalMoves` excludes it outright — which is the point: it lifts
 * `max(price_snapshots.id)` above every qualifying id, so a route that advanced
 * the marker to the table's maximum instead of the window's ceiling would be
 * visibly wrong rather than accidentally right.
 */
async function seedHigherNonQualifyingSnapshot(): Promise<void> {
  await addSnapshot(OWN_ANCHOR, '100000', ago(1));
}

async function maxSnapshotId(): Promise<string> {
  const [row] = await sql<{ max: string | null }[]>`SELECT max(id) AS max FROM price_snapshots`;
  return String(row.max);
}

/**
 * Block until some other backend is genuinely waiting on a `notify_seen` row
 * lock — and fail loudly if none ever does.
 *
 * A `setTimeout` here would make the concurrency case below silently vacuous:
 * if the route's UPDATE has not reached the lock by the time the blocker
 * commits, the statement simply runs afterwards and every assertion passes for
 * a reason that has nothing to do with what is being tested. Measured — a
 * 150ms sleep was not enough, and a deliberately-broken SERIALIZABLE
 * implementation passed. Asking Postgres who is waiting is the only version of
 * this that can tell the two apart.
 */
async function waitForBlockedWriter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%notify_seen%'`;
    if (row.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing ever blocked on notify_seen: the conflict was never staged');
}

async function storedMarker(): Promise<string> {
  const [row] = await sql<
    { last_seen_snapshot_id: string }[]
  >`SELECT last_seen_snapshot_id FROM notify_seen WHERE id = 1`;
  return String(row.last_seen_snapshot_id);
}

describe('POST /api/notifications/seen', () => {
  test('advances to the window ceiling, not to max(price_snapshots.id)', async () => {
    await seedRivalMove('100000', '40000');
    await seedRivalMove('100000', '70000');
    await seedHigherNonQualifyingSnapshot();

    const ceiling = await rivalMovesCeiling(DEFAULT_WINDOW);
    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lastSeenSnapshotId: ceiling });
    expect(await storedMarker()).toBe(ceiling);
    // Bigint as a string, compared as BigInt — never Number().
    expect(BigInt(await storedMarker())).toBeLessThan(BigInt(await maxSnapshotId()));
  });

  test('ignores an id in the body — the client cannot cap the ceiling', async () => {
    // The defect being designed out. A client that posted "the largest id I
    // rendered" would strand every qualifying row below it, because the feed is
    // ordered by consequence rather than by id.
    await seedRivalMove('100000', '40000');
    await seedRivalMove('100000', '70000');

    const ceiling = await rivalMovesCeiling(DEFAULT_WINDOW);
    const response = await post({ lastSeenSnapshotId: '1' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lastSeenSnapshotId: ceiling });
    expect(await storedMarker()).toBe(ceiling);
  });

  test('a window with nothing in it answers with the marker, not with null or zero', async () => {
    // A null ceiling is "nothing qualifies", not "start again from zero", and
    // not "no answer". The client writes this value into its badge state, so a
    // null or a 0 here re-announces the entire history on the next load.
    await seedHigherNonQualifyingSnapshot();
    await sql`UPDATE notify_seen SET last_seen_snapshot_id = 1 WHERE id = 1`;

    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lastSeenSnapshotId: '1' });
    expect(await storedMarker()).toBe('1');
  });

  test('a marker stranded above max(id) is answered clamped, not raw', async () => {
    // The state a destructive mirror leaves: `sync.py mirror` TRUNCATEs and
    // copies ids verbatim, so the target's max(id) can land below its own
    // marker. Reading the column directly would hand the client an id no row can
    // ever reach; `readSeen` clamps, and the page has a banner for exactly this.
    await seedHigherNonQualifyingSnapshot();
    await sql`UPDATE notify_seen SET last_seen_snapshot_id = 999999 WHERE id = 1`;

    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      lastSeenSnapshotId: await maxSnapshotId(),
    });
    // Clamped in the answer, untouched in the table — the correction is the
    // reader's view of the marker, not a write.
    expect(await storedMarker()).toBe('999999');
  });

  test('a marker already past the ceiling is not rewound', async () => {
    // Two tabs, or a request that arrived late. `advanceSeen` is a GREATEST for
    // this case; the route must not turn it back into an assignment.
    await seedRivalMove('100000', '40000');
    const ceiling = await rivalMovesCeiling(DEFAULT_WINDOW);
    const beyond = String(BigInt(ceiling as string) + BigInt(5));
    await sql`UPDATE notify_seen SET last_seen_snapshot_id = ${beyond} WHERE id = 1`;

    await expect((await post()).json()).resolves.toEqual({ lastSeenSnapshotId: beyond });
  });

  test('refuses a request with no session', async () => {
    jar.clear();
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    // And nothing moved.
    expect(await storedMarker()).toBe('0');
  });

  test('never answers from a cache', async () => {
    await seedRivalMove('100000', '40000');
    expect((await post()).headers.get('Cache-Control')).toContain('no-store');
  });

  test('reports a missing notify_seen row rather than answering 200', async () => {
    await seedRivalMove('100000', '40000');
    await sql`DELETE FROM notify_seen`;

    const response = await post();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.any(String),
      detail: expect.stringContaining('006_notify_seen'),
    });
  });

  test('a post blocked behind another writer converges instead of erroring', async () => {
    /**
     * The single-statement rule, made observable.
     *
     * `advanceSeen` must run as one autocommit statement. Under READ COMMITTED
     * a blocked UPDATE re-reads the just-committed row and **re-evaluates its
     * SET expression**, so `GREATEST` sees the winner's value and the two
     * converge with no lock and no read-modify-write. Under REPEATABLE READ or
     * SERIALIZABLE that stops being true: the blocked statement aborts with
     * 40001 and the second tab gets an error page instead of a cleared badge.
     *
     * The route cannot break this on its own, and that is worth stating because
     * it was checked rather than assumed: wrapping the *call* in `sql.begin`
     * does nothing, because `advanceSeen` issues its UPDATE on the module-level
     * `sql` and takes no transaction handle, so the statement lands on a
     * different pooled connection in autocommit regardless. The regression this
     * case is here for therefore lives in `seen.ts` — and both forms of it were
     * confirmed to fail here: the same UPDATE inside a REPEATABLE READ
     * transaction, and a read-modify-write in place of `GREATEST`.
     *
     * Firing N posts at once does not test this; whether they overlap is the
     * driver's choice, and measured, they mostly do not. So the conflict is
     * staged: a separate transaction takes the row lock, writes a HIGHER value,
     * and is held open until Postgres itself reports the route's UPDATE waiting
     * behind it.
     */
    await seedRivalMove('100000', '40000');
    const ceiling = await rivalMovesCeiling(DEFAULT_WINDOW);
    const beyond = String(BigInt(ceiling as string) + BigInt(100));

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocker = sql.begin(async (tx) => {
      await tx`UPDATE notify_seen SET last_seen_snapshot_id = ${beyond} WHERE id = 1`;
      await held;
    });

    let pending: Promise<Response>;
    try {
      pending = post();
      // Not a sleep: the conflict has to be observed before the lock is given
      // up, or this case proves nothing.
      await waitForBlockedWriter();
    } finally {
      release();
    }
    await blocker;

    const response = await pending;
    expect(response.status).toBe(200);
    // The winner's value, re-read: not `ceiling`, which is what a transaction
    // that had snapshotted the old row would have written.
    await expect(response.json()).resolves.toEqual({ lastSeenSnapshotId: beyond });
    expect(await storedMarker()).toBe(beyond);
  });
});

describe('the route surface', () => {
  /**
   * POST only, and the absence of the other exports is how that is enforced:
   * Next answers 405 for a method a route module does not export. A GET here
   * would mutate the marker on a link prefetch and on React's double render in
   * development — the badge would clear itself before anyone had read anything.
   */
  const HTTP_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

  test('exports POST and no other method', () => {
    expect(typeof route.POST).toBe('function');
    expect(HTTP_METHODS.filter((method) => method in route)).toEqual([]);
  });

  test('is force-dynamic, so nothing is prerendered against a database', () => {
    expect(route.dynamic).toBe('force-dynamic');
  });
});
