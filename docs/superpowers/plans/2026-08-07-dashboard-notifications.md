# Dashboard Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Telegram notifier with a `/notifications` page whose contents are a pure derivation of `price_snapshots`.

**Architecture:** No event table. One parameterised query (`rivalMoves`) returns rival price moves ≥5% on `set_code`s an `is_own` shop carries, comparing against the newest snapshot at least 24h older and at most `maxLookbackDays` old. A singleton `notify_seen.last_seen_snapshot_id` decides only which rows are *styled* new — it never filters. The page always renders a 14-day window.

**Tech Stack:** Next.js 16 App Router, React 19, postgres.js, Zod v4, vitest against a real Postgres, Python 3.11 + SQLAlchemy for the scraper side.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-dashboard-notifications-design.md`. Read it before Task 1.
- Money stays a **string** end to end (Postgres NUMERIC → string → format at render). Never `Number()` before display.
- Snapshot ids are **bigint**, carried as strings in TypeScript, compared by Postgres.
- The marker **never filters** the list. It only styles.
- The marker **only advances** — `GREATEST`, never a bare assignment.
- Migrations are idempotent and have **no ledger**; the whole directory re-runs on every `initdb` and every vitest `beforeAll`. Anything added must survive a second pass.
- `DROP TABLE notify_watermark` is **deferred to a future 007**. Do not drop it in this work.
- Dashboard tests: `cd dashboard && npm test` (vitest, `fileParallelism: false`, against `postgresql://calvin@127.0.0.1:5432/ecom_scraper_test`).
- Python tests: `cd /Users/calvin/ecom-scraper && .venv/bin/pytest`.
- Target database for the page: **Neon** (`NEON_DATABASE_URL`). Local Postgres remains the scraper's own.
- Accepted risks, recorded in the spec, not to be "fixed" en route: the Neon mirror is unscheduled, and the stale-data warning is deleted without replacement.

---

### Task 1: Stop both live Telegram triggers

Nothing may be deleted before this. There are **two** independent triggers; unloading only the agent yields intermittent delivery, not a clean stop.

**Files:**
- Modify: `.env` (blank `NOTIFY_URL`, `NOTIFY_SECRET`, `NEON_NOTIFY_URL`, `NEON_NOTIFY_SECRET`)

- [ ] **Step 1: Unload the launchd agent**

```bash
launchctl bootout gui/$(id -u)/com.ecomscraper.notify
```

- [ ] **Step 2: Verify it is gone**

Run: `launchctl list | grep ecomscraper`
Expected: `com.ecomscraper.notify` absent; `.dashboard` and `.ingest` still listed.

- [ ] **Step 3: Blank the four notify variables in `.env`**

Keep the keys, empty the values — `build_notify_trigger` returns `None` when either is falsy, which is the documented "no dashboard" path.

- [ ] **Step 4: Restart ingest so it re-reads `.env`**

```bash
launchctl kickstart -k gui/$(id -u)/com.ecomscraper.ingest
```

- [ ] **Step 5: Verify no trigger is armed**

Run: `grep -c "notify trigger armed" logs/ingest.log` after the restart timestamp.
Expected: no new occurrence.

- [ ] **Step 6: Commit**

```bash
git add .env.example && git commit -m "chore: stop the Telegram notify triggers"
```

> `.env` is gitignored; only `.env.example` is committed. Blank the same four keys there.

---

### Task 2: Migration 006 and the 005 tombstone

**Files:**
- Create: `migrations/006_notify_seen.sql`
- Modify: `migrations/005_notify_watermark.sql` (gut to comments)
- Test: `dashboard/src/lib/notify/seen.test.ts` (created in Task 4 — here only the migration-idempotency case in `tests/test_db.py`)

**Interfaces:**
- Produces: table `notify_seen (id integer PK CHECK (id = 1), last_seen_snapshot_id bigint NOT NULL, updated_at timestamptz)`.

