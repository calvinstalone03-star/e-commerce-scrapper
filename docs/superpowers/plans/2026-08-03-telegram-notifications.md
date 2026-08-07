# Telegram Notifications Implementation Plan

> **SUPERSEDED.** The feature this document describes was replaced by the
> in-dashboard notifications page. See
> [`docs/superpowers/specs/2026-08-07-dashboard-notifications-design.md`](../specs/2026-08-07-dashboard-notifications-design.md).
> Kept as the record of what was built and why it was removed; nothing here
> describes code that still exists.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `POST /api/notify` route handler in the Vercel dashboard that reads what changed in Postgres since a stored watermark and sends one grouped Telegram digest with dashboard deep links.

**Architecture:** The notifier reads the database rather than hooking either Python write path, so both are covered without a kaitan. State is a single-row `notify_watermark` table keyed on ids, not timestamps. A price change is only reported when its comparison snapshot is at least `NOTIFY_MIN_GAP_HOURS` older — the existing data shows 97% of sub-4-hour pairs differ against 0.2% of day-apart pairs, and those near pairs are a capture artefact, not repricing.

**Tech Stack:** Next.js 16.2.12 (App Router, route handlers, `proxy.ts`), TypeScript, postgres.js 3.4, vitest 4 against a real Postgres, Telegram Bot API over `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-03-telegram-notifications-design.md`

## Global Constraints

- **Read the bundled Next docs before writing Next-specific code.** `dashboard/AGENTS.md` requires it. Relevant files: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `.../16-proxy.md`, `.../03-api-reference/03-file-conventions/proxy.md`.
- **Middleware is called `proxy` in Next 16.** The file is `dashboard/src/proxy.ts`, exporting a named `proxy` function plus a `config.matcher`.
- **The dashboard's `sql` client is shared, not duplicated.** Import `{ sql }` from `@/lib/db`. Never call `postgres()` again — `db.ts:80` sets `max: 1` on Vercel deliberately.
- **Writes are confined to `notify/watermark.ts`.** No other new module may write to Postgres, and nothing may write to `stores`, `products`, `price_snapshots`, or `scrape_runs`.
- **Schema belongs to Python.** New tables go in `migrations/*.sql` and are applied by `ecom-scraper initdb`. The dashboard never migrates.
- **NUMERIC arrives as a string.** postgres.js hands `price` over as a string so no float rounding creeps in. Convert only at the formatting edge.
- **Tests run against a real Postgres**, `ecom_scraper_test`, one file at a time (`fileParallelism: false`). `src/lib/queries.test.ts:71-89` is the pattern: apply every `migrations/*.sql` in `beforeAll`, `TRUNCATE ... RESTART IDENTITY CASCADE` in `beforeEach`.
- **User-facing strings are Indonesian.** Comments and identifiers are English, matching the existing dashboard.
- **Secrets never reach logs or responses.** `NOTIFY_SECRET` and `TELEGRAM_BOT_TOKEN` are compared and sent, never printed.
- **Run `npm run test` and `npx tsc --noEmit` from `dashboard/` before every commit.**

## File Structure

| File | Responsibility |
|---|---|
| `migrations/005_notify_watermark.sql` | Table plus its seeded first row |
| `dashboard/src/lib/notify/watermark.ts` | The only writer. Read-for-update, ceilings, advance, stale-warning stamp |
| `dashboard/src/lib/notify/events.ts` | Three queries and the event types they produce |
| `dashboard/src/lib/notify/links.ts` | Event → dashboard URL. Pure |
| `dashboard/src/lib/notify/format.ts` | Events → Telegram HTML, folding, 4096-char splitting. Pure |
| `dashboard/src/lib/notify/telegram.ts` | Bot API client |
| `dashboard/src/lib/notify/run.ts` | `resolveSettings(env)` plus the transaction that ties the rest together |
| `dashboard/src/app/api/notify/route.ts` | Method and bearer-token guard, nothing else |
| `dashboard/src/lib/next-path.ts` | Validates a `?next=` value. Pure |
| `dashboard/src/proxy.ts` | Publishes the request path as a header so the layout can capture it |

Shared types live in `events.ts` and are imported by `links.ts`/`format.ts` with `import type`, which is erased at compile time — so the pure modules stay free of any runtime import of `server-only`.

---

### Task 1: The watermark table and its accessors

**Files:**
- Create: `migrations/005_notify_watermark.sql`
- Create: `dashboard/src/lib/notify/watermark.ts`
- Test: `dashboard/src/lib/notify/watermark.test.ts`

**Interfaces:**
- Consumes: `sql` from `@/lib/db`.
- Produces:
  - `type Watermark = { lastSnapshotId: string; lastProductId: number; lastStoreId: number; lastStaleWarningAt: Date | null }`
  - `type Ceilings = { snapshotId: string; productId: number; storeId: number }`
  - `readWatermarkForUpdate(tx: Sql): Promise<Watermark>`
  - `readCeilings(tx: Sql): Promise<Ceilings>`
  - `advanceWatermark(tx: Sql, ceilings: Ceilings): Promise<void>`
  - `stampStaleWarning(tx: Sql, at: Date): Promise<void>`
  - `type Sql = typeof sql` (exported so later tasks can type transaction handles)

`lastSnapshotId` and `Ceilings.snapshotId` are strings because `price_snapshots.id` is `bigint` and postgres.js hands `int8` over as a string. They are never compared in JavaScript — they travel back into SQL, where Postgres compares them.

- [ ] **Step 1: Write the migration**

Create `migrations/005_notify_watermark.sql`:

```sql
-- Where the Telegram notifier left off.
--
-- One row, three ids. The notifier asks "what has an id larger than this?" and
-- sends what comes back. Keyed on ids rather than timestamps because all three
-- source columns are serial and therefore monotonic, which makes this immune to
-- clock skew between the scraping laptop and the hosted database, to a scrape
-- whose `scraped_at` arrives out of order (real here — see the `abs()` in
-- scraper/store.py's insert_snapshot_if_changed), and to the overlap window a
-- time-based watermark has to guess at.
--
-- This is the one table the dashboard writes to. Its schema still lives here,
-- with every other table, so there is exactly one migration authority.
--
-- Idempotent like its neighbours: there is no applied-migrations ledger in this
-- directory, so re-running is the recovery path.

CREATE TABLE IF NOT EXISTS notify_watermark (
    id                    integer     PRIMARY KEY,
    last_snapshot_id      bigint      NOT NULL DEFAULT 0,
    last_product_id       integer     NOT NULL DEFAULT 0,
    last_store_id         integer     NOT NULL DEFAULT 0,
    last_stale_warning_at timestamptz,
    updated_at            timestamptz,
    -- Singleton enforced by the schema rather than by convention: a second row
    -- would mean two notifiers with two opinions about what has been sent.
    CONSTRAINT ck_notify_watermark_singleton CHECK (id = 1)
);

-- Seeded to the current maximums, not to zero. Everything already in the
-- database predates the notifier, and announcing 32 long-known shops as new
-- shops is not a useful first notification.
--
-- ON CONFLICT DO NOTHING rather than DO UPDATE: re-running this migration must
-- never rewind the watermark and re-send what has already been sent.
INSERT INTO notify_watermark (id, last_snapshot_id, last_product_id, last_store_id, updated_at)
VALUES (1,
        COALESCE((SELECT max(id) FROM price_snapshots), 0),
        COALESCE((SELECT max(id) FROM products), 0),
        COALESCE((SELECT max(id) FROM stores), 0),
        now())
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Apply it to both databases and confirm the seeded row**

```bash
cd /Users/calvin/ecom-scraper
.venv/bin/ecom-scraper initdb
psql postgresql://calvin@127.0.0.1:5432/ecom_scraper -c 'SELECT * FROM notify_watermark'
```

Expected: one row, `id = 1`, `last_snapshot_id = 13841`, `last_product_id = 14233`, `last_store_id = 248`. The exact numbers will be at or above these if more has been scraped since; what matters is that they are **not zero**.

```bash
createdb ecom_scraper_test 2>/dev/null || true
DATABASE_URL=postgresql://calvin@127.0.0.1:5432/ecom_scraper_test .venv/bin/ecom-scraper initdb
```

Expected on the test database: the same table, with all three ids `0`, because it is empty.

- [ ] **Step 3: Write the failing test**

Create `dashboard/src/lib/notify/watermark.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/watermark.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notify/watermark"`.

- [ ] **Step 5: Write the implementation**

Create `dashboard/src/lib/notify/watermark.ts`:

```ts
import 'server-only';

import { sql } from '@/lib/db';

/**
 * Where the notifier left off, and the only place this app writes.
 *
 * `db.ts` states that the dashboard never writes. This module is the stated
 * exception, and it is kept to one table so the rule still holds everywhere it
 * matters: nothing here touches `stores`, `products`, `price_snapshots` or
 * `scrape_runs`, and the schema is still created by a Python migration.
 *
 * Ids rather than timestamps throughout. `price_snapshots.id` is bigserial and
 * the other two are serial, so "larger than the watermark" is a total order
 * that no clock can disagree with.
 */

/** The client, or a transaction handle over it. Both accept the same tags. */
export type Sql = typeof sql;

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
 * The largest id in each source table, read once per run.
 *
 * Every query below bounds itself by these rather than by "whatever is in the
 * table now", and the watermark advances to exactly these. That closes the race
 * a bare `max(id)` at the end would open: a row inserted while the run is in
 * flight sits above the ceiling, is not examined, and is not skipped either —
 * the next run starts precisely where this one stopped looking.
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
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/watermark.test.ts
npx tsc --noEmit
```

Expected: 6 tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add migrations/005_notify_watermark.sql dashboard/src/lib/notify/watermark.ts dashboard/src/lib/notify/watermark.test.ts
git commit -m "Give the notifier a place to remember what it has sent

One row, three ids, seeded to the current maximums so the history that
predates the notifier is not announced as news. Ids rather than timestamps
because all three columns are serial: a scrape whose scraped_at arrives out
of order cannot then skip or repeat an event.

The ceilings are read once and advanced to exactly, which is what keeps a
row inserted mid-run from being swallowed by an advance computed before it
existed."
```

---

### Task 2: The three event queries

**Files:**
- Create: `dashboard/src/lib/notify/events.ts`
- Test: `dashboard/src/lib/notify/events.test.ts`

**Interfaces:**
- Consumes: `Sql`, `Watermark`, `Ceilings` from `@/lib/notify/watermark`.
- Produces:
  - `type PriceChange = { productId: number; name: string | null; setCode: string | null; marketplace: string; url: string | null; storeId: number | null; username: string | null; isOwn: boolean; previousPrice: string; price: string; scrapedAt: Date }`
  - `type NewStore = { storeId: number; marketplace: string; username: string; name: string | null; products: number }`
  - `type NewProduct = { productId: number; name: string | null; setCode: string | null; marketplace: string; url: string | null; storeId: number; username: string }`
  - `type Events = { priceChanges: PriceChange[]; newStores: NewStore[]; newProducts: NewProduct[] }`
  - `collectEvents(tx: Sql, watermark: Watermark, ceilings: Ceilings, minGapHours: number): Promise<Events>`
  - `latestScrapedAt(tx: Sql): Promise<Date | null>`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/notify/events.test.ts`:

```ts
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

async function addProduct(id: number, storeId: number, name: string): Promise<void> {
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/events.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notify/events"`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/src/lib/notify/events.ts`:

```ts
import 'server-only';

import type { Ceilings, Sql, Watermark } from '@/lib/notify/watermark';

/**
 * What has happened since the watermark.
 *
 * Three questions, three queries, all bounded above by the ceilings so that a
 * row arriving mid-run is neither examined twice nor skipped.
 */

export type PriceChange = {
  productId: number;
  name: string | null;
  setCode: string | null;
  marketplace: string;
  url: string | null;
  storeId: number | null;
  username: string | null;
  isOwn: boolean;
  /** NUMERIC, so a string. Converted only where it is formatted. */
  previousPrice: string;
  price: string;
  scrapedAt: Date;
};

export type NewStore = {
  storeId: number;
  marketplace: string;
  username: string;
  name: string | null;
  products: number;
};

export type NewProduct = {
  productId: number;
  name: string | null;
  setCode: string | null;
  marketplace: string;
  url: string | null;
  storeId: number;
  username: string;
};

export type Events = {
  priceChanges: PriceChange[];
  newStores: NewStore[];
  newProducts: NewProduct[];
};

export function hasAny(events: Events): boolean {
  return (
    events.priceChanges.length > 0 ||
    events.newStores.length > 0 ||
    events.newProducts.length > 0
  );
}

/**
 * Price movements worth reporting.
 *
 * Not `lag()`. The comparison this needs is not "the previous snapshot" but
 * "the newest snapshot at least `minGapHours` older", because in this database
 * adjacent captures disagree about price without anything having been repriced:
 * 37 of 38 pairs taken 1.5-3.5 hours apart differ, against 3 of 1,335 taken a
 * day apart, and `sold` is identical across the near pairs. A per-row search
 * for a qualifying predecessor is a LATERAL, not a window.
 *
 * `CROSS JOIN LATERAL` rather than `LEFT JOIN LATERAL`: a product with no
 * old-enough comparison produces no row at all, which is the wanted behaviour.
 * Without a trustworthy predecessor there is nothing to say — and that also
 * subsumes the "price became known" rule, since `price IS NOT NULL` is required
 * on both sides.
 *
 * `DISTINCT ON (product_ref)` collapses a product captured several times in one
 * run to its newest capture: one product, one event.
 *
 * The LATERAL is served by `ix_price_snapshots_product_ref_scraped_at`
 * (migrations/001_init.sql:94) — its column order and DESC direction already
 * match, so each lookup is one index seek rather than a scan.
 */
async function selectPriceChanges(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
  minGapHours: number,
): Promise<PriceChange[]> {
  const rows = await tx<
    {
      product_id: number;
      name: string | null;
      set_code: string | null;
      marketplace: string;
      url: string | null;
      store_id: number | null;
      username: string | null;
      is_own: boolean | null;
      previous_price: string;
      price: string;
      scraped_at: Date;
    }[]
  >`
    WITH latest_new AS (
      SELECT DISTINCT ON (ps.product_ref)
             ps.id, ps.product_ref, ps.price, ps.scraped_at
        FROM price_snapshots ps
       WHERE ps.id > ${watermark.lastSnapshotId}
         AND ps.id <= ${ceilings.snapshotId}
         AND ps.price IS NOT NULL
       ORDER BY ps.product_ref, ps.scraped_at DESC, ps.id DESC
    )
    SELECT p.id                AS product_id,
           p.name             AS name,
           p.set_code         AS set_code,
           p.marketplace      AS marketplace,
           p.url              AS url,
           s.id               AS store_id,
           s.username         AS username,
           s.is_own           AS is_own,
           older.price        AS previous_price,
           latest_new.price   AS price,
           latest_new.scraped_at AS scraped_at
      FROM latest_new
      CROSS JOIN LATERAL (
        SELECT ps.price
          FROM price_snapshots ps
         WHERE ps.product_ref = latest_new.product_ref
           AND ps.price IS NOT NULL
           -- Excluding the row itself matters only at minGapHours = 0, where
           -- `scraped_at <= scraped_at` admits it and the ORDER BY then makes it
           -- the nearest match — every product would compare against itself and
           -- nothing would ever be reported.
           AND ps.id <> latest_new.id
           AND ps.scraped_at <= latest_new.scraped_at - make_interval(hours => ${minGapHours})
         ORDER BY ps.scraped_at DESC, ps.id DESC
         LIMIT 1
      ) AS older
      JOIN products p ON p.id = latest_new.product_ref
      LEFT JOIN stores s ON s.id = p.shop_ref
     WHERE latest_new.price <> older.price
     ORDER BY latest_new.id`;

  return rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    setCode: row.set_code,
    marketplace: row.marketplace,
    url: row.url,
    storeId: row.store_id,
    username: row.username,
    // A product whose shop was never resolved has no `is_own` to read. It is
    // not ours until something says it is.
    isOwn: row.is_own ?? false,
    previousPrice: String(row.previous_price),
    price: String(row.price),
    scrapedAt: row.scraped_at,
  }));
}

async function selectNewStores(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
): Promise<NewStore[]> {
  const rows = await tx<
    {
      store_id: number;
      marketplace: string;
      username: string;
      name: string | null;
      products: string;
    }[]
  >`
    SELECT s.id          AS store_id,
           s.marketplace AS marketplace,
           s.username    AS username,
           s.name        AS name,
           (SELECT count(*) FROM products p WHERE p.shop_ref = s.id) AS products
      FROM stores s
     WHERE s.id > ${watermark.lastStoreId}
       AND s.id <= ${ceilings.storeId}
     ORDER BY s.id`;

  return rows.map((row) => ({
    storeId: row.store_id,
    marketplace: row.marketplace,
    username: row.username,
    name: row.name,
    products: Number(row.products),
  }));
}

/**
 * New listings in shops that were already known.
 *
 * `s.id <= watermark.lastStoreId` is the whole requirement in one clause. A
 * shop discovered in this same run has not passed the watermark, so its
 * catalogue — up to 1,600 listings — is not reported listing by listing. The
 * shop itself is the news; its listings become news from the next run on.
 */
async function selectNewProducts(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
): Promise<NewProduct[]> {
  const rows = await tx<
    {
      product_id: number;
      name: string | null;
      set_code: string | null;
      marketplace: string;
      url: string | null;
      store_id: number;
      username: string;
    }[]
  >`
    SELECT p.id          AS product_id,
           p.name        AS name,
           p.set_code    AS set_code,
           p.marketplace AS marketplace,
           p.url         AS url,
           s.id          AS store_id,
           s.username    AS username
      FROM products p
      JOIN stores s ON s.id = p.shop_ref
     WHERE p.id > ${watermark.lastProductId}
       AND p.id <= ${ceilings.productId}
       AND s.id <= ${watermark.lastStoreId}
     ORDER BY p.id`;

  return rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    setCode: row.set_code,
    marketplace: row.marketplace,
    url: row.url,
    storeId: row.store_id,
    username: row.username,
  }));
}

export async function collectEvents(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
  minGapHours: number,
): Promise<Events> {
  const [priceChanges, newStores, newProducts] = await Promise.all([
    selectPriceChanges(tx, watermark, ceilings, minGapHours),
    selectNewStores(tx, watermark, ceilings),
    selectNewProducts(tx, watermark, ceilings),
  ]);
  return { priceChanges, newStores, newProducts };
}

/**
 * The newest observation in the database the notifier is reading.
 *
 * Not an event — the input to the staleness guard. Silence is the notifier's
 * correct answer when nothing changed and its symptom when nothing is being
 * written, and this is what distinguishes the two.
 */