- [ ] **Step 1: Write the failing test**

In `tests/test_db.py`:

```python
def test_migrations_are_idempotent_across_two_passes(tmp_database_url):
    """The directory has no ledger, so re-running is the recovery path."""
    from scraper.db import apply_migrations
    apply_migrations(tmp_database_url)
    apply_migrations(tmp_database_url)  # must not raise
    with create_engine(tmp_database_url).begin() as tx:
        assert tx.execute(text("SELECT count(*) FROM notify_seen")).scalar() == 1
```

- [ ] **Step 2: Run it and watch it fail**

Run: `.venv/bin/pytest tests/test_db.py -k idempotent -v`
Expected: FAIL — `relation "notify_seen" does not exist`.

- [ ] **Step 3: Write `migrations/006_notify_seen.sql`**

Order is load-bearing: create first, seed second, and the seed must be inside a `to_regclass` guard because a static reference to a missing relation fails at **parse** time — `COALESCE` never gets to run.

```sql
-- How far the reader has seen. One row, one id.
--
-- Ids, not timestamps: scraped_at arrives out of order in this database (see
-- the abs() in scraper/store.py insert_snapshot_if_changed), and a clock-based
-- marker would file a genuinely new row as already read.
--
-- This marker never filters the notifications list. It decides which rows are
-- styled new. Filtering on it is what made the first draft render an empty page
-- on day one — see the design doc.

CREATE TABLE IF NOT EXISTS notify_seen (
    id                     integer     PRIMARY KEY,
    last_seen_snapshot_id  bigint      NOT NULL DEFAULT 0,
    updated_at             timestamptz,
    CONSTRAINT ck_notify_seen_singleton CHECK (id = 1)
);

-- Seeded in three arms, in this order.
--
-- The to_regclass guard is required, not defensive: a plain
-- `SELECT ... FROM notify_watermark` in a database that never had it is a parse
-- error that aborts the whole file, and db.py sends each migration as one
-- exec_driver_sql. An untaken plpgsql branch is never planned, so this is safe.
--
-- Arm two matters on its own. Falling straight to 0 on a database 005 never
-- reached would announce the entire history as unread.
DO $$
DECLARE seed bigint;
BEGIN
    IF to_regclass('public.notify_watermark') IS NOT NULL THEN
        SELECT w.last_snapshot_id INTO seed FROM notify_watermark w WHERE w.id = 1;
    END IF;
    seed := COALESCE(seed, (SELECT max(id) FROM price_snapshots), 0);

    -- DO NOTHING, never DO UPDATE: a second pass must neither rewind the marker
    -- nor fast-forward it past rows the reader has not seen.
    INSERT INTO notify_seen (id, last_seen_snapshot_id, updated_at)
    VALUES (1, seed, now())
    ON CONFLICT (id) DO NOTHING;
END $$;
```

- [ ] **Step 4: Gut 005 to a tombstone in the same commit**

Leave the file (the directory is read in sorted order and its absence would confuse a reader) but remove every statement. Without this, each pass recreates `notify_watermark` and takes `ACCESS EXCLUSIVE` against Neon over the network.

```sql
-- Superseded by 006_notify_seen.sql on 2026-08-07.
--
-- This file created notify_watermark for the Telegram notifier, which no longer
-- exists. Its statements are removed rather than the file, because 006 seeds
-- from notify_watermark when it is present and this directory is re-run whole
-- on every initdb — leaving the CREATE here would resurrect the table after 006
-- had read it.
--
-- The table itself is dropped in a later migration, once the seed has been
-- confirmed correct on both databases.
```

- [ ] **Step 5: Run the test**

Run: `.venv/bin/pytest tests/test_db.py -k idempotent -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/006_notify_seen.sql migrations/005_notify_watermark.sql tests/test_db.py
git commit -m "feat: add notify_seen, tombstone the watermark migration"
```

---

### Task 3: `rivalMoves` — the one query

**Files:**
- Create: `dashboard/src/lib/notify/rival-moves.ts`
- Test: `dashboard/src/lib/notify/rival-moves.test.ts`

**Interfaces:**
- Consumes: `sql` from `@/lib/db`.
- Produces:

```ts
export type RivalMove = {
  snapshotId: string;      // bigint as string
  productId: number;
  name: string | null;
  setCode: string | null;
  marketplace: string;
  storeId: number | null;
  username: string | null;
  price: string;           // NUMERIC as string
  previousPrice: string;
  scrapedAt: Date;
  previousScrapedAt: Date;
  ourPrice: string | null;
  undercutsUs: boolean | null;   // null when we have no price for the set
};

export type RivalMovesOptions = {
  gapHours: number;        // 24
  threshold: number;       // 0.05
  windowDays: number;      // 14
  maxLookbackDays: number; // 7
  limit: number;
  offset: number;
};

export async function rivalMoves(opts: RivalMovesOptions): Promise<RivalMove[]>;
export async function rivalMovesCeiling(opts: Omit<RivalMovesOptions, 'limit' | 'offset'>): Promise<string | null>;
```

`rivalMovesCeiling` returns `max(snapshotId)` over the **complete** window — no limit, no offset. Task 7 advances the marker to exactly this. It exists as its own function so no caller can accidentally pass a capped result.

- [ ] **Step 1: Write the failing tests**

```ts
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

test('a later unchanged capture does not retract an earlier move', async () => {
  // The DISTINCT ON regression: without this the event set shrinks and the
  // id-based marker loses its footing.
  await seedRivalMove({ from: '100000', to: '50000', hoursApart: 48 });
  await seedUnchangedCapture({ price: '50000', hoursAfter: 1 });
  expect(await rivalMoves(DEFAULTS)).toHaveLength(1);
});

test('ceiling spans the whole window, not the page', async () => {
  await seedThreeRivalMoves();
  const page = await rivalMoves({ ...DEFAULTS, limit: 1 });
  const ceiling = await rivalMovesCeiling(DEFAULTS);
  expect(page).toHaveLength(1);
  expect(Number(ceiling)).toBeGreaterThan(Number(page[0].snapshotId));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd dashboard && npx vitest run src/lib/notify/rival-moves.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

No `DISTINCT ON`. One row per qualifying snapshot, so the event set only ever grows in id order.

```sql
WITH own_sets AS MATERIALIZED (
  SELECT DISTINCT p.set_code
    FROM products p JOIN stores s ON s.id = p.shop_ref
   WHERE s.is_own AND p.set_code IS NOT NULL
),
rival_listings AS MATERIALIZED (
  SELECT p.id, p.set_code, p.name, p.marketplace, p.shop_ref, s.username
    FROM products p
    JOIN own_sets o ON o.set_code = p.set_code
    JOIN stores s ON s.id = p.shop_ref
   WHERE NOT s.is_own
),
moves AS (
  SELECT ps.id, ps.product_ref, ps.price, ps.scraped_at,
         older.price AS previous_price, older.scraped_at AS previous_scraped_at
    FROM price_snapshots ps
    JOIN rival_listings r ON r.id = ps.product_ref
    CROSS JOIN LATERAL (
      SELECT o.price, o.scraped_at
        FROM price_snapshots o
       WHERE o.product_ref = ps.product_ref
         AND o.price IS NOT NULL
         AND o.price > 0
         AND o.scraped_at <= ps.scraped_at - make_interval(hours => ${gapHours})
         AND o.scraped_at >= ps.scraped_at - make_interval(days  => ${maxLookbackDays})
       ORDER BY o.scraped_at DESC
       LIMIT 1
    ) older
   WHERE ps.price IS NOT NULL
     AND ps.scraped_at > now() - make_interval(days => ${windowDays})
     AND abs(ps.price - older.price) / older.price >= ${threshold}
)
SELECT ... FROM moves m JOIN rival_listings r ON r.id = m.product_ref
  LEFT JOIN our_price ON our_price.set_code = r.set_code
 ORDER BY (m.price < our_price.price) DESC NULLS LAST,
          abs(m.price - m.previous_price) / m.previous_price DESC,
          m.id DESC
 LIMIT ${limit} OFFSET ${offset}