export async function latestScrapedAt(tx: Sql): Promise<Date | null> {
  const [row] = await tx<{ latest: Date | null }[]>`
    SELECT max(scraped_at) AS latest FROM price_snapshots`;
  return row?.latest ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/events.test.ts
npx tsc --noEmit
```

Expected: 13 tests pass.

- [ ] **Step 5: Verify against the production data**

This is the benchmark from the spec. It runs the same SQL by hand against the real database, so a passing unit suite that has the logic subtly wrong is still caught.

```bash
psql postgresql://calvin@127.0.0.1:5432/ecom_scraper -P pager=off -c "
WITH latest_new AS (
  SELECT DISTINCT ON (ps.product_ref) ps.id, ps.product_ref, ps.price, ps.scraped_at
    FROM price_snapshots ps
   WHERE ps.id > 12508 AND ps.price IS NOT NULL
   ORDER BY ps.product_ref, ps.scraped_at DESC, ps.id DESC)
SELECT (SELECT count(*) FROM latest_new l
        CROSS JOIN LATERAL (SELECT ps.price FROM price_snapshots ps
                             WHERE ps.product_ref = l.product_ref AND ps.price IS NOT NULL
                               AND ps.scraped_at <= l.scraped_at - make_interval(hours => 12)
                             ORDER BY ps.scraped_at DESC, ps.id DESC LIMIT 1) o
        WHERE l.price <> o.price) AS gap_12,
       (SELECT count(*) FROM latest_new l
        CROSS JOIN LATERAL (SELECT ps.price FROM price_snapshots ps
                             WHERE ps.product_ref = l.product_ref AND ps.price IS NOT NULL
                               AND ps.scraped_at <= l.scraped_at - make_interval(hours => 0)
                             ORDER BY ps.scraped_at DESC, ps.id DESC LIMIT 1) o
        WHERE l.price <> o.price) AS gap_0,
       (SELECT count(*) FROM stores WHERE id > 248) AS new_stores,
       (SELECT count(*) FROM products p JOIN stores s ON s.id = p.shop_ref
         WHERE p.id > 12950 AND s.id <= 248) AS new_products"
```

Expected: `gap_12 = 3`, `new_stores = 0`, `new_products = 4`.

**`gap_0` is not a useful check at this watermark, and an earlier draft of this plan wrongly required it to exceed `gap_12`.** Measured against the production data, the 37 artefact pairs have their newer row at snapshot ids 2718–3012 and the 3 genuine pairs at 13656–13840. Watermark 12508 sits above every artefact, so no threshold can bring them back: `gap_0 = gap_12 = 3` here is correct.

The watermark that exercises the rule is **0**. Run the same query with `ps.id > 0` for both thresholds:

| Watermark | `NOTIFY_MIN_GAP_HOURS` | Price changes |
|---|---|---|
| 0 | 0 | **40** |
| 0 | 12 | **3** |
| 12508 | 12 | **3** |

The first row is the equivalence check: with the threshold off, this query must agree exactly with a plain `lag()` over the whole table, which independently counts 40. If it does not, the LATERAL is selecting a different predecessor than `lag()` would and the difference is a bug, not a threshold.

The second row is the rule working: the same 40 candidates, minus the 37 whose only comparison is hours old.

- [ ] **Step 6: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/notify/events.ts dashboard/src/lib/notify/events.test.ts
git commit -m "Ask what changed, with a comparison old enough to trust

A LATERAL rather than lag(), because the comparison wanted is not the
previous snapshot but the newest one past an age threshold. In this database
adjacent captures disagree about price without anything being repriced: 37
of 38 pairs 1.5-3.5 hours apart differ against 3 of 1,335 a day apart, with
sold identical across the near pairs.

CROSS JOIN, not LEFT JOIN: a product with no old-enough comparison drops out
entirely, which also subsumes the rule that a price becoming known is not a
price change.

New products are filtered by the store watermark rather than the product
one, so a shop discovered this run is announced once instead of once per
listing it brought with it."
```

---

### Task 3: Dashboard links

**Files:**
- Create: `dashboard/src/lib/notify/links.ts`
- Test: `dashboard/src/lib/notify/links.test.ts`

**Interfaces:**
- Consumes: `PriceChange`, `NewProduct`, `NewStore` types from `@/lib/notify/events`; `CHANNEL_PARAM` from `@/lib/channel`.
- Produces:
  - `resolveBaseUrl(env: { NOTIFY_BASE_URL?: string; VERCEL_PROJECT_PRODUCTION_URL?: string }): string`
  - `priceChangeLink(change: PriceChange): string` — path with query, no host
  - `newStoreLink(store: NewStore): string`
  - `newProductLink(product: NewProduct): string`
  - `absolute(baseUrl: string, path: string): string`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/notify/links.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import type { NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import {
  absolute,
  newProductLink,
  newStoreLink,
  priceChangeLink,
  resolveBaseUrl,
} from '@/lib/notify/links';

/**
 * Where a notification points.
 *
 * `/pricing/[id]` only accepts our own products — queries.ts:769 joins
 * `AND s.is_own`, and a rival's id is a 404. Every price change in the data so
 * far belongs to a rival, so this is not a detail: getting it wrong sends every
 * useful notification to a not-found page.
 */

const change = (over: Partial<PriceChange> = {}): PriceChange => ({
  productId: 10017,
  name: 'Lego Creator 10272 Old Trafford',
  setCode: '10272',
  marketplace: 'tokopedia',
  url: 'https://tokopedia.com/x/y',
  storeId: 167,
  username: 'kenjiro13',
  isOwn: false,
  previousPrice: '12000000',
  price: '15000000',
  scrapedAt: new Date('2026-08-03T02:54:00Z'),
  ...over,
});

describe('resolveBaseUrl', () => {
  test('prefers an explicit override', () => {
    expect(
      resolveBaseUrl({ NOTIFY_BASE_URL: 'https://dash.example', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }),
    ).toBe('https://dash.example');
  });

  test('falls back to the production domain Vercel publishes, with a scheme', () => {
    expect(resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' })).toBe('https://x.vercel.app');
  });

  test('trims a trailing slash so joining never doubles it', () => {
    expect(resolveBaseUrl({ NOTIFY_BASE_URL: 'https://dash.example/' })).toBe('https://dash.example');
  });

  test('refuses to guess when neither is set', () => {
    expect(() => resolveBaseUrl({})).toThrow(/NOTIFY_BASE_URL/);
  });
});

describe('priceChangeLink', () => {
  test('sends our own product to its price-position detail', () => {
    expect(priceChangeLink(change({ isOwn: true, productId: 42 }))).toBe('/pricing/42');
  });

  test('sends a rival with a set number to our position on that set', () => {
    expect(priceChangeLink(change())).toBe('/pricing?kanal=tokopedia&q=10272');
  });

  test('sends a rival without a set number to the product list', () => {
    expect(priceChangeLink(change({ setCode: null, name: 'Rak Display Akrilik' }))).toBe(
      '/products?q=Rak+Display+Akrilik',
    );
  });

  test('falls back to the product list when a rival has neither set number nor name', () => {
    expect(priceChangeLink(change({ setCode: null, name: null }))).toBe('/products');
  });
});

describe('newStoreLink', () => {
  test('points at the store page by our primary key', () => {
    const store: NewStore = {
      storeId: 249,
      marketplace: 'shopee',
      username: 'toko-baru',
      name: null,
      products: 1600,
    };
    expect(newStoreLink(store)).toBe('/stores/249');
  });
});

describe('newProductLink', () => {
  test('points at the product list filtered to its store', () => {
    const product: NewProduct = {
      productId: 13657,
      name: 'Lego Art 31209 The Amazing Spider-Man',
      setCode: '31209',
      marketplace: 'tokopedia',
      url: null,
      storeId: 167,
      username: 'kenjiro13',
    };
    expect(newProductLink(product)).toBe('/products?storeId=167');
  });
});

describe('absolute', () => {
  test('joins a base and a path without doubling the slash', () => {
    expect(absolute('https://dash.example', '/pricing/42')).toBe('https://dash.example/pricing/42');
  });

  test('keeps the query string intact', () => {
    expect(absolute('https://dash.example', '/pricing?kanal=shopee&q=42218')).toBe(
      'https://dash.example/pricing?kanal=shopee&q=42218',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/links.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notify/links"`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/src/lib/notify/links.ts`:

```ts
import { CHANNEL_PARAM } from '@/lib/channel';
import type { NewProduct, NewStore, PriceChange } from '@/lib/notify/events';

/**
 * Where a notification points.
 *
 * There is no uniform answer, because `/pricing/[id]` is scoped to our own
 * shops: `getPricePositionDetail` joins `AND s.is_own` (queries.ts:769) and a
 * rival's id 404s at `pricing/[id]/page.tsx:61`. Every price change observed so
 * far belongs to a rival, so the rival paths are the common case, not the
 * fallback.
 *
 * For a rival the useful destination is not their listing but ours: when a
 * competitor moves, the question is where that leaves us. `/pricing` searches
 * `set_code` by prefix (queries.ts:409), so a set number lands on exactly that
 * comparison.
 *
 * No `server-only` and no database access — pure string work, so the choices
 * here are testable without a Postgres.
 */

export function resolveBaseUrl(env: {
  NOTIFY_BASE_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}): string {
  // VERCEL_URL is deliberately not consulted: it names the individual
  // deployment and changes on every push, so links already sent to Telegram
  // would rot. VERCEL_PROJECT_PRODUCTION_URL is the stable production domain,
  // and follows a custom domain if one is ever attached.
  const explicit = env.NOTIFY_BASE_URL?.trim();
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();

  const chosen = explicit || (vercel ? `https://${vercel}` : '');
  if (!chosen) {
    throw new Error(
      'No base URL for notification links. Set NOTIFY_BASE_URL, or deploy where ' +
        'VERCEL_PROJECT_PRODUCTION_URL is set.',
    );
  }

  return chosen.replace(/\/+$/, '');
}

export function priceChangeLink(change: PriceChange): string {
  // Our own listing has a detail page, and it repairs its own `kanal` from the
  // database (pricing/[id]/page.tsx:68), so a bare path lands correctly.
  if (change.isOwn) return `/pricing/${change.productId}`;

  // A rival with a set number: our position on that set.
  if (change.setCode) {
    const params = new URLSearchParams({ [CHANNEL_PARAM]: change.marketplace, q: change.setCode });
    return `/pricing?${params.toString()}`;
  }

  // Accessories, bundles and knock-offs carry no set number, and `/pricing` has
  // nothing to match them on. `/products` searches names and spans both
  // marketplaces.
  if (change.name) {
    return `/products?${new URLSearchParams({ q: change.name }).toString()}`;
  }

  return '/products';
}

export function newStoreLink(store: NewStore): string {
  return `/stores/${store.storeId}`;
}

export function newProductLink(product: NewProduct): string {
  return `/products?${new URLSearchParams({ storeId: String(product.storeId) }).toString()}`;
}

export function absolute(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/links.test.ts
npx tsc --noEmit
```

Expected: 12 tests pass (4 for `resolveBaseUrl`, 4 for `priceChangeLink`, 1 each for `newStoreLink` and `newProductLink`, 2 for `absolute`).

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/notify/links.ts dashboard/src/lib/notify/links.test.ts
git commit -m "Point each notification somewhere that will actually open

/pricing/[id] joins AND s.is_own, so a rival's id is a 404 there — and every
price change in the data so far belongs to a rival. Rivals go to /pricing
filtered by set number instead, which answers the question a competitor's
move actually raises: where does that leave us.

Base URL comes from VERCEL_PROJECT_PRODUCTION_URL rather than VERCEL_URL,
which changes on every deploy and would rot links already sitting in a
Telegram history."
```

---

### Task 4: The digest

**Files:**
- Create: `dashboard/src/lib/notify/format.ts`
- Test: `dashboard/src/lib/notify/format.test.ts`

**Interfaces:**
- Consumes: `Events`, `PriceChange` from `@/lib/notify/events`; `priceChangeLink`, `newStoreLink`, `newProductLink`, `absolute` from `@/lib/notify/links`.
- Produces:
  - `escapeHtml(value: string): string`
  - `foldPriceChanges(changes: PriceChange[]): FoldedGroup[]` where `type FoldedGroup = { kind: 'folded'; username: string | null; marketplace: string; delta: number; members: PriceChange[] } | { kind: 'single'; change: PriceChange }`
  - `renderDigest(events: Events, options: { baseUrl: string; now: Date }): string[]` — one string per Telegram message
  - `renderStaleWarning(options: { latest: Date | null; hours: number }): string`
  - `FOLD_MIN_GROUP = 3`
  - `TELEGRAM_MAX_CHARS = 4096`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/notify/format.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import {
  TELEGRAM_MAX_CHARS,
  escapeHtml,
  foldPriceChanges,
  renderDigest,
  renderStaleWarning,
} from '@/lib/notify/format';

/**
 * The message itself.
 *
 * Almost every bug that survives to production hides here rather than in the
 * SQL: an unescaped `&` in a listing title makes Telegram reject the whole
 * message with a 400, and a split that lands mid-line makes a digest
 * unreadable without failing anything.
 */

const BASE_URL = 'https://dash.example';
const NOW = new Date('2026-08-03T02:54:00Z');

const change = (over: Partial<PriceChange> = {}): PriceChange => ({
  productId: 1,
  name: 'LEGO Technic 42218 John Deere',
  setCode: '42218',
  marketplace: 'shopee',
  url: null,
  storeId: 1,
  username: 'lego.indonesia',
  isOwn: false,
  previousPrice: '186850',
  price: '211850',
  scrapedAt: NOW,
  ...over,
});

const empty: Events = { priceChanges: [], newStores: [], newProducts: [] };

describe('escapeHtml', () => {
  test('escapes exactly the three characters Telegram HTML reserves', () => {
    expect(escapeHtml('Batman & Robin <set> "x"')).toBe('Batman &amp; Robin &lt;set&gt; "x"');
  });
});

describe('foldPriceChanges', () => {
  test('folds three or more identical deltas from one store', () => {
    const changes = [1, 2, 3].map((id) => change({ productId: id }));
    const folded = foldPriceChanges(changes);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: 'folded', delta: 25000, username: 'lego.indonesia' });
  });

  test('leaves two identical deltas alone — a coincidence is not a pattern', () => {
    const changes = [1, 2].map((id) => change({ productId: id }));
    const folded = foldPriceChanges(changes);
    expect(folded).toHaveLength(2);
    expect(folded.every((entry) => entry.kind === 'single')).toBe(true);
  });

  test('does not fold across stores even when the delta matches', () => {
    const changes = [
      change({ productId: 1, storeId: 1, username: 'a' }),
      change({ productId: 2, storeId: 1, username: 'a' }),
      change({ productId: 3, storeId: 2, username: 'b' }),
    ];
    const folded = foldPriceChanges(changes);
    expect(folded.filter((entry) => entry.kind === 'folded')).toHaveLength(0);
  });

  test('does not fold a rise into a fall of the same magnitude', () => {
    const changes = [
      change({ productId: 1, previousPrice: '100000', price: '125000' }),
      change({ productId: 2, previousPrice: '100000', price: '125000' }),
      change({ productId: 3, previousPrice: '125000', price: '100000' }),
    ];
    const folded = foldPriceChanges(changes);
    expect(folded.filter((entry) => entry.kind === 'folded')).toHaveLength(0);
  });
});

describe('renderDigest', () => {
  test('says nothing at all when nothing happened', () => {
    expect(renderDigest(empty, { baseUrl: BASE_URL, now: NOW })).toEqual([]);
  });

  test('separates rises from falls and counts each', () => {
    const events: Events = {
      ...empty,
      priceChanges: [
        change({ productId: 1, previousPrice: '100000', price: '125000' }),
        change({ productId: 2, previousPrice: '532100', price: '495200', setCode: '77242' }),
      ],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('Naik harga — 1');
    expect(message).toContain('Turun harga — 1');
  });

  test('orders a group by percentage, largest first', () => {
    const events: Events = {
      ...empty,
      priceChanges: [
        change({ productId: 1, previousPrice: '1000000', price: '1010000', setCode: '11111' }),
        change({ productId: 2, previousPrice: '100000', price: '200000', setCode: '22222' }),
      ],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });
    expect(message.indexOf('22222')).toBeLessThan(message.indexOf('11111'));
  });

  test('escapes a listing name that would otherwise break the parse', () => {
    const events: Events = {
      ...empty,
      priceChanges: [change({ name: 'Batman & Robin <rare>' })],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('Batman &amp; Robin &lt;rare&gt;');
    expect(message).not.toContain('Batman & Robin <rare>');
  });

  test('makes every link absolute', () => {
    const events: Events = { ...empty, priceChanges: [change()] };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });
    expect(message).toContain('https://dash.example/pricing?kanal=shopee&amp;q=42218');
  });

  test('reports a new store once, with its listing count', () => {
    const store: NewStore = {
      storeId: 249,
      marketplace: 'shopee',
      username: 'toko-baru',
      name: null,
      products: 1600,
    };
    const [message] = renderDigest({ ...empty, newStores: [store] }, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('Toko baru — 1');
    expect(message).toContain('1.600');
  });

  test('reports new products in a known store', () => {
    const product: NewProduct = {
      productId: 13657,
      name: 'Lego Art 31209 The Amazing Spider-Man',
      setCode: '31209',
      marketplace: 'tokopedia',
      url: null,
      storeId: 167,
      username: 'kenjiro13',
    };
    const [message] = renderDigest(
      { ...empty, newProducts: [product] },
      { baseUrl: BASE_URL, now: NOW },
    );

    expect(message).toContain('Produk baru di toko lama — 1');
    expect(message).toContain('Lego Art 31209');
  });

  test('keeps every message inside the Telegram limit', () => {
    const events: Events = {
      ...empty,
      priceChanges: Array.from({ length: 400 }, (_, index) =>
        change({
          productId: index + 1,
          setCode: String(10000 + index),
          name: `LEGO Very Long Product Name Number ${index} With Padding To Make It Wide`,
          previousPrice: String(100000 + index * 1000),
          price: String(200000 + index * 3000),
        }),
      ),
    };

    const messages = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  test('never splits inside a line', () => {
    const events: Events = {
      ...empty,
      priceChanges: Array.from({ length: 400 }, (_, index) =>
        change({
          productId: index + 1,
          setCode: String(10000 + index),
          name: `LEGO Very Long Product Name Number ${index} With Padding To Make It Wide`,
        }),
      ),
    };

    for (const message of renderDigest(events, { baseUrl: BASE_URL, now: NOW })) {
      // A split mid-tag would leave an unbalanced <a>. Count them instead of
      // eyeballing: every opened anchor must close in the same message.
      const opened = (message.match(/<a /g) ?? []).length;
      const closed = (message.match(/<\/a>/g) ?? []).length;
      expect(opened).toBe(closed);
    }
  });

  test('states the true total in the heading even when the body is truncated', () => {
    const events: Events = {
      ...empty,
      priceChanges: Array.from({ length: 400 }, (_, index) =>
        change({ productId: index + 1, setCode: String(10000 + index) }),
      ),
    };
    const messages = renderDigest(events, { baseUrl: BASE_URL, now: NOW });
    expect(messages[0]).toContain('Naik harga — 400');
  });
});

describe('renderStaleWarning', () => {
  test('names how long the data has been still and what to check', () => {
    const message = renderStaleWarning({
      latest: new Date('2026-07-29T14:14:00Z'),
      hours: 128,
    });
    expect(message).toContain('128 jam');
    expect(message).toContain('DATABASE_URL');
  });

  test('handles a database with no snapshots at all', () => {
    const message = renderStaleWarning({ latest: null, hours: 0 });
    expect(message).toContain('belum ada snapshot');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/format.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notify/format"`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/src/lib/notify/format.ts`:

```ts
import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import { absolute, newProductLink, newStoreLink, priceChangeLink } from '@/lib/notify/links';

/**
 * The digest, as Telegram HTML.
 *
 * HTML rather than MarkdownV2: MarkdownV2 requires escaping some fifteen
 * characters, and these listing names are full of `(`, `)`, `-`, `.` and `–`.
 * One missed character is a 400 for the entire message. HTML needs three.
 *
 * Pure: no network, no database, no clock of its own. Everything that varies
 * arrives as an argument, so the cases that matter — folding, escaping,
 * splitting — are testable without any of it.
 */

export const TELEGRAM_MAX_CHARS = 4096;

/** Below this, listings that moved by the same amount are a coincidence. */
export const FOLD_MIN_GROUP = 3;

const rupiah = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});
const plain = new Intl.NumberFormat('id-ID');
const stamp = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Jakarta',
});

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value: number): string {
  return rupiah.format(value);
}

function signedMoney(value: number): string {
  return `${value > 0 ? '+' : '−'}${money(Math.abs(value))}`;
}

function percent(from: number, to: number): string {
  if (from === 0) return '';
  const pct = ((to - from) / from) * 100;
  const sign = pct > 0 ? '+' : '−';
  return `${sign}${Math.abs(pct).toFixed(1).replace('.', ',')}%`;
}

function link(baseUrl: string, path: string, label: string): string {
  // The href is escaped too: `/pricing?kanal=x&q=y` carries a bare `&`, which is
  // not valid inside an HTML attribute and which Telegram rejects.
  return `<a href="${escapeHtml(absolute(baseUrl, path))}">${escapeHtml(label)}</a>`;
}

function shopLabel(username: string | null, marketplace: string): string {
  const shop = username ?? 'toko tak dikenal';
  const channel = marketplace === 'tokopedia' ? 'Tokopedia' : 'Shopee';
  return `${shop} · ${channel}`;
}

export type FoldedGroup =
  | {
      kind: 'folded';
      username: string | null;
      marketplace: string;
      delta: number;
      members: PriceChange[];
    }
  | { kind: 'single'; change: PriceChange };

function delta(change: PriceChange): number {
  return Number(change.price) - Number(change.previousPrice);
}

/**
 * Collapse a store's simultaneous identical moves into one line.
 *
 * A shop that repriced its whole catalogue made one decision, and printing it
 * as 33 lines that each say the same thing buries everything else in the
 * digest. Keyed on store **and** signed delta, so a rise never folds into a
 * fall of the same size.
 */
export function foldPriceChanges(changes: PriceChange[]): FoldedGroup[] {
  const groups = new Map<string, PriceChange[]>();
  for (const change of changes) {
    const key = `${change.storeId ?? 'null'}|${delta(change)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(change);
    else groups.set(key, [change]);
  }

  const folded: FoldedGroup[] = [];
  for (const members of groups.values()) {
    if (members.length >= FOLD_MIN_GROUP) {
      folded.push({
        kind: 'folded',
        username: members[0].username,
        marketplace: members[0].marketplace,
        delta: delta(members[0]),
        members,
      });
    } else {
      for (const change of members) folded.push({ kind: 'single', change });
    }
  }

  // Biggest proportional move first, whether folded or not: a listing that
  // moved 66,7% deserves to be read before one that moved 1,3%.
  const weight = (entry: FoldedGroup): number =>
    entry.kind === 'folded'
      ? Math.abs(delta(entry.members[0]) / Number(entry.members[0].previousPrice))
      : Math.abs(delta(entry.change) / Number(entry.change.previousPrice));

  return folded.sort((left, right) => weight(right) - weight(left));
}

function renderPriceGroup(
  heading: string,
  changes: PriceChange[],
  baseUrl: string,
): string[] {
  if (changes.length === 0) return [];

  // The heading always states the true total, even when the body below it is
  // later truncated for length. A count that shrinks with the message would be
  // a lie about how much moved.
  const lines = [`<b>${escapeHtml(heading)} — ${plain.format(changes.length)}</b>`, ''];

  for (const entry of foldPriceChanges(changes)) {
    if (entry.kind === 'folded') {
      lines.push(`  <b>${escapeHtml(shopLabel(entry.username, entry.marketplace))}</b>`);
      lines.push(
        `  ${escapeHtml(signedMoney(entry.delta))} serempak di ${plain.format(entry.members.length)} listing`,
      );
      lines.push(`  ${link(baseUrl, priceChangeLink(entry.members[0]), 'lihat listingnya')}`);
      lines.push('');
      continue;
    }

    const change = entry.change;
    const from = Number(change.previousPrice);
    const to = Number(change.price);
    lines.push(
      `  • ${escapeHtml(change.name ?? 'tanpa nama')} — ${escapeHtml(shopLabel(change.username, change.marketplace))}`,
    );
    lines.push(`    ${escapeHtml(`${money(from)} → ${money(to)}`)}  (${escapeHtml(percent(from, to))})`);
    lines.push(
      `    ${link(baseUrl, priceChangeLink(change), change.setCode ? `posisi kita di ${change.setCode}` : 'lihat di dashboard')}`,
    );
    lines.push('');
  }

  return lines;
}

function renderNewStores(stores: NewStore[], baseUrl: string): string[] {
  if (stores.length === 0) return [];
  const lines = [`<b>Toko baru — ${plain.format(stores.length)}</b>`, ''];
  for (const store of stores) {
    lines.push(
      `  • ${escapeHtml(store.name ?? store.username)} — ${escapeHtml(shopLabel(store.username, store.marketplace))}`,
    );
    lines.push(`    ${plain.format(store.products)} listing`);
    lines.push(`    ${link(baseUrl, newStoreLink(store), 'buka toko')}`);
    lines.push('');
  }
  return lines;
}

function renderNewProducts(products: NewProduct[], baseUrl: string): string[] {
  if (products.length === 0) return [];
  const lines = [`<b>Produk baru di toko lama — ${plain.format(products.length)}</b>`, ''];
  for (const product of products) {
    lines.push(
      `  • ${escapeHtml(product.name ?? 'tanpa nama')} — ${escapeHtml(shopLabel(product.username, product.marketplace))}  ${link(baseUrl, newProductLink(product), 'lihat')}`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * Pack lines into messages, splitting only between lines.
 *
 * A split inside a line can land inside an `<a href=...>`, which leaves an
 * unbalanced tag and makes Telegram reject the message. Splitting on line
 * boundaries cannot.
 *
 * A single line longer than the whole limit cannot be placed anywhere, so it is
 * hard-truncated — the only case where a character boundary is cut, and it is
 * the alternative to dropping the line entirely.
 */
function paginate(lines: string[]): string[] {
  const messages: string[] = [];
  let current: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    messages.push(current.join('\n').trimEnd());
    current = [];
    length = 0;
  };

  for (const raw of lines) {
    const line = raw.length > TELEGRAM_MAX_CHARS ? `${raw.slice(0, TELEGRAM_MAX_CHARS - 1)}…` : raw;
    // +1 for the newline that will join it to the previous line.
    if (length + line.length + 1 > TELEGRAM_MAX_CHARS) flush();
    current.push(line);
    length += line.length + 1;
  }

  flush();
  return messages;
}

export function renderDigest(
  events: Events,
  options: { baseUrl: string; now: Date },
): string[] {
  const rises = events.priceChanges.filter((change) => Number(change.price) > Number(change.previousPrice));
  const falls = events.priceChanges.filter((change) => Number(change.price) < Number(change.previousPrice));

  const lines = [
    `<b>📊 ${escapeHtml(stamp.format(options.now))}</b>`,
    '',
    ...renderPriceGroup('📈 Naik harga', rises, options.baseUrl),
    ...renderPriceGroup('📉 Turun harga', falls, options.baseUrl),
    ...renderNewStores(events.newStores, options.baseUrl),
    ...renderNewProducts(events.newProducts, options.baseUrl),
  ];

  // Nothing but the timestamp means nothing happened, and a notification that
  // says only "here is the time" is worse than no notification.
  const hasBody = lines.slice(2).some((line) => line.trim() !== '');
  if (!hasBody) return [];

  return paginate(lines);
}

/**
 * The message sent when the database is not moving.
 *
 * Silence is the notifier's correct answer to "nothing changed" and its symptom
 * when nothing is being written. Without this, a scraper writing to one
 * database while the notifier reads another is indistinguishable from a quiet
 * week — which is precisely the failure README line 587 predicts.
 */
export function renderStaleWarning(options: { latest: Date | null; hours: number }): string {
  const when = options.latest
    ? `Snapshot terbaru: ${stamp.format(options.latest)} (${plain.format(Math.round(options.hours))} jam lalu).`
    : 'Database ini belum ada snapshot sama sekali.';

  return [
    '<b>⚠️ Data tidak bergerak</b>',
    '',
    escapeHtml(when),
    escapeHtml('Notifier membaca database ini, tapi tidak ada yang menulis ke sini.'),
    '',
    escapeHtml(
      'Periksa DATABASE_URL di .env root repo — kalau ia menunjuk 127.0.0.1, ' +
        'hasil scrape masuk ke laptop dan tidak pernah sampai ke sini.',
    ),
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/format.test.ts
npx tsc --noEmit
```

Expected: 17 tests pass (1 for `escapeHtml`, 4 for `foldPriceChanges`, 10 for `renderDigest`, 2 for `renderStaleWarning`).

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/notify/format.ts dashboard/src/lib/notify/format.test.ts
git commit -m "Render a digest that survives contact with real listing names

HTML rather than MarkdownV2: these titles are full of parentheses, dashes
and dots, and MarkdownV2 rejects the whole message over one unescaped
character.

Folding collapses a store's simultaneous identical moves into one line,
keyed on store and signed delta so a rise never folds into a fall. Below
three, listings print separately — two matching deltas are a coincidence,
not a repricing.

Splitting happens between lines only. A cut inside a line can land inside an
href and leave an unbalanced anchor, which is a 400 rather than a cosmetic
problem. Group headings keep the true total even when the body is truncated."
```

---

### Task 5: The Telegram client

**Files:**
- Create: `dashboard/src/lib/notify/telegram.ts`
- Test: `dashboard/src/lib/notify/telegram.test.ts`

**Interfaces:**
- Produces:
  - `type TelegramConfig = { botToken: string; chatId: string; fetchImpl?: typeof fetch; timeoutMs?: number }`
  - `sendMessages(messages: string[], config: TelegramConfig): Promise<number>` — resolves with the count sent, rejects on the first failure

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/notify/telegram.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { sendMessages } from '@/lib/notify/telegram';

/**
 * The Bot API call.
 *
 * Two things matter and neither is the happy path: that a failure stops the
 * run rather than being swallowed (the watermark must not advance past a
 * message nobody received), and that the bot token never appears in an error.
 */

const config = (fetchImpl: typeof fetch) => ({
  botToken: 'SECRET-TOKEN',
  chatId: '12345',
  fetchImpl,
  timeoutMs: 1000,
});

const ok = () =>
  new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('sendMessages', () => {
  test('posts each message to sendMessage with HTML parse mode', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    const sent = await sendMessages(['satu', 'dua'], config(fetchImpl));

    expect(sent).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.telegram.org/botSECRET-TOKEN/sendMessage');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      chat_id: '12345',
      text: 'satu',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  test('sends nothing and calls nothing for an empty list', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    expect(await sendMessages([], config(fetchImpl))).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('throws on a Telegram-level failure so the watermark cannot advance', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request: can’t parse entities' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/parse entities/);
  });

  test('never puts the bot token in the error it throws', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toSatisfy(
      (error: Error) => !error.message.includes('SECRET-TOKEN'),
    );
  });

  test('honours retry_after once on a 429, then gives up', async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(Date.now());
      return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/Too Many Requests/);
    // One original attempt plus exactly one retry.
    expect(calls).toHaveLength(2);
  });

  test('stops at the first failure rather than sending the rest out of order', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) return new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 });
      return ok();
    }) as unknown as typeof fetch;

    await expect(sendMessages(['a', 'b', 'c'], config(fetchImpl))).rejects.toThrow(/boom/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/telegram.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notify/telegram"`.

- [ ] **Step 3: Write the implementation**

> **The reference code below shipped with two Critical defects, both found in review and both since fixed in `dashboard/src/lib/notify/telegram.ts`. Read the shipped file, not this block, if you are re-deriving this module.**
>
> **One.** `postOnce` never caught a *rejecting* `fetchImpl`. The request URL embeds the bot token, so a wrapper that puts the URL in its own error message — `node-fetch`'s `FetchError` does — carried the token straight out. Task 6 puts `error.message` into a 503 response body, so that was one hop from a live HTTP response. Node 20's Undici happens not to embed the URL, so nothing leaked in practice, but the guarantee has to live in this module rather than in whichever `fetch` is injected. The fix wraps the call and re-throws using only `error.name`.
>
> **Two, worse.** `readBody` returned `{}` when the body would not parse, so `body.ok` was `undefined`, `undefined !== false` was `true`, and an unparseable 2xx counted as delivered. A gateway answering 200 with an HTML error page would have made the caller advance its watermark having sent nothing — the exact silent loss this whole design exists to prevent. The fix replaces the shape with a three-state discriminated union (`{parsed: true, ok: true}` / `{parsed: true, ok: false, …}` / `{parsed: false}`), and only the first counts as success.

Create `dashboard/src/lib/notify/telegram.ts`:

```ts
/**
 * The Bot API, over `fetch`.
 *
 * `fetchImpl` is injectable so the tests never touch the network. The default
 * is the platform `fetch`, which on Vercel is Undici.
 *
 * The whole contract is: either every message went out, or this throws. The
 * caller advances the watermark only on success, so a half-sent digest is
 * re-sent in full next run. Duplicates are recoverable by a human reading them
 * twice; a silently dropped price change is not.
 */

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

type TelegramResponse = {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
};

async function readBody(response: Response): Promise<TelegramResponse> {
  try {
    return (await response.json()) as TelegramResponse;
  } catch {
    // Telegram answers JSON, but a proxy or a gateway error may not.
    return {};
  }
}

async function postOnce(
  message: string,
  config: TelegramConfig,
): Promise<{ ok: true } | { ok: false; description: string; retryAfter: number | null }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // A hung request would hold the surrounding transaction open, and that
  // transaction holds the watermark row's lock. Bound it.
  const signal = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: 'HTML',
        // The links point at a login-protected dashboard, so a preview would be
        // a screenshot of the login page under every message.
        disable_web_page_preview: true,
      }),
      signal,
    },
  );

  const body = await readBody(response);
  if (response.ok && body.ok !== false) return { ok: true };

  return {
    ok: false,
    description: body.description ?? `HTTP ${response.status}`,
    retryAfter: body.parameters?.retry_after ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send every message in order.
 *
 * @returns how many were delivered.
 * @throws if any message fails, after one retry for a rate limit. The error
 *   text carries Telegram's own description and never the bot token — errors in
 *   this project have a habit of ending up persisted.
 */
export async function sendMessages(messages: string[], config: TelegramConfig): Promise<number> {
  let sent = 0;

  for (const message of messages) {
    let attempt = await postOnce(message, config);

    if (!attempt.ok && attempt.retryAfter !== null) {
      await sleep(attempt.retryAfter * 1000);
      attempt = await postOnce(message, config);
    }

    if (!attempt.ok) {
      throw new Error(
        `Telegram rejected message ${sent + 1} of ${messages.length}: ${attempt.description}`,
      );
    }

    sent += 1;
  }

  return sent;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/telegram.test.ts
npx tsc --noEmit
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/notify/telegram.ts dashboard/src/lib/notify/telegram.test.ts
git commit -m "Send the digest, or fail loudly enough to stop the watermark

Either every message went out or this throws, because the caller advances
the watermark only on success. A half-sent digest is re-sent in full next
run: a human reading a duplicate recovers, a silently dropped price change
does not.

The bot token never reaches the thrown error. Errors in this project have a
habit of being persisted — scrape_runs.error is why Settings.database_url
carries repr=False."
```

---

### Task 6: Settings, the run, and the route

**Files:**
- Create: `dashboard/src/lib/notify/run.ts`
- Create: `dashboard/src/app/api/notify/route.ts`
- Test: `dashboard/src/lib/notify/run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces:
  - `type NotifySettings = { botToken: string; chatId: string; secret: string; baseUrl: string; minGapHours: number; staleHours: number }`
  - `resolveSettings(env: NodeJS.ProcessEnv): NotifySettings` — throws naming the missing variable
  - `type NotifyOutcome = { sent: number; priceChanges: number; newStores: number; newProducts: number; stale: boolean }`
  - `runNotify(options: { settings: NotifySettings; now: Date; fetchImpl?: typeof fetch }): Promise<NotifyOutcome>`
  - `secretMatches(supplied: string | null, expected: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/notify/run.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';
import { resolveSettings, runNotify, secretMatches } from '@/lib/notify/run';

/**
 * The run, end to end against a real database with a fake Telegram.
 *
 * The cases that matter are the transactional ones: a send that fails must
 * leave the watermark where it was, and a second run after a successful one
 * must find nothing.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');
const HOUR = 3600 * 1000;
const BASE = new Date('2026-08-01T00:00:00Z');
const NOW = new Date(BASE.getTime() + 48 * HOUR);

const SETTINGS = {
  botToken: 'T',
  chatId: 'C',
  secret: 'S',
  baseUrl: 'https://dash.example',
  minGapHours: 12,
  staleHours: 36,
};

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

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

async function seedPriceChange(): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, first_seen, last_seen)
    VALUES (1, 'shopee', 222, 1, 'LEGO Technic 42218', '42218', ${BASE}, ${BASE})`;
  await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 186850, ${BASE})`;
  await sql`
    INSERT INTO price_snapshots (product_ref, price, scraped_at)
    VALUES (1, 211850, ${new Date(BASE.getTime() + 24 * HOUR)})`;
  // The store is already known, so this run is about the price, not the shop.
  await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1 WHERE id = 1`;
}

describe('resolveSettings', () => {
  test('reads every variable and applies the documented defaults', () => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://dash.example',
    } as NodeJS.ProcessEnv);

    expect(settings.minGapHours).toBe(12);
    expect(settings.staleHours).toBe(36);
    expect(settings.baseUrl).toBe('https://dash.example');
  });

  test('names the variable that is missing rather than failing vaguely', () => {
    expect(() =>
      resolveSettings({ TELEGRAM_CHAT_ID: 'chat', NOTIFY_SECRET: 'secret' } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  test('rejects a blank secret rather than accepting every caller', () => {
    expect(() =>
      resolveSettings({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: 'chat',
        NOTIFY_SECRET: '   ',
        NOTIFY_BASE_URL: 'https://x',
      } as NodeJS.ProcessEnv),
    ).toThrow(/NOTIFY_SECRET/);
  });

  test('falls back to a non-negative gap when the override is nonsense', () => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
      NOTIFY_MIN_GAP_HOURS: 'banyak',
    } as NodeJS.ProcessEnv);

    expect(settings.minGapHours).toBe(12);
  });
});

describe('secretMatches', () => {
  test('accepts the exact secret', () => {
    expect(secretMatches('hunter2', 'hunter2')).toBe(true);
  });

  test('rejects a wrong secret, a missing one, and one of a different length', () => {
    expect(secretMatches('nope', 'hunter2')).toBe(false);
    expect(secretMatches(null, 'hunter2')).toBe(false);
    expect(secretMatches('hunter2extra', 'hunter2')).toBe(false);
  });
});

describe('runNotify', () => {
  test('sends the digest and advances past everything it looked at', async () => {
    await seedPriceChange();
    const fetchImpl = okFetch();

    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome).toMatchObject({ priceChanges: 1, newStores: 0, newProducts: 0, stale: false });
    expect(outcome.sent).toBe(1);

    const [row] = await sql`SELECT last_snapshot_id FROM notify_watermark WHERE id = 1`;
    expect(String(row.last_snapshot_id)).toBe('2');
  });

  test('finds nothing on an immediate second run', async () => {
    await seedPriceChange();
    await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });

    const second = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });
    expect(second).toMatchObject({ sent: 0, priceChanges: 0 });
  });

  test('sends nothing when nothing changed', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${NOW}, ${NOW})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${NOW}, ${NOW})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${NOW})`;
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1, last_snapshot_id = 1 WHERE id = 1`;

    const fetchImpl = okFetch();
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome.sent).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('leaves the watermark alone when Telegram refuses', async () => {
    await seedPriceChange();
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(runNotify({ settings: SETTINGS, now: NOW, fetchImpl: failing })).rejects.toThrow(/boom/);

    const [row] = await sql`SELECT last_snapshot_id FROM notify_watermark WHERE id = 1`;
    expect(String(row.last_snapshot_id)).toBe('0');
  });

  test('re-sends the same events after a failure', async () => {
    await seedPriceChange();
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(runNotify({ settings: SETTINGS, now: NOW, fetchImpl: failing })).rejects.toThrow();

    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });
    expect(outcome.priceChanges).toBe(1);
  });

  test('warns instead of staying silent when the data has stopped moving', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${BASE}, ${BASE})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${BASE})`;
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1, last_snapshot_id = 1 WHERE id = 1`;

    const fetchImpl = okFetch();
    // NOW is 48h after the only snapshot; the threshold is 36h.
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome.stale).toBe(true);
    expect(outcome.sent).toBe(1);

    const body = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toContain('Data tidak bergerak');
  });

  test('does not repeat the staleness warning within a day', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${BASE}, ${BASE})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${BASE})`;
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1, last_snapshot_id = 1 WHERE id = 1`;

    await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });

    const second = okFetch();
    const outcome = await runNotify({
      settings: SETTINGS,
      now: new Date(NOW.getTime() + 2 * HOUR),
      fetchImpl: second,
    });

    expect(outcome.stale).toBe(true);
    expect(outcome.sent).toBe(0);
    expect(second).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/run.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notify/run"`.

> **The reference code below types `resolveSettings` against `NodeJS.ProcessEnv`, which does not compile. Read the shipped `dashboard/src/lib/notify/run.ts` instead.**
>
> Next 16's `global.d.ts` declares `NODE_ENV` as a **required** field on `NodeJS.ProcessEnv`, so the object literals the tests cast to it are `TS2352`. The spec already said this function "mirrors `resolveConnectionString` in `db.ts`" — and that one takes a narrow local `Env` type precisely so it is callable with a literal. The plan mirrored the idea and missed the detail that made it work.
>
> The shipped version declares a narrow `NotifyEnv` with all-optional fields, and types `required()`'s name parameter as `keyof NotifyEnv`, which turns a mistyped variable name into a compile error rather than a runtime throw.
>
> One consequence is not obvious and was verified rather than assumed: `resolveSettings(process.env)` does **not** compile against that narrow type either. TypeScript's weak-type check fires when every field is optional, and it compares only the properties *declared* on `ProcessEnv`, ignoring its index signature. `db.ts`'s `Env` escapes this by coincidence — it happens to declare `NODE_ENV`, the one property Next adds directly. The shipped code uses a single scoped `process.env as NotifyEnv` cast at the one call site. The two alternatives were tested in an isolated `tsc` repro and are worse: an index signature widens `keyof` to `string` and silently destroys the typo protection, and a `NODE_ENV?: string` field is dead weight that re-couples the type to a Next-version coincidence.

- [ ] **Step 3: Write the run module**

Create `dashboard/src/lib/notify/run.ts`:

```ts
import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { sql } from '@/lib/db';
import { collectEvents, hasAny, latestScrapedAt } from '@/lib/notify/events';
import { renderDigest, renderStaleWarning } from '@/lib/notify/format';
import { resolveBaseUrl } from '@/lib/notify/links';
import { sendMessages } from '@/lib/notify/telegram';
import {
  advanceWatermark,
  readCeilings,
  readWatermarkForUpdate,
  stampStaleWarning,
} from '@/lib/notify/watermark';

/**
 * One notification run, and the settings it needs.
 *
 * `resolveSettings` mirrors `resolveConnectionString` in `db.ts`: it takes the
 * environment as an argument rather than reading it, so it is testable, and it
 * refuses to start rather than degrading — a notifier missing its chat id
 * should say so once, not send successfully into nowhere.
 */

export type NotifySettings = {
  botToken: string;
  chatId: string;
  secret: string;
  baseUrl: string;
  minGapHours: number;
  staleHours: number;
};

const DEFAULT_MIN_GAP_HOURS = 12;
const DEFAULT_STALE_HOURS = 36;
const STALE_WARNING_COOLDOWN_HOURS = 24;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. The notifier cannot run without it.`);
  }
  return value;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  // Covers undefined, '', 'banyak' and negatives in one condition.
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveSettings(env: NodeJS.ProcessEnv): NotifySettings {
  return {
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    chatId: required(env, 'TELEGRAM_CHAT_ID'),
    secret: required(env, 'NOTIFY_SECRET'),
    baseUrl: resolveBaseUrl({
      NOTIFY_BASE_URL: env.NOTIFY_BASE_URL,
      VERCEL_PROJECT_PRODUCTION_URL: env.VERCEL_PROJECT_PRODUCTION_URL,
    }),
    minGapHours: positiveNumber(env.NOTIFY_MIN_GAP_HOURS, DEFAULT_MIN_GAP_HOURS),
    staleHours: positiveNumber(env.NOTIFY_STALE_HOURS, DEFAULT_STALE_HOURS),
  };
}

/**
 * Compare a bearer token without leaking its length or contents through timing.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees 32 bytes: it
 * throws on a length mismatch, and that throw is itself an oracle for the
 * secret's length.
 */
export function secretMatches(supplied: string | null | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export type NotifyOutcome = {
  sent: number;
  priceChanges: number;
  newStores: number;
  newProducts: number;
  stale: boolean;
};

/**
 * Read, send, advance — in one transaction.
 *
 * The transaction spans the Telegram call, which the scraper's own doctrine
 * warns against (`runner.py:976`). The difference is duration: that warning is
 * about a fetch measured in minutes, this is one POST bounded by a 10-second
 * abort. Holding it is what makes the `FOR UPDATE` on the watermark row mean
 * anything — release it before sending and two concurrent triggers both send.
 *
 * The order is deliberate: send first, advance second. A crash between them
 * re-sends next run; the reverse would lose the digest silently.
 */
export async function runNotify(options: {
  settings: NotifySettings;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<NotifyOutcome> {
  const { settings, now, fetchImpl } = options;

  return sql.begin(async (tx) => {
    const watermark = await readWatermarkForUpdate(tx);
    const ceilings = await readCeilings(tx);
    const events = await collectEvents(tx, watermark, ceilings, settings.minGapHours);

    const counts = {
      priceChanges: events.priceChanges.length,
      newStores: events.newStores.length,
      newProducts: events.newProducts.length,
    };

    if (hasAny(events)) {
      const messages = renderDigest(events, { baseUrl: settings.baseUrl, now });
      const sent = await sendMessages(messages, {
        botToken: settings.botToken,
        chatId: settings.chatId,
        fetchImpl,
      });
      await advanceWatermark(tx, ceilings);
      return { sent, ...counts, stale: false };
    }

    // Nothing happened. Before accepting that as the answer, check whether this
    // database is being written to at all.
    const latest = await latestScrapedAt(tx);
    const ageHours = latest === null ? Infinity : (now.getTime() - latest.getTime()) / 3_600_000;

    if (ageHours < settings.staleHours) {
      // Genuinely quiet. Advance anyway so the rows examined this run are not
      // re-examined next run.
      await advanceWatermark(tx, ceilings);
      return { sent: 0, ...counts, stale: false };
    }

    const warnedAgoHours =
      watermark.lastStaleWarningAt === null
        ? Infinity
        : (now.getTime() - watermark.lastStaleWarningAt.getTime()) / 3_600_000;

    if (warnedAgoHours < STALE_WARNING_COOLDOWN_HOURS) {
      // Already warned recently. A database frozen for a fortnight must not
      // become the source of its own spam.
      return { sent: 0, ...counts, stale: true };
    }

    const sent = await sendMessages([renderStaleWarning({ latest, hours: ageHours })], {
      botToken: settings.botToken,
      chatId: settings.chatId,
      fetchImpl,
    });
    await stampStaleWarning(tx, now);
    // The watermark deliberately does not move: there was nothing to report,
    // and moving it would hide the gap if the database starts moving again.
    return { sent, ...counts, stale: true };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/notify/run.test.ts
npx tsc --noEmit
```

Expected: 13 tests pass.

- [ ] **Step 5: Write the route handler**

Create `dashboard/src/app/api/notify/route.ts`:

```ts
import type { NextRequest } from 'next/server';

import { resolveSettings, runNotify, secretMatches } from '@/lib/notify/run';

/**
 * The notifier's trigger.
 *
 * Machine-to-machine, so it is the one route here that is **not** wrapped in
 * `withSession`: the caller is the scraping laptop's cron, which has no browser
 * cookie. Its own guard is a bearer token, and the absence of `withSession` on
 * this export is deliberate rather than forgotten — see `lib/api-session.ts` for
 * why the wrapper is normally the rule.
 *
 * `POST` only. This advances the watermark, and a GET that mutates is a GET
 * that a link prefetcher eventually fires.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(request: NextRequest): Promise<Response> {
  let settings;
  try {
    settings = resolveSettings(process.env);
  } catch (error) {
    // Misconfiguration, not a bad request. The message names the missing
    // variable and nothing else — no values are echoed.
    return Response.json(
      { error: error instanceof Error ? error.message : 'Notifier is not configured.' },
      { status: 500, headers: NO_STORE },
    );
  }

  const header = request.headers.get('authorization');
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!secretMatches(supplied, settings.secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  try {
    const outcome = await runNotify({ settings, now: new Date() });
    // Counts only. The caller is a cron job with a shell log, not a screen —
    // and product names in a log are one more place for them to leak.
    return Response.json(outcome, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      {
        error: 'Notification run failed.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: NO_STORE },
    );
  }
}
```

- [ ] **Step 6: Verify the route builds and rejects an unauthenticated call**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/notify/run.ts dashboard/src/lib/notify/run.test.ts dashboard/src/app/api/notify/route.ts
git commit -m "Tie the run together behind a bearer token

Read, send, advance, in one transaction. It spans the Telegram call, which
the scraper's own doctrine warns against — but that warning is about a fetch
measured in minutes and this is one POST bounded by a 10-second abort.
Holding it is what gives the FOR UPDATE on the watermark row any meaning:
release it before sending and two concurrent triggers both send.

Send before advance, so a crash between them re-sends rather than loses.

The route is the one handler here not wrapped in withSession, because its
caller is a cron job with no cookie. Bearer token compared over SHA-256
digests so timingSafeEqual never throws on length and never becomes an
oracle for it."
```

---

### Task 7: Keep the deep link through the login

**Files:**
- Create: `dashboard/src/lib/next-path.ts`
- Create: `dashboard/src/lib/next-path.test.ts`
- Create: `dashboard/src/proxy.ts`
- Modify: `dashboard/src/app/(app)/layout.tsx:18`
- Modify: `dashboard/src/app/login/page.tsx:23-31`
- Modify: `dashboard/src/app/actions/auth.ts:28`
- Modify: `dashboard/src/components/LoginForm.tsx`

**Interfaces:**
- Produces:
  - `PATH_HEADER = 'x-ecom-path'`
  - `safeNextPath(raw: string | string[] | null | undefined): string` — returns a same-site path, or `/`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/next-path.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { safeNextPath } from '@/lib/next-path';

/**
 * Where the login is allowed to send you afterwards.
 *
 * This value arrives from a URL, so it is attacker-controlled in the only sense
 * that matters: a link in a message. Anything that can leave this origin is an
 * open redirect wearing a convenience feature's clothes.
 */

describe('safeNextPath', () => {
  test('keeps an ordinary in-app path', () => {
    expect(safeNextPath('/pricing/3')).toBe('/pricing/3');
  });

  test('keeps the query string, which is where the channel lives', () => {
    expect(safeNextPath('/pricing?kanal=shopee&q=42218')).toBe('/pricing?kanal=shopee&q=42218');
  });

  test('refuses a protocol-relative path', () => {
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
  });

  test('refuses an absolute URL', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('http://evil.example')).toBe('/');
  });

  test('refuses anything that does not start at the root', () => {
    expect(safeNextPath('pricing/3')).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });

  test('refuses the login page itself, which would be a loop', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?changed=1')).toBe('/');
  });

  test('takes the first value when the parameter is repeated', () => {
    expect(safeNextPath(['/pricing/3', '//evil.example'])).toBe('/pricing/3');
  });

  test('refuses a value that decodes into an escape', () => {
    expect(safeNextPath('/%2f%2fevil.example')).toBe('/');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/next-path.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/next-path"`.

- [ ] **Step 3: Write the validator**

Create `dashboard/src/lib/next-path.ts`:

```ts
/**
 * Where the login may send you afterwards.
 *
 * A notification is clicked from a phone, and a phone is where the seven-day
 * session cookie is most likely to have expired. Without this the click lands
 * on `/login` and then on `/`, and the link that named a specific listing is
 * gone.
 *
 * The value comes from a URL, so it is only ever a same-origin path. The two
 * shapes that look relative and are not — `//host` and `/\host`, both of which
 * browsers resolve as protocol-relative — are the whole reason this is a
 * function rather than a `startsWith('/')`.
 *
 * Neither `server-only` nor any import: the client form reads it too.
 */

/** Where `proxy.ts` publishes the requested path for the layout to read. */
export const PATH_HEADER = 'x-ecom-path';

export function safeNextPath(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value === '') return '/';

  // Percent-encoding can hide a second slash from a naive prefix check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed escape is not a path anyone meant to visit.
    return '/';
  }

  // Backslashes are normalised to slashes by browsers, so check both forms.
  const normalised = decoded.replace(/\\/g, '/');

  if (!normalised.startsWith('/')) return '/';
  if (normalised.startsWith('//')) return '/';
  // Sending someone back to the login they just cleared is a loop.
  if (normalised === '/login' || normalised.startsWith('/login?')) return '/';

  return normalised;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test -- src/lib/next-path.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Publish the request path**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` first — the matcher syntax and the header-rewriting form are both specified there.

Create `dashboard/src/proxy.ts`:

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { PATH_HEADER } from '@/lib/next-path';

/**
 * Publishes the requested path as a request header.
 *
 * App Router layouts do not receive a pathname, and `(app)/layout.tsx` is where
 * the redirect to `/login` happens — so without this the layout cannot say
 * where the visitor was trying to go.
 *
 * Note what this deliberately does **not** do: any session check.
 * `lib/api-session.ts` explains why the login is verified per-route rather than
 * in middleware — verifying the cookie means an HMAC against a secret held in
 * Postgres, and putting that in front of every request means a database round
 * trip for every static asset too. This sets one header from data already in
 * the request. No crypto, no database, no await.
 *
 * Middleware is called Proxy as of Next.js 16; the file name and the export
 * follow that.
 */

export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next's own assets and the notifier's trigger. The trigger
  // is machine-to-machine and has no use for a path header.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/notify).*)'],
};
```

- [ ] **Step 6: Capture the path when the layout redirects**

In `dashboard/src/app/(app)/layout.tsx`, replace the import block's first line and the guard:

```ts
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/AppShell';
import { signOut } from '@/app/actions/auth';
import { currentUsername, isSignedIn, usingDefaultPassword } from '@/lib/auth';
import { PATH_HEADER, safeNextPath } from '@/lib/next-path';
import { getOwnShops } from '@/lib/queries';
```

and replace line 18 (`if (!(await isSignedIn())) redirect('/login');`) with:

```ts
  if (!(await isSignedIn())) {
    // Where they were going, so the login can put them back there. Clicking a
    // notification on a phone with an expired cookie is exactly the case this
    // exists for.
    const attempted = safeNextPath((await headers()).get(PATH_HEADER));
    redirect(attempted === '/' ? '/login' : `/login?next=${encodeURIComponent(attempted)}`);
  }
```

- [ ] **Step 7: Carry it through the login form**

In `dashboard/src/app/login/page.tsx`, replace the body of `LoginPage` after `const params = await searchParams;`:

```ts
  const params = await searchParams;
  const changed = params.changed !== undefined;
  const next = safeNextPath(params.next);
```

add the import:

```ts
import { safeNextPath } from '@/lib/next-path';
```

and pass it to the form, replacing `<LoginForm />`:

```tsx
        <LoginForm next={next} />
```

In `dashboard/src/components/LoginForm.tsx`, accept the prop and carry it as a hidden field. Add to the component's props and render inside the `<form>`:

```tsx
export function LoginForm({ next }: { next?: string }) {
```

```tsx
      {/* Round-trips the destination through the POST, so the action can send
          the visitor where the notification pointed rather than to the
          overview. Re-validated on the server — a hidden field is a suggestion,
          not a guarantee. */}
      <input type="hidden" name="next" value={next ?? '/'} />
```

In `dashboard/src/app/actions/auth.ts`, add the import and replace `redirect('/')` inside `signIn`:

```ts
import { safeNextPath } from '@/lib/next-path';
```

```ts
  await createSession();
  // Validated again here: the hidden field travelled through the browser, so it
  // is input, not state.
  redirect(safeNextPath(String(formData.get('next') ?? '/')));
```

- [ ] **Step 8: Verify by hand**

```bash
cd /Users/calvin/ecom-scraper/dashboard
npm run test
npx tsc --noEmit
npm run lint
npm run dev
```

In a browser with no session cookie (a private window), open `http://localhost:3000/pricing?kanal=shopee&q=42218`.

Expected: redirected to `/login?next=%2Fpricing%3Fkanal%3Dshopee%26q%3D42218`, and after signing in you land on `/pricing?kanal=shopee&q=42218` rather than `/`.

Then open `http://localhost:3000/login?next=//evil.example` and sign in.

Expected: you land on `/`, not on another host.

- [ ] **Step 9: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/next-path.ts dashboard/src/lib/next-path.test.ts dashboard/src/proxy.ts "dashboard/src/app/(app)/layout.tsx" dashboard/src/app/login/page.tsx dashboard/src/app/actions/auth.ts dashboard/src/components/LoginForm.tsx
git commit -m "Stop the login throwing away where you were going

A notification is clicked from a phone, which is where the seven-day cookie
is most likely to have lapsed — so the case this fixes is the common one,
not the edge one. Previously the click landed on /login and then on /, and
the link that named a specific listing was gone.

App Router layouts do not receive a pathname, so proxy.ts publishes it as a
header. It does no session check: api-session.ts explains why the cookie is
verified per-route instead, and this sets one header from data already in
the request.

next= is validated twice, on the way in and on the way back out, because a
hidden form field is input rather than state. //host and /\\host are both
rejected: browsers resolve both as protocol-relative, which is an open
redirect wearing a convenience feature's clothes."
```

---

### Task 8: Document it and wire up the trigger

**Files:**
- Modify: `dashboard/.env.example`
- Modify: `README.md` (after section 7)
- Create: `scripts/notify.sh`

**Interfaces:**
- Consumes: `POST /api/notify` from Task 6.
- Produces: nothing importable.

- [ ] **Step 1: Document the variables**

Append to `dashboard/.env.example`:

```bash
# --- Telegram notifications -------------------------------------------------
# The notifier reads this database, finds what changed since its watermark, and
# posts a digest. It is triggered by the scraping machine after a run — see
# scripts/notify.sh — not by a Vercel cron, because Hobby crons are capped at
# once per day and a deployment fails outright on a more frequent expression.
#
# From @BotFather. Full control of the bot; treat it like a password.
TELEGRAM_BOT_TOKEN=
# The chat that receives the digest. From @userinfobot, or the group's id.
TELEGRAM_CHAT_ID=
# Shared secret the trigger presents as `Authorization: Bearer <secret>`.
# The same value goes in the repo root .env, which is what scripts/notify.sh
# reads. Without it set here the route refuses every request.
NOTIFY_SECRET=

# Base URL for links inside the messages. Defaults to the deployment's own
# production domain, which is almost always what you want. Set it only to point
# links at a custom domain the deployment does not know about.
# NOTIFY_BASE_URL=https://your-domain.example

# How old the comparison snapshot must be before a price difference counts as a
# price change. Captures minutes apart disagree about price without anything
# having been repriced — 37 of 38 pairs 1.5-3.5 hours apart differ, against 3 of
# 1,335 a day apart — so comparing against the immediately preceding snapshot
# reports mostly artefacts. Set 0 to compare against whatever came before.
# NOTIFY_MIN_GAP_HOURS=12

# If the newest snapshot here is older than this, the notifier warns instead of
# staying silent. Silence is the right answer to "nothing changed" and the
# symptom of "nothing is being written to this database", and this is what tells
# them apart. Warns at most once a day.
# NOTIFY_STALE_HOURS=36
```

- [ ] **Step 2: Write the trigger script**

Create `scripts/notify.sh`:

```bash
#!/bin/bash
#
# Ask the deployed notifier to check what changed and post it to Telegram.
#
# Run this after a scrape. The notifier itself lives in the Vercel deployment —
# that is where a dashboard link resolves to a host a phone can open — but the
# trigger has to come from here, because Vercel's Hobby plan caps cron jobs at
# once per day and rejects a more frequent expression at deploy time.
#
# Reads NOTIFY_URL and NOTIFY_SECRET from the repo root .env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT/.env" ]; then
    echo "no .env at $ROOT — NOTIFY_URL and NOTIFY_SECRET have nowhere to come from" >&2
    exit 2
fi

# Only the two keys this needs, so a malformed line elsewhere in .env cannot be
# executed by a blanket `source`.
NOTIFY_URL="$(grep -E '^NOTIFY_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
NOTIFY_SECRET="$(grep -E '^NOTIFY_SECRET=' "$ROOT/.env" | head -1 | cut -d= -f2-)"

if [ -z "${NOTIFY_URL:-}" ] || [ -z "${NOTIFY_SECRET:-}" ]; then
    echo "NOTIFY_URL or NOTIFY_SECRET missing from $ROOT/.env" >&2
    exit 2
fi

# --fail so a 401 or 503 is a non-zero exit rather than a body printed as if it
# were success. No -v, ever: the Authorization header is on this request.
curl -fsS -X POST \
     -H "Authorization: Bearer ${NOTIFY_SECRET}" \
     -H 'content-type: application/json' \
     "${NOTIFY_URL%/}/api/notify"
echo
```

```bash
chmod +x /Users/calvin/ecom-scraper/scripts/notify.sh
```

- [ ] **Step 3: Document it in the README**

Insert after section 7 (before `## Exit codes`), as a new `## 8. Telegram notifications`:

```markdown
## 8. Telegram notifications

The dashboard tells you where you stand when you open it. This tells you when
something moved without you opening anything: a price change, a shop you have
never seen, or a new listing in a shop you already track.

It runs **in the deployment**, not in the scraper — a notification is read on a
phone, and a link to `127.0.0.1:3100` is not. The trigger comes from here,
because Vercel's Hobby plan caps cron jobs at once per day.

**1. A bot.** Message `@BotFather`, `/newbot`, keep the token. Message
`@userinfobot` to get your own chat id.

**2. Three variables on the deployment.**

```bash
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_CHAT_ID production
vercel env add NOTIFY_SECRET production   # anything long and random
```

**3. Two variables here,** in the repo root `.env`:

```bash
NOTIFY_URL=https://<your-deployment>
NOTIFY_SECRET=<the same value you gave Vercel>
```

**4. Trigger it after a scrape.**

```cron
0 6 * * * cd /path/to/ecom-scraper && .venv/bin/ecom-scraper run --mode store --pages 5 >> logs/store.log 2>&1
5 7 * * * cd /path/to/ecom-scraper && scripts/notify.sh >> logs/notify.log 2>&1
```

The first run after setup sends nothing: the watermark is seeded to what is
already in the database, because 12,000 listings you have had for weeks are not
news.

### What counts as a price change

A snapshot is compared against the newest one at least `NOTIFY_MIN_GAP_HOURS`
older (12 by default), not against whatever came immediately before it.

Captures taken hours apart disagree about price without anything having been
repriced. In this database, 37 of 38 snapshot pairs taken 1.5–3.5 hours apart
differ, against 3 of 1,335 pairs taken a day apart — and `sold` is byte-identical
across the near pairs, which no genuinely repriced listing would be. Comparing
against the immediate predecessor reports mostly artefacts.

Set `NOTIFY_MIN_GAP_HOURS=0` to turn the rule off and see the difference.

### If it goes quiet

Silence is correct when nothing changed. It is also what a notifier reading the
wrong database looks like. So if the newest snapshot it can see is older than
`NOTIFY_STALE_HOURS` (36), it says so instead — at most once a day.

The usual cause is step 5 of section 7: the ingest server still writing to the
laptop while the deployment reads Neon.
```

- [ ] **Step 4: Verify the script fails safely before it is configured**

```bash
cd /Users/calvin/ecom-scraper
scripts/notify.sh; echo "exit=$?"
```

Expected: exit `2` with a message naming what is missing. It must **not** print a secret, and must not exit `0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/.env.example scripts/notify.sh README.md
git commit -m "Document the notifier and give it something to pull the trigger

The trigger lives here because Vercel Hobby caps crons at once per day and
rejects a more frequent expression at deploy time — so the laptop that
already runs the scrape on cron pokes the deployment when it finishes.

notify.sh reads only the two keys it needs out of .env rather than sourcing
the file, and never passes -v to curl: the Authorization header is on that
request.

The README section explains the minimum-gap rule with the numbers that
justify it, because a threshold nobody can see the reason for is a threshold
someone eventually removes."
```

---

## Self-Review

**Spec coverage.** Each spec section maps to a task: the watermark table and its seeding (Task 1), the three queries with the store-watermark rule for new products (Task 2), the link table including the rival paths (Task 3), HTML format, folding and 4096-splitting (Task 4), the Bot API client with 429 handling (Task 5), settings, the transaction, the security guard and the staleness guard (Task 6), the `?next=` fix with its validation rules (Task 7), and the environment variables, trigger and documentation (Task 8). The spec's "Kasus tepi" table is covered by named tests except two: "Produk dengan `shop_ref` NULL" is handled by `isOwn: row.is_own ?? false` and the `shopLabel` fallback in Task 4, and "Dua pemicuan bersamaan" is enforced by `FOR UPDATE` in Task 1 but not tested — a two-connection race test is worth more than it costs only if the lock is ever suspected, and the lock is one line.

**Placeholders.** None. Every code step carries the code, every verification step carries the command and the expected output.

**Type consistency.** `Sql`, `Watermark` and `Ceilings` are defined in Task 1 and used unchanged in Tasks 2 and 6. `PriceChange`, `NewStore`, `NewProduct` and `Events` are defined in Task 2 and consumed by Tasks 3, 4 and 6 with the same field names. `resolveBaseUrl` is defined in Task 3 and called by `resolveSettings` in Task 6. `renderDigest` and `renderStaleWarning` are defined in Task 4 with the signatures Task 6 calls. `sendMessages` is defined in Task 5 with the `TelegramConfig` shape Task 6 passes. `PATH_HEADER` and `safeNextPath` are defined in Task 7 and used by the same task's proxy and layout.

**One deviation from the spec, recorded.** The spec's file list names `dashboard/vercel.json`; this plan does not touch it, because with no `crons` there is nothing to configure and Fluid Compute already defaults to 300s. The spec was amended to match.