```

`o.price > 0` in the LATERAL, not a `nullif` afterwards: it removes the zero row from consideration instead of turning the division into a NULL that a later predicate has to remember to handle.

- [ ] **Step 4: Run the tests**

Run: `cd dashboard && npx vitest run src/lib/notify/rival-moves.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the plan against the real database**

```bash
psql postgresql://calvin@127.0.0.1:5432/ecom_scraper -c "EXPLAIN (ANALYZE, BUFFERS) <the query>"
```

Expected: the LATERAL served by `ix_price_snapshots_product_ref_scraped_at`. Record the timing in the commit message. The `DISTINCT ON` form measured 38ms/56 rows; this form returns more rows and must be re-measured, not assumed.

- [ ] **Step 6: Commit**

---

### Task 4: `seen.ts` — the marker

**Files:**
- Create: `dashboard/src/lib/notify/seen.ts`, `dashboard/src/lib/notify/seen.test.ts`

**Interfaces:**
- Produces: `readSeen(): Promise<string>`, `advanceSeen(to: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

```ts
test('advance is monotonic', async () => {
  await advanceSeen('500');
  await advanceSeen('300');
  expect(await readSeen()).toBe('500');
});

test('a marker above max(id) is clamped on read', async () => {
  // The state after a destructive mirror: sync TRUNCATEs and copies ids
  // verbatim, so the target's max(id) can fall below its own marker.
  await sql`UPDATE notify_seen SET last_seen_snapshot_id = 999999 WHERE id = 1`;
  expect(await readSeen()).toBe(String(await maxSnapshotId()));
});

test('a missing row is an error, not a silent zero', async () => {
  await sql`DELETE FROM notify_seen`;
  await expect(readSeen()).rejects.toThrow(/006_notify_seen/);
});
```

- [ ] **Step 2: Run and watch fail.** `npx vitest run src/lib/notify/seen.test.ts`

- [ ] **Step 3: Implement**

```ts
export async function advanceSeen(to: string): Promise<string> {
  // GREATEST, not assignment: two tabs posting at once, or a stale request
  // arriving late, must never move the marker backwards and re-mark rows unread.
  const [row] = await sql<{ last_seen_snapshot_id: string }[]>`
    UPDATE notify_seen
       SET last_seen_snapshot_id = GREATEST(last_seen_snapshot_id, ${to}::bigint),
           updated_at = now()
     WHERE id = 1
 RETURNING last_seen_snapshot_id`;
  if (!row) throw new Error('notify_seen has no row. Apply migrations/006_notify_seen.sql.');
  return String(row.last_seen_snapshot_id);
}
```

- [ ] **Step 4: Run tests.** Expected: PASS, 3 tests.
- [ ] **Step 5: Commit**

---

### Task 5: `group.ts` — port the folding

**Files:**
- Create: `dashboard/src/lib/notify/group.ts`, `dashboard/src/lib/notify/group.test.ts`

Port `foldPriceChanges`, `FOLD_MIN_GROUP` and the `magnitude` ordering from `format.ts:24,176-217`, retyped from `PriceChange` to `RivalMove`. Leave `MAX_ENTRIES_PER_GROUP`, `MAX_MESSAGES`, `escapeHtml` and every `render*` behind — they size Telegram messages, and there are none.

- [ ] **Step 1: Port the three surviving cases from `format.test.ts`** — fold threshold, a rise never folding into a fall of the same size, proportional ordering.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Port the implementation**, keeping the store-and-signed-delta key and the shared zero-price-guarded `magnitude`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit**

---

### Task 6: Trim `links.ts`

**Files:**
- Modify: `dashboard/src/lib/notify/links.ts`, `dashboard/src/lib/notify/links.test.ts`

Keep `priceChangeLink`, `searchableName`, `MAX_QUERY_NAME` — retyped to `RivalMove`, and drop the `isOwn` branch since every row is now a rival. Delete `resolveBaseUrl`, `absolute`, `newStoreLink`, `newProductLink`: all four exist to build absolute URLs for Telegram, and an in-app link is a path.

**The 180-character clamp is load-bearing and must keep its test.** `productFilterSchema.q` is `.max(200).catch(undefined)`, so a longer name silently discards the filter and lands the reader on the unfiltered list.

- [ ] **Step 1: Delete the four functions' tests, keep the clamp and fallback cases.**
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Retype and delete.**
- [ ] **Step 4: Run tests.**
- [ ] **Step 5: Commit**

---

### Task 7: `/api/notifications/seen`

**Files:**
- Create: `dashboard/src/app/api/notifications/seen/route.ts`

**Interfaces:**
- Consumes: `withSession` from `@/lib/api-session`, `advanceSeen` from `@/lib/notify/seen`, `rivalMovesCeiling` from `@/lib/notify/rival-moves`.

POST only. A GET that mutates would fire on prefetch and on React's double render.

The body carries no id. The route calls `rivalMovesCeiling` itself, so the client cannot supply a capped ceiling — that is the whole defect being designed out.

- [ ] **Step 1: Write the failing test** — a POST advances to the window ceiling, not to `max(price_snapshots.id)`, and a GET is 405.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement**

```ts
export const dynamic = 'force-dynamic';

export const POST = withSession(async () => {
  const ceiling = await rivalMovesCeiling(DEFAULT_WINDOW);
  if (ceiling === null) return Response.json({ lastSeenSnapshotId: await readSeen() });
  return Response.json({ lastSeenSnapshotId: await advanceSeen(ceiling) });
});
```

- [ ] **Step 4: Run tests.**
- [ ] **Step 5: Commit**

---

### Task 8: The page, the list, the bell

**Files:**
- Create: `dashboard/src/app/(app)/notifications/page.tsx`, `dashboard/src/components/NotificationsList.tsx`
- Modify: `dashboard/src/components/shell/AppShell.tsx`, `dashboard/src/app/(app)/layout.tsx`, `dashboard/src/lib/channel-links.test.ts`

- [ ] **Step 1: Add the new page to the `FILES` list in `channel-links.test.ts:65-74`** — it is hand-written, and omitting the page means the kanal-preservation guard silently stops covering the new screen. Watch this test fail first.
- [ ] **Step 2: Build the page.** `export const dynamic = 'force-dynamic'`. Two tabs, **Semua** default and **Baru** second, both from `rivalMoves` with the marker predicate as a parameter. Each row states its real comparison window — "−11% vs 5 hari lalu" — from `previousScrapedAt`.
- [ ] **Step 3: `NotificationsList.tsx`** is a client component that POSTs `/api/notifications/seen` **once after paint**, never during render.
- [ ] **Step 4: Bell + badge in `AppShell.tsx`**, with `prefetch={false}` so a viewport prefetch cannot clear the queue. `layout.tsx` passes the count in — and because that layout runs on every signed-in page, the count must be a bounded `count(*)`, not the feed.
- [ ] **Step 5: Run the whole suite.** `cd dashboard && npm test`
- [ ] **Step 6: Verify in the browser** — both tabs render, the badge clears after a visit and does not reappear on reload.
- [ ] **Step 7: Commit**

---

### Task 9: Apply 006 to both databases

Irreversible in effect: the seed is written once and `ON CONFLICT DO NOTHING` means a second run will not correct it.

- [ ] **Step 1: Apply to local.** `.venv/bin/ecom-scraper initdb`
- [ ] **Step 2: Verify the local seed by hand**

```bash
psql postgresql://calvin@127.0.0.1:5432/ecom_scraper -c "SELECT last_seen_snapshot_id FROM notify_seen"
```

Expected: **22154**. The highest qualifying event id is 22089, so **zero unread on local is the predicted result, not a bug** — it is precisely why the Semua tab must exist before this step is judged.

- [ ] **Step 3: Apply to Neon** and verify: expected **22076** against `max(id)` 26320.
- [ ] **Step 4: Load `/notifications` against Neon** and confirm the Semua tab is populated and Baru is not empty.
- [ ] **Step 5: Commit** (no code change; record the two seeds in the message).

---

### Task 10: Port `reseed_watermark` to `notify_seen`

Must land with Task 9, not after. The moment `notify_watermark` stops being the marker, `sync` silently stops managing it and prints a success message.

**Files:**
- Modify: `scraper/sync.py` (`reseed_watermark` → `reseed_seen`; `OWNED_BY_TARGET` at line 76), `scraper/cli.py:1520-1550`, `tests/test_sync.py:274-308`

- [ ] **Step 1: Repoint the existing test** at `notify_seen` and watch it fail.
- [ ] **Step 2: Port the function.** Same posture: after a mirror, what was copied is history, not news, so reseed to the target's new `max(id)`.
- [ ] **Step 3: Swap `notify_watermark` for `notify_seen` in `OWNED_BY_TARGET`.**
- [ ] **Step 4: Run.** `.venv/bin/pytest tests/test_sync.py -v`
- [ ] **Step 5: Commit**

---

### Task 11: Delete the dashboard notify tree

- [ ] **Step 1: Rehome the `Sql` type first.** It is exported from `watermark.ts:22` and imported by `positions.ts:3`. Move it to `dashboard/src/lib/db.ts` and repoint `positions.ts`. Deleting `watermark.ts` first stops `positions.ts` compiling.
- [ ] **Step 2: Verify.** `cd dashboard && npx tsc --noEmit`
- [ ] **Step 3: Delete** `notify/{telegram,run,watermark,events,format}.ts` and their five test files, and the whole `src/app/api/notify/` directory.
- [ ] **Step 4: Do NOT delete `src/lib/price-change.ts`.** It has two live non-notify importers (`queries.ts:9`, `products/page.tsx:9`) and removing it breaks the build. Rescue the `['empty', '']` `resolveMinGapHours` case from `run.test.ts:239` into `product-movement.test.ts` — `Number('')` is 0 and takes a different path from `'   '`.
- [ ] **Step 5: Fix the comments that are now false** — `db.ts:14-17` and `auth.ts:21-23` both claim the app writes exactly `app_credentials` and `notify_watermark`; `queries.ts:233-234,310-313,321-326` name `notify/events.ts` and Telegram; `proxy.ts` carries a dead `api/notify` negative lookahead that would otherwise stand as an unauthenticated carve-out for a future path.
- [ ] **Step 6: Run.** `npx tsc --noEmit && npm test && npm run build`
- [ ] **Step 7: Commit**

---

### Task 12: Delete the Python push path

Order matters — each step removes something the next one reads.

- [ ] **Step 1: Delete `scraper/notify_trigger.py` and `tests/test_notify_trigger.py`.**
- [ ] **Step 2: Remove the eight sites in `scraper/ingest.py`** (line 44 import; the `trigger`/`neon_trigger` parameters at 728-730 and their docstrings at 746-752; the `triggers` dict at 778-782; the lifespan loop at 787-794; `app.state.notify_trigger`/`notify_triggers` at 807-808; `_mark` at 845-857; the status dict at 894). A missed one is an `ImportError` at ingest-server boot.
- [ ] **Step 3: Remove the four notify fields from `scraper/config.py`.**
- [ ] **Step 4: Remove `scraper/cli.py:967-979`** — it reads `app.state.notify_triggers`, which Step 2 just stopped publishing.
- [ ] **Step 5: Delete `tests/test_ingest.py:261-363` entirely**, not case by case: the two `marks == 0` negatives keep passing while asserting nothing once the trigger is gone.
- [ ] **Step 6: Run.** `.venv/bin/pytest`
- [ ] **Step 7: Restart ingest and confirm it boots.** `launchctl kickstart -k gui/$(id -u)/com.ecomscraper.ingest && curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/health`
- [ ] **Step 8: Commit**

---

### Task 13: Delete the scripts, the agent, the logs, the variables

- [ ] **Step 1: Delete** `scripts/notify.sh`, `~/Library/LaunchAgents/com.ecomscraper.notify.plist`, `logs/notify.log`, `logs/notify.error.log`.
- [ ] **Step 2: Remove the dead keys** from `.env`, `.env.example`, `dashboard/.env.example`, `dashboard/.env.local`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NOTIFY_SECRET`, `NOTIFY_URL`, `NOTIFY_QUIET_SECONDS`, `NOTIFY_PER_PRODUCT_MAX`, `NOTIFY_STALE_HOURS`, `NEON_NOTIFY_URL`, `NEON_NOTIFY_SECRET`. Keep `NOTIFY_MIN_GAP_HOURS` — `price-change.ts` still reads it.
- [ ] **Step 3: Confirm nothing references them.** `grep -rn "TELEGRAM_\|NOTIFY_SECRET\|notify_watermark" --include="*.ts" --include="*.py" --include="*.sh" . | grep -v node_modules`
- [ ] **Step 4: Commit**

---

### Task 14: Documentation

- [ ] **Step 1: `README.md`** — delete the Telegram section, repoint the sync/watermark prose at `notify_seen`, and **preserve the min-gap prose at 717 and 747-756**: it explains the comparison rule, which survives.
- [ ] **Step 2: Add a "superseded by" header** to the four older `docs/superpowers` notify documents rather than deleting them.
- [ ] **Step 3: Commit**

---

### Task 15: Vercel — owner action

Not runnable from this session: the Vercel MCP is unauthorised here, and these are production changes to a live deployment.

- [ ] **Step 1: Owner revokes the bot token** via @BotFather `/revoke`. **Irreversible, and required** — deleting the variable does not deactivate the bot.
- [ ] **Step 2: Owner runs** `vercel env rm TELEGRAM_BOT_TOKEN production`, and the same for `TELEGRAM_CHAT_ID` and `NOTIFY_SECRET`. A file sweep never finds these; they live only in the Vercel project.
- [ ] **Step 3: Owner deploys.** Until then the deployed `/api/notify` keeps answering from the previously built bundle.

---

## Self-Review

**Spec coverage.** Every section maps: the marker-does-not-filter rule → Tasks 3, 7, 8; no `DISTINCT ON` → Task 3 Step 1's retraction test; the upper bound → Task 3's `maxLookbackDays` test; the guarded seed → Task 2; `sync` → Task 10; the two-database apply → Task 9; the 63-entry manifest → Tasks 11-14. The two accepted risks are constraints, not tasks, and are recorded as such.

**Placeholders.** None. Every code step carries its code; every command carries its expected output. Task 15 is deliberately not actionable here and says why.

**Type consistency.** `RivalMove` is defined once in Task 3 and consumed unchanged by Tasks 5, 6 and 8. `rivalMovesCeiling` is named identically in Tasks 3 and 7. `readSeen`/`advanceSeen` in Tasks 4 and 7.

**One gap, stated rather than hidden:** Task 3 Step 5 re-measures the query. Dropping `DISTINCT ON` returns more rows than the 38ms/56-row form that was benchmarked, so the recorded number does not carry over and must not be quoted as if it did.
