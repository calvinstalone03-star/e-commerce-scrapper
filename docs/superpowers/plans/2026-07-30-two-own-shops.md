# Two Own Shops (One Active Channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope every screen whose numbers are relative to us to one active marketplace channel, chosen in the URL, so the Shopee shop and the Tokopedia shop each get truthful figures instead of a merged pool that double-counts 1,174 sets.

**Architecture:** One pure resolver (`src/lib/channel.ts`) turns `?kanal=` plus the list of own shops into a channel. One SQL fragment factory (`ourListings(channel)`) is the only way a query can say "ours", so a screen cannot forget to scope. The trigram pairing runs once per channel in `computePairingSnapshot(channel)`, is cached for five minutes by a thin `getPairingSnapshot(channel)` wrapper, and feeds both the overview scorecard and the analytics page. Rivals stay cross-marketplace; only our side is scoped.

**Tech Stack:** Next.js 16.2.12 (App Router, Server Components, Turbopack), postgres.js against Neon/Postgres, Zod 4 for every boundary, Vitest against a real Postgres (`ecom_scraper_test`), Tailwind 4.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-two-own-shops-design.md`. Every decision there is binding.
- Query param name is exactly `kanal`; values are exactly `shopee` and `tokopedia` (`marketplaceSchema`).
- Rivals are never filtered by marketplace. Only our own listings are scoped.
- No screen may display a figure that sums the two channels.
- Default channel when `?kanal=` is absent, unknown, or names a shop that is no longer `is_own`: the own shop whose `marketplace` sorts first alphabetically (`shopee` before `tokopedia`). Never an error page.
- UI copy is Indonesian; code comments and commit messages are English. Match the surrounding files.
- Cached wrapper (`unstable_cache`) must stay separate from the SQL function so tests never need a Next request context.
- `dashboard/AGENTS.md`: read `node_modules/next/dist/docs/` before writing framework code. This is Next 16, not the Next in your training data.
- Run from `dashboard/`: `npx vitest run`, `npm run lint`, `npm run build`. Tests need local Postgres with database `ecom_scraper_test`.
- Commit per task on the current branch. Do not merge to `main` and do not deploy — Calvin does both himself.

## File Structure

**Create**
- `dashboard/src/lib/channel.ts` — pure channel resolution and link helper. No DB, no `server-only`: both server pages and the client shell import it.
- `dashboard/src/lib/channel.test.ts` — unit tests for the above.
- `dashboard/src/components/OwnShopScorecard.tsx` — the overview's "how are we doing in this channel" block.

**Modify**
- `dashboard/src/lib/queries.ts` — `ourListings(channel)` factory replacing the static `ourProducts` fragment (line 305); `getPricePositions(channel, filter)`; `computePairingSnapshot`/`getPairingSnapshot`/`getOwnShopScorecard`; `getPricingAnalytics(channel)`; channel lookup for the detail page.
- `dashboard/src/lib/schemas.ts` — add `ownShopScorecardSchema`; drop `marketplace` from `pricePositionFilterSchema` (line 287).
- `dashboard/src/lib/queries.test.ts` — update existing `getPricePositions` call sites; add channel-scoping tests.
- `dashboard/src/app/(app)/page.tsx` — scorecard first, market totals as a context strip.
- `dashboard/src/app/(app)/pricing/page.tsx` — read channel, drop the marketplace chip.
- `dashboard/src/app/(app)/pricing/[id]/page.tsx` — derive the channel from the product.
- `dashboard/src/app/(app)/analytics/page.tsx` — read channel; fix empty-state copy to name both marketplaces.
- `dashboard/src/app/(app)/settings/page.tsx` — mark which own shop is the active channel.
- `dashboard/src/components/shell/AppShell.tsx` — channel switcher in the topbar; every nav link carries `?kanal=`.

---

### Task 1: Channel resolution helpers

**Files:**
- Create: `dashboard/src/lib/channel.ts`
- Test: `dashboard/src/lib/channel.test.ts`

**Interfaces:**
- Consumes: `Marketplace`, `OwnShop` from `@/lib/schemas`.
- Produces:
  - `CHANNEL_PARAM = 'kanal'`
  - `type Channel = Marketplace`
  - `resolveChannel(raw: string | null | undefined, shops: ReadonlyArray<{ marketplace: string }>): Channel | null`
  - `withChannel(href: string, channel: Channel | null): string`
  - `channelShop<T extends { marketplace: string }>(channel: Channel | null, shops: readonly T[]): T | null`

  The shop parameter is the minimal shape on purpose: the pages hold `OwnShop[]`
  from the database, while `AppShell` holds its own `ShopBadge[]` whose
  `marketplace` is typed `string`. One signature has to accept both, or Task 6
  will not typecheck.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/channel.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { CHANNEL_PARAM, channelShop, resolveChannel, withChannel } from '@/lib/channel';
import type { OwnShop } from '@/lib/schemas';

/**
 * Which of our shops a request is about.
 *
 * Every figure on three screens is relative to one shop of ours, so this is the
 * function that decides what those numbers mean. It never throws: a hand-typed
 * or stale URL has to open the page anyway, on the shop that is still there.
 */

const shopee: OwnShop = { id: 25, marketplace: 'shopee', username: 'i_bricks', name: null, products: 1516 };
const tokopedia: OwnShop = { id: 164, marketplace: 'tokopedia', username: 'i-bricks', name: null, products: 1452 };

// getOwnShops orders by product count, so the list arrives in no useful order
// for this decision — the default has to sort for itself.
const both = [tokopedia, shopee];

describe('resolveChannel', () => {
  test('honours the channel named in the URL', () => {
    expect(resolveChannel('tokopedia', both)).toBe('tokopedia');
  });

  test('falls back to the first marketplace alphabetically when the URL says nothing', () => {
    expect(resolveChannel(undefined, both)).toBe('shopee');
    expect(resolveChannel(null, both)).toBe('shopee');
    expect(resolveChannel('', both)).toBe('shopee');
  });

  test('falls back rather than failing on a value that is not a marketplace', () => {
    expect(resolveChannel('lazada', both)).toBe('shopee');
  });

  test('falls back when the named channel has no own shop any more', () => {
    // A bookmark outliving `own-shop` being unset must not render another
    // channel's numbers under the old channel's name.
    expect(resolveChannel('tokopedia', [shopee])).toBe('shopee');
  });

  test('is null when no shop is marked ours', () => {
    expect(resolveChannel('shopee', [])).toBeNull();
  });
});

describe('channelShop', () => {
  test('returns the shop the channel belongs to', () => {
    expect(channelShop('tokopedia', both)?.username).toBe('i-bricks');
  });

  test('is null for no channel', () => {
    expect(channelShop(null, both)).toBeNull();
  });
});

describe('withChannel', () => {
  test('adds the parameter to a bare href', () => {
    expect(withChannel('/pricing', 'tokopedia')).toBe('/pricing?kanal=tokopedia');
  });

  test('keeps the query a link already carries', () => {
    expect(withChannel('/pricing?stance=over', 'shopee')).toBe('/pricing?stance=over&kanal=shopee');
  });

  test('replaces a channel already present rather than repeating it', () => {
    expect(withChannel('/pricing?kanal=shopee', 'tokopedia')).toBe('/pricing?kanal=tokopedia');
  });

  test('leaves the href alone when there is no channel', () => {
    expect(withChannel('/pricing', null)).toBe('/pricing');
  });

  test('names the parameter the rest of the app names', () => {
    expect(CHANNEL_PARAM).toBe('kanal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/lib/channel.test.ts`
Expected: FAIL — `Cannot find package '@/lib/channel'`.

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/src/lib/channel.ts`:

```ts
import { marketplaceSchema, type Marketplace } from '@/lib/schemas';

/**
 * Which of our shops the numbers on screen are about.
 *
 * Three screens — the overview, the price worklist, the analytics — answer
 * "where do we stand", and that question has no answer until it names one shop
 * of ours. Two shops merged into one pool double-counts the 1,174 sets listed in
 * both, so there is no combined view to fall back on: a channel is always
 * chosen, and it is chosen here.
 *
 * Deliberately free of `server-only` and of any database call: the pages resolve
 * it on the server, the shell resolves the same value on the client to decide
 * which switch is lit, and both must agree.
 */

export type Channel = Marketplace;

/** The query parameter, named once. Indonesian, like the rest of the UI. */
export const CHANNEL_PARAM = 'kanal';

/**
 * The channel this request is about, or null when no shop is marked ours.
 *
 * Never throws and never 404s. A hand-typed value, a value from before a
 * marketplace was added, or a bookmark that outlived `ecom-scraper own-shop`
 * all land on a shop that still exists — every scoped screen prints the channel
 * and the username in its heading, so the fallback is visible rather than
 * silent.
 */
export function resolveChannel(
  raw: string | null | undefined,
  shops: ReadonlyArray<{ marketplace: string }>,
): Channel | null {
  // Anything that is not one of our two marketplaces is not a channel, whatever
  // the database happens to hold.
  const available = shops
    .map((shop) => marketplaceSchema.safeParse(shop.marketplace))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .sort((left, right) => left.localeCompare(right));
  if (available.length === 0) return null;

  const asked = marketplaceSchema.safeParse(raw);
  if (asked.success && available.includes(asked.data)) return asked.data;

  return available[0];
}

/** The shop a channel belongs to, for headings that have to name it. */
export function channelShop<T extends { marketplace: string }>(
  channel: Channel | null,
  shops: readonly T[],
): T | null {
  if (!channel) return null;
  return shops.find((shop) => shop.marketplace === channel) ?? null;
}

/**
 * The same href, carrying the active channel.
 *
 * Navigation links are plain `href`s, so without this a click on "Analitik"
 * silently drops the channel and the page answers for the default shop instead.
 * Parsed rather than concatenated so a link that already carries a channel is
 * corrected instead of ending up with two.
 */
export function withChannel(href: string, channel: Channel | null): string {
  if (!channel) return href;

  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.set(CHANNEL_PARAM, channel);
  return `${path}?${params}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/lib/channel.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/channel.ts dashboard/src/lib/channel.test.ts
git commit -m "Decide which of our shops a request is about"
```

---

### Task 2: Scope the price worklist to one channel

**Files:**
- Modify: `dashboard/src/lib/queries.ts` (fragment at line 305, `getPricePositions` at line 373)
- Modify: `dashboard/src/lib/schemas.ts` (`pricePositionFilterSchema`, line 287)
- Modify: `dashboard/src/lib/queries.test.ts` (existing call sites + new tests)
- Modify: `dashboard/src/app/(app)/pricing/page.tsx`

**Interfaces:**
- Consumes: `resolveChannel`, `channelShop`, `CHANNEL_PARAM` from Task 1.
- Produces:
  - `ourListings(channel: Channel)` — internal SQL fragment factory, replaces the exported-in-file `ourProducts` constant.
  - `getPricePositions(channel: Channel, filter: PricePositionFilter): Promise<{ rows: PricePositionRow[]; total: number; summary: PricePositionSummary }>`
  - `PricePositionFilter` no longer has a `marketplace` field.

- [ ] **Step 1: Write the failing tests**

In `dashboard/src/lib/queries.test.ts`, add to the `price position` describe block:

```ts
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

    // Cheaper, same set, but it is us. Our own shelf is not competition.
    expect(rows[0].rivals).toBe(0);
    expect(rows[0].cheapestPrice).toBeNull();
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run src/lib/queries.test.ts`
Expected: FAIL — `getPricePositions` receives a string where a filter object is expected; TypeScript also reports 2 arguments against 1.

- [ ] **Step 3: Turn the fragment into a factory and thread the channel**

In `dashboard/src/lib/queries.ts`, replace the `ourProducts` constant (line 305):

```ts
/**
 * Our listings in one channel, newest price each.
 *
 * A factory rather than a constant because "ours" is only half a definition:
 * the Shopee shop and the Tokopedia shop list the same 1,174 sets, so a query
 * that joins on `is_own` alone answers for a shop that does not exist. Taking
 * the channel as an argument means there is no unscoped fragment left for a
 * later screen to reach for.
 */
const ourListings = (channel: Channel) => sql`
  SELECT p.id, p.marketplace, p.name, p.url, p.image, p.set_code,
         l.price, l.scraped_at
  FROM products p
  JOIN stores s ON s.id = p.shop_ref AND s.is_own AND s.marketplace = ${channel}
  LEFT JOIN latest l ON l.product_ref = p.id
`;
```

Add the import at the top of the file:

```ts
import type { Channel } from '@/lib/channel';
```

Change the signature and the `mine` CTE of `getPricePositions`:

```ts
export async function getPricePositions(
  channel: Channel,
  filter: PricePositionFilter,
): Promise<{ rows: PricePositionRow[]; total: number; summary: PricePositionSummary }> {
```

Inside its statement, replace `mine AS MATERIALIZED (${ourProducts})` with:

```ts
    mine AS MATERIALIZED (${ourListings(channel)}),
```

Delete the marketplace clause from the `where` fragment (line 380):

```ts
  const where = sql`
    WHERE TRUE
```

(The `${filter.marketplace ? sql`AND b.marketplace = ${filter.marketplace}` : sql``}` line goes away entirely — the channel decides that now, and `b.marketplace` was our own listing's marketplace.)

Also update `getPricePositionDetail`, whose `mine` CTEs use the same fragment. It has no channel argument yet; give it one derived from the product, so the rest of the file has no unscoped call:

```ts
/**
 * Which of our shops a listing belongs to, or null when it is not ours.
 *
 * The detail page is reached with a product id, and an id already names a shop.
 * Looking the channel up rather than taking it from the URL means a shared link
 * opens on the shop it is actually about.
 */
export async function channelOfOwnProduct(productId: number): Promise<Channel | null> {
  const [row] = await sql`
    SELECT s.marketplace
    FROM products p
    JOIN stores s ON s.id = p.shop_ref AND s.is_own
    WHERE p.id = ${productId}
  `;
  return (row?.marketplace as Channel | undefined) ?? null;
}
```

and in `getPricePositionDetail`, replace both `${ourProducts}` uses:

```ts
export async function getPricePositionDetail(
  productId: number,
): Promise<{ product: PricePositionRow; rivals: RivalRow[] } | null> {
  const channel = await channelOfOwnProduct(productId);
  if (!channel) return null;

  const [mine] = await sql`
    WITH latest AS (${latestSnapshots}),
    mine AS (${ourListings(channel)})
```

```ts
  const rivals = await withNameMatching((tx) => tx`
    WITH latest AS (${latestSnapshots}),
    mine AS (SELECT * FROM (${ourListings(channel)}) o WHERE o.id = ${productId}),
```

- [ ] **Step 4: Drop `marketplace` from the filter schema**

In `dashboard/src/lib/schemas.ts`, remove line 287 from `pricePositionFilterSchema`:

```ts
  minRivals: intFromQuery.nonnegative().max(50).optional().catch(undefined),
  sort: z.enum(['gap', 'position', 'rivals', 'price', 'name']).default('gap').catch('gap'),
```

An old bookmark carrying `?marketplace=shopee` still opens the page: `z.object` ignores keys it does not know. It simply no longer filters.

- [ ] **Step 5: Update the pricing page**

In `dashboard/src/app/(app)/pricing/page.tsx`, after `const shops = await getOwnShops();` and the `shops.length === 0` early return, resolve the channel and pass it:

```ts
  const channel = resolveChannel(params[CHANNEL_PARAM] as string | undefined, shops);
  const shop = channelShop(channel, shops);

  // `channel` is only null when no shop is marked ours, which the early return
  // above has already handled.
  const { rows, total, summary } = await getPricePositions(channel!, filter);
```

Add to the imports:

```ts
import { CHANNEL_PARAM, channelShop, resolveChannel } from '@/lib/channel';
```

Name the channel in the header so the numbers are never anonymous — in `PageHeader`, pass and render the shop:

```tsx
        <p className="max-w-2xl text-sm text-muted">
          Produk <span className="font-medium text-foreground">{shop?.username}</span> di{' '}
          {MARKETPLACE_LABELS[channel!]} dibanding produk toko lain dengan nomor set LEGO yang sama,
          lintas marketplace.
        </p>
```

Delete the marketplace `UrlChoice` block (page lines ~286–296, the one with `param="marketplace"`).

Update the existing `getPricePositions(anyFilter)` call sites in `dashboard/src/lib/queries.test.ts` to `getPricePositions('shopee', anyFilter)` — every fixture in that file creates its own shop with the default `marketplace: 'shopee'`, so the expectations do not change.

- [ ] **Step 6: Run the whole suite**

Run: `cd dashboard && npx vitest run`
Expected: PASS — the three new tests plus every existing one.

- [ ] **Step 7: Typecheck and lint**

Run: `cd dashboard && npm run build && npm run lint`
Expected: build succeeds; lint reports 0 errors (the TanStack `useReactTable` warning is pre-existing and stays).

- [ ] **Step 8: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/queries.ts dashboard/src/lib/queries.test.ts dashboard/src/lib/schemas.ts "dashboard/src/app/(app)/pricing/page.tsx"
git commit -m "Scope the price worklist to one of our shops"
```

---

### Task 3: One cached pairing snapshot behind two screens

**Files:**
- Modify: `dashboard/src/lib/queries.ts` (`getPricingAnalytics`, line 566)
- Modify: `dashboard/src/lib/schemas.ts` (add `ownShopScorecardSchema`)
- Modify: `dashboard/src/lib/queries.test.ts`

**Interfaces:**
- Consumes: `ourListings`, `Channel` from Task 2.
- Produces:
  - `computePairingSnapshot(channel: Channel): Promise<PairingSnapshot>` — uncached; what tests call.
  - `getPairingSnapshot(channel: Channel): Promise<PairingSnapshot>` — `unstable_cache` wrapper; what pages call.
  - `getOwnShopScorecard(channel: Channel, shop: OwnShop): Promise<OwnShopScorecard>`
  - `getPricingAnalytics(channel: Channel): Promise<PricingAnalytics>`
  - `type PairingSnapshot = PricingAnalytics & { listings: number; withRivals: number; atStake: string | null }`
  - `ownShopScorecardSchema`, `type OwnShopScorecard`

- [ ] **Step 1: Write the failing tests**

Add a new describe block at the end of `dashboard/src/lib/queries.test.ts`:

```ts
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
```

Extend the import at the top of the test file:

```ts
import {
  computePairingSnapshot,
  getOwnShopScorecard,
  getOwnShops,
  getPricePositionDetail,
  getPricePositions,
  getPricingAnalytics,
  withNameMatching,
} from '@/lib/queries';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run src/lib/queries.test.ts`
Expected: FAIL — `computePairingSnapshot is not a function`, `getOwnShopScorecard is not a function`.

- [ ] **Step 3: Add the schema**

In `dashboard/src/lib/schemas.ts`, after `pricingAnalyticsSchema` (line 215):

```ts
/**
 * The overview's answer to "where do we stand in this channel".
 *
 * A subset of the pairing snapshot rather than its own query: two numbers that
 * are supposed to be the same number must come from the same statement, or one
 * of them is eventually wrong and nobody notices which.
 */
export const ownShopScorecardSchema = z.object({
  channel: marketplaceSchema,
  shopUsername: z.string(),
  listings: z.coerce.number().int(),
  withRivals: z.coerce.number().int(),
  position: z.object({
    cheapest: z.coerce.number().int(),
    middle: z.coerce.number().int(),
    dearest: z.coerce.number().int(),
    unmatched: z.coerce.number().int(),
  }),
  atStake: moneySchema,
});
export type OwnShopScorecard = z.infer<typeof ownShopScorecardSchema>;
```

- [ ] **Step 4: Rename and extend the analytics statement**

In `dashboard/src/lib/queries.ts`, rename `getPricingAnalytics` to `computePairingSnapshot`, take the channel, use `ourListings(channel)` for `mine`, and add the two scorecard-only aggregates. The `mine` CTE becomes:

```ts
    mine AS MATERIALIZED (
      SELECT o.id, o.name, o.set_code, o.price, l.sold
      FROM (${ourListings(channel)}) o
      JOIN latest l ON l.product_ref = o.id
      WHERE o.price IS NOT NULL
    ),
```

and two more expressions join the four already selected:

```ts
      (SELECT count(*) FROM scored)                         AS listings,
      (SELECT count(*) FROM scored WHERE rivals > 0)        AS "withRivals",
      (
        SELECT coalesce(sum(price - cheapest) FILTER (WHERE price > cheapest), 0)
        FROM scored WHERE rivals > 0
      ) AS "atStake",
```

`atStake` keeps the definition the band panel already uses — the gap to the cheapest rival, summed over listings that are dearer, with no extreme-gap filter — so the figure stays comparable to what the analytics page has always shown.

Then the three public functions:

```ts
export type PairingSnapshot = PricingAnalytics & {
  listings: number;
  withRivals: number;
  atStake: string | null;
};

export async function computePairingSnapshot(channel: Channel): Promise<PairingSnapshot> {
  // The statement is the one this function already had as `getPricingAnalytics`:
  // keep it byte-for-byte except for the `mine` CTE and the three new selected
  // expressions from the edits above. Do not retype it — it is 90 lines of
  // carefully commented SQL and every comment in it is still true.
  const [row] = await withNameMatching((tx) => tx`
    WITH latest AS (${latestSnapshots}),
    mine AS MATERIALIZED (
      SELECT o.id, o.name, o.set_code, o.price, l.sold
      FROM (${ourListings(channel)}) o
      JOIN latest l ON l.product_ref = o.id
      WHERE o.price IS NOT NULL
    ),
    pairs AS MATERIALIZED ( /* unchanged */ ),
    best AS ( /* unchanged */ ),
    scored AS ( /* unchanged */ )
    SELECT
      /* the four existing expressions: position, rivals, bands, gapVolume */
      (SELECT count(*) FROM scored)                  AS listings,
      (SELECT count(*) FROM scored WHERE rivals > 0) AS "withRivals",
      (
        SELECT coalesce(sum(price - cheapest) FILTER (WHERE price > cheapest), 0)
        FROM scored WHERE rivals > 0
      ) AS "atStake"
  `);

  return {
    ...pricingAnalyticsSchema.parse(row),
    listings: Number(row.listings),
    withRivals: Number(row.withRivals),
    atStake: row.atStake === null ? null : String(row.atStake),
  };
}

/**
 * The same snapshot, at most five minutes old.
 *
 * The pairing is the expensive part of this app — 2.9–3.3s against Neon — and
 * two screens need all of it. Snapshots only change when a scrape runs, so a
 * five-minute-old answer is the same answer; the first visit pays for it and the
 * rest do not.
 *
 * The cache wraps `computePairingSnapshot` from outside on purpose: the tests
 * call the inner function, which needs no Next request context to run.
 */
export const getPairingSnapshot = unstable_cache(
  (channel: Channel) => computePairingSnapshot(channel),
  ['pairing'],
  { revalidate: 300, tags: ['pairing'] },
);
// The arguments are part of the cache key, so `shopee` and `tokopedia` can never
// be served each other's snapshot. The key parts above only namespace it.

/** What the analytics page needs: the snapshot without the scorecard extras. */
export async function getPricingAnalytics(channel: Channel): Promise<PricingAnalytics> {
  const { position, rivals, bands, gapVolume } = await getPairingSnapshot(channel);
  return { position, rivals, bands, gapVolume };
}

/** What the overview needs: the headline four, named for the shop they describe. */
export async function getOwnShopScorecard(
  channel: Channel,
  shop: OwnShop,
): Promise<OwnShopScorecard> {
  const snapshot = await getPairingSnapshot(channel);
  return ownShopScorecardSchema.parse({
    channel,
    shopUsername: shop.username,
    listings: snapshot.listings,
    withRivals: snapshot.withRivals,
    position: snapshot.position,
    atStake: snapshot.atStake,
  });
}
```

Add the imports:

```ts
import { unstable_cache } from 'next/cache';
```

and extend the existing `@/lib/schemas` import with `ownShopScorecardSchema` and `type OwnShopScorecard`.

Note for the implementer: `unstable_cache` is marked "replaced by `use cache`" in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_cache.md`. `use cache` needs `cacheComponents: true`, which turns PPR on for every route in this app; the spec records that as deliberate technical debt. Do not enable it here.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run src/lib/queries.test.ts`
Expected: PASS. If `getOwnShopScorecard`/`getPricingAnalytics` throw about a missing request store, the `unstable_cache` boundary has been placed inside the tested function instead of around it — move it back out.

- [ ] **Step 6: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/lib/queries.ts dashboard/src/lib/queries.test.ts dashboard/src/lib/schemas.ts
git commit -m "Compute the pairing once per channel, cache it for both screens"
```

---

### Task 4: Overview becomes a scorecard for the active channel

**Files:**
- Create: `dashboard/src/components/OwnShopScorecard.tsx`
- Modify: `dashboard/src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: `getOwnShopScorecard`, `getOwnShops`, `getOverview` from `@/lib/queries`; `resolveChannel`, `channelShop`, `CHANNEL_PARAM` from Task 1; `OwnShopScorecard` from `@/lib/schemas`.
- Produces: `<OwnShopScorecard scorecard={…} />`.

- [ ] **Step 1: Write the component**

Create `dashboard/src/components/OwnShopScorecard.tsx`:

```tsx
import Link from 'next/link';

import { Card, CardContent, Stat } from '@/components/ui';
import { MARKETPLACE_LABELS, formatPrice } from '@/lib/format';
import { withChannel } from '@/lib/channel';
import type { OwnShopScorecard as Scorecard } from '@/lib/schemas';

/**
 * Where we stand in one channel, as four numbers and a spread.
 *
 * The overview used to open on the size of the database — 32 shops, 12,502
 * products — which is true and answers a question nobody asks daily. These are
 * the four figures that decide whether to touch a price today, and every one of
 * them is about one shop of ours, named in the heading so it can never be read
 * as both.
 */

const count = new Intl.NumberFormat('id-ID');

export function OwnShopScorecard({ scorecard }: { scorecard: Scorecard }) {
  const { position } = scorecard;
  const pricing = withChannel('/pricing', scorecard.channel);

  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Listing kita" value={count.format(scorecard.listings)} hint={`${MARKETPLACE_LABELS[scorecard.channel]} · ${scorecard.shopUsername}`} />
          <Stat label="Punya rival" value={count.format(scorecard.withRivals)} hint="produk yang bisa dibandingkan" />
          <Stat label="Termurah" value={count.format(position.cheapest)} hint="tidak ada yang di bawah kita" />
          <Stat label="Uang di meja" value={formatPrice(scorecard.atStake)} hint="selisih ke rival termurah" />
        </div>

        <p className="text-xs text-muted">
          Sebaran posisi{' '}
          <Link href={`${pricing}&stance=under`} className="underline-offset-4 hover:text-foreground hover:underline">
            termurah {count.format(position.cheapest)}
          </Link>
          {' · '}tengah {count.format(position.middle)}
          {' · '}
          <Link href={`${pricing}&stance=over`} className="underline-offset-4 hover:text-foreground hover:underline">
            termahal {count.format(position.dearest)}
          </Link>
          {' · '}
          <Link href={`${pricing}&matched=none`} className="underline-offset-4 hover:text-foreground hover:underline">
            tanpa rival {count.format(position.unmatched)}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Rewrite the overview page around it**

In `dashboard/src/app/(app)/page.tsx`:

Accept search params and resolve the channel:

```tsx
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const params = await searchParams;
  const shops = await getOwnShops();
  const channel = resolveChannel(params[CHANNEL_PARAM] as string | undefined, shops);
  const shop = channelShop(channel, shops);

  const [overview, scorecard, cheapest, priciest, topStores] = await Promise.all([
    getOverview(),
    channel && shop ? getOwnShopScorecard(channel, shop) : null,
    getProducts(productFilterSchema.parse({ sort: 'price', dir: 'asc', pageSize: 5 })),
    getProducts(productFilterSchema.parse({ sort: 'price', dir: 'desc', pageSize: 5 })),
    getStores(storeFilterSchema.parse({ sort: 'products', dir: 'desc', pageSize: 5 })),
  ]);
```

Heading names the channel:

```tsx
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Ringkasan
            {shop ? (
              <span className="ml-2 text-base font-normal text-muted">
                {MARKETPLACE_LABELS[shop.marketplace]} · {shop.username}
              </span>
            ) : null}
          </h1>
```

Render the scorecard where `OverviewCards` used to lead, and demote the market totals to a labelled strip below it:

```tsx
      {scorecard ? (
        <OwnShopScorecard scorecard={scorecard} />
      ) : (
        <EmptyState
          title="Belum ada toko yang ditandai sebagai toko kita"
          description={
            <>
              Angka posisi harga di halaman ini relatif terhadap toko sendiri. Tandai sekali lewat
              terminal — satu perintah per marketplace:
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper own-shop shopee i_bricks
                <br />
                ecom-scraper own-shop tokopedia i-bricks
              </code>
            </>
          }
        />
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Pasar</h2>
        <OverviewCards overview={overview} />
      </section>
```

Add the imports:

```tsx
import { OwnShopScorecard } from '@/components/OwnShopScorecard';
import { CHANNEL_PARAM, channelShop, resolveChannel } from '@/lib/channel';
import { getOverview, getOwnShopScorecard, getOwnShops, getProducts, getStores } from '@/lib/queries';
```

- [ ] **Step 3: Typecheck and lint**

Run: `cd dashboard && npm run build && npm run lint`
Expected: build succeeds, 0 lint errors.

- [ ] **Step 4: Look at it**

Run: `cd dashboard && npm run dev` and open `http://localhost:3000/?kanal=tokopedia` (log in first; the local database is the one the scraper writes to).
Expected: heading reads "Ringkasan Tokopedia · i-bricks"; the four figures match the spec's benchmark row for Tokopedia (1.452 / 890 / 385 / Rp 170.068.254); `?kanal=shopee` shows the Shopee row (1.516 / 930 / 394 / Rp 170.870.071).

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/components/OwnShopScorecard.tsx "dashboard/src/app/(app)/page.tsx"
git commit -m "Open the overview on our own shelf, not the database size"
```

---

### Task 5: Analytics scoped to the active channel

**Files:**
- Modify: `dashboard/src/app/(app)/analytics/page.tsx`

**Interfaces:**
- Consumes: `getPricingAnalytics(channel)` from Task 3; `resolveChannel`, `channelShop`, `CHANNEL_PARAM` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Read the channel and pass it**

```tsx
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shops = await getOwnShops();
  const channel = resolveChannel(params[CHANNEL_PARAM] as string | undefined, shops);
  const shop = channelShop(channel, shops);

  if (!channel || !shop) {
    // Keep the block that is already there — `<Header />` plus `<EmptyState>` —
    // and change only the command inside it, in Step 2. Nothing else about the
    // zero-shops case changes.
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState title="Belum ada toko yang ditandai sebagai toko kita" description={/* Step 2 */ null} />
      </div>
    );
  }

  const analytics = await getPricingAnalytics(channel);
```

- [ ] **Step 2: Fix the empty-state copy and name the channel**

The empty state currently prints only the Shopee command; there are two shops to mark:

```tsx
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper own-shop shopee i_bricks
                <br />
                ecom-scraper own-shop tokopedia i-bricks
              </code>
```

And in the page heading:

```tsx
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Analitik
            <span className="ml-2 text-base font-normal text-muted">
              {MARKETPLACE_LABELS[shop.marketplace]} · {shop.username}
            </span>
          </h1>
```

Keep the rival-pressure panel exactly as it is: it groups by the rival's shop and shows their marketplace badge, which is the panel that finally makes it visible that from the Shopee channel the pressure comes mostly from Tokopedia sellers.

- [ ] **Step 3: Typecheck, lint, look at it**

Run: `cd dashboard && npm run build && npm run lint`
Then `npm run dev` and compare `/analytics?kanal=shopee` with `/analytics?kanal=tokopedia`.
Expected: the position mix on each page equals that channel's scorecard on the overview; the two pages differ.

- [ ] **Step 4: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add "dashboard/src/app/(app)/analytics/page.tsx"
git commit -m "Answer the analytics questions for one shop at a time"
```

---

### Task 6: The channel switcher, and every link that must carry it

**Files:**
- Modify: `dashboard/src/components/shell/AppShell.tsx`
- Modify: `dashboard/src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `resolveChannel`, `withChannel`, `CHANNEL_PARAM` from Task 1; `shops: ShopBadge[]` already passed into `AppShell` by `(app)/layout.tsx`.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Resolve the channel in the shell**

`AppShell` is already a client component, and a layout cannot read search params — so the shell reads them itself:

```tsx
import { usePathname, useSearchParams } from 'next/navigation';

import { CHANNEL_PARAM, resolveChannel, withChannel } from '@/lib/channel';
```

```tsx
  const searchParams = useSearchParams();
  const channel = resolveChannel(searchParams.get(CHANNEL_PARAM), shops);
```

`ShopBadge` already carries `id`, `marketplace`, `username` and `products`, which is what `resolveChannel` reads — pass `shops` straight in.

- [ ] **Step 2: Make the shop badges a switcher**

Replace the passive badge list in `Topbar` with a two-state switch. Reuse the existing URL-state component so a channel change behaves like every other filter change:

```tsx
      <div className="ml-2 hidden min-w-0 items-center gap-1.5 md:flex">
        {shops.length === 0 ? (
          <span className="rounded-md border border-dashed border-line px-2 py-1 text-xs text-muted">
            belum ada toko sendiri
          </span>
        ) : shops.length === 1 ? (
          <ShopBadgeChip shop={shops[0]} active />
        ) : (
          shops.map((shop) => (
            <Link
              key={shop.id}
              href={withChannel(pathname, shop.marketplace)}
              aria-current={shop.marketplace === channel ? 'true' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors',
                shop.marketplace === channel
                  ? 'border-accent/40 bg-accent/10 text-foreground'
                  : 'border-line bg-surface-muted text-muted hover:text-foreground',
              )}
              title={`${shop.products} produk ter-scrape`}
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  shop.marketplace === 'shopee' ? 'bg-shopee' : 'bg-tokopedia',
                )}
              />
              <span className="font-medium">{shop.username}</span>
              <span className="tabular-nums">{shop.products.toLocaleString('id-ID')}</span>
            </Link>
          ))
        )}
      </div>
```

Extract the single-shop case into a small `ShopBadgeChip` in the same file so the two-shop and one-shop renderings cannot drift.

Switching keeps you on the page you are on (`pathname`), because "same question, other shop" is the whole point of the control.

- [ ] **Step 3: Carry the channel through navigation**

In `NavLinks`, the `href` must keep the channel or clicking "Analitik" silently answers for the default shop:

```tsx
function NavLinks({
  pathname,
  collapsed,
  channel,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  channel: Channel | null;
  onNavigate?: () => void;
}) {
```

```tsx
            <Link
              href={withChannel(item.href, channel)}
              onClick={onNavigate}
```

Pass `channel={channel}` at both `NavLinks` call sites (rail and drawer), and import `type Channel` from `@/lib/channel`.

The brand link at the top of the topbar gets the same treatment: `href={withChannel('/', channel)}`.

- [ ] **Step 4: Mark the active shop in settings**

In `dashboard/src/app/(app)/settings/page.tsx`, the "Toko sendiri" list should say which one the rest of the app is currently reporting on. The page already reads `searchParams`? It does not — add it, resolve the channel the same way, and render a chip:

```tsx
              {shops.map((shop) => (
                <li key={shop.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-medium text-foreground">
                    {shop.username}
                    {shop.marketplace === channel ? (
                      <span className="ml-2 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-xs font-normal text-accent">
                        kanal aktif
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted">
                    {shop.marketplace} · {shop.products.toLocaleString('id-ID')} produk
                  </span>
                </li>
              ))}
```

- [ ] **Step 5: Typecheck, lint, click through it**

Run: `cd dashboard && npm run build && npm run lint`
Then `npm run dev`:
- Click the Tokopedia chip on `/pricing` → stays on `/pricing`, URL gains `?kanal=tokopedia`, numbers change, chip lights up.
- Click "Analitik" in the rail → URL keeps `?kanal=tokopedia`.
- Reload → same channel. Back → previous channel.
- `/settings?kanal=tokopedia` → "kanal aktif" chip sits on `i-bricks`.

- [ ] **Step 6: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add dashboard/src/components/shell/AppShell.tsx "dashboard/src/app/(app)/settings/page.tsx"
git commit -m "Switch shops from the topbar, and keep the choice while navigating"
```

---

### Task 7: The detail page opens on the shop it is about

**Files:**
- Modify: `dashboard/src/app/(app)/pricing/[id]/page.tsx`
- Modify: `dashboard/src/lib/queries.test.ts`

**Interfaces:**
- Consumes: `channelOfOwnProduct` and `getPricePositionDetail` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `dashboard/src/lib/queries.test.ts`, inside the `price position` describe block:

```ts
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
    // A rival's product is nobody's channel.
    expect(await channelOfOwnProduct(theirs)).toBeNull();
  });
```

Add `channelOfOwnProduct` to the import list from `@/lib/queries`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd dashboard && npx vitest run src/lib/queries.test.ts -t "which of our shops"`
Expected: FAIL if Task 2 was skipped; PASS immediately if Task 2 already added the function — in that case keep the test (it pins behaviour the detail page now depends on) and move to Step 3.

- [ ] **Step 3: Make the detail page channel-aware**

In `dashboard/src/app/(app)/pricing/[id]/page.tsx`, links back to the worklist and the shell's chips should agree with the product being shown. Resolve the product's channel and redirect once when the URL disagrees:

```tsx
import { redirect } from 'next/navigation';

import { CHANNEL_PARAM, withChannel } from '@/lib/channel';
import { channelOfOwnProduct, getPricePositionDetail } from '@/lib/queries';
```

```tsx
  const detail = await getPricePositionDetail(productId);
  if (!detail) notFound();

  const channel = await channelOfOwnProduct(productId);
  const asked = (await searchParams)[CHANNEL_PARAM];

  // The id already names a shop, so a link that arrives with the other channel
  // (or none) is corrected rather than shown under the wrong heading.
  if (channel && asked !== channel) {
    redirect(withChannel(`/pricing/${productId}`, channel));
  }
```

If this page does not currently accept `searchParams`, add the prop with the same shape the other pages use.

Every "back to the worklist" link on the page becomes `withChannel('/pricing', channel)`.

- [ ] **Step 4: Run the suite, typecheck, lint**

Run: `cd dashboard && npx vitest run && npm run build && npm run lint`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /Users/calvin/ecom-scraper
git add "dashboard/src/app/(app)/pricing/[id]/page.tsx" dashboard/src/lib/queries.test.ts
git commit -m "Open a product's detail on the shop that lists it"
```

---

### Task 8: Verify against the spec's numbers, then hand it over

**Files:**
- Modify: `README.md` (the dashboard section, if it describes the screens)
- Test: none new

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch, pushed.

- [ ] **Step 1: Check the figures against the benchmark**

The spec records what each channel should produce from the data as of 2026-07-30. Run the same aggregation directly and compare with the screens:

```bash
psql postgresql://calvin@127.0.0.1:5432/ecom_scraper <<'SQL'
SELECT similarity('a','b');
BEGIN; SET LOCAL pg_trgm.similarity_threshold = 0.45;
WITH latest AS (
  SELECT DISTINCT ON (product_ref) product_ref, price
  FROM price_snapshots ORDER BY product_ref, scraped_at DESC, id DESC
),
mine AS (
  SELECT p.id, p.name, p.set_code, s.marketplace AS kanal, l.price
  FROM products p
  JOIN stores s ON s.id = p.shop_ref AND s.is_own
  JOIN latest l ON l.product_ref = p.id
  WHERE l.price IS NOT NULL
),
pairs AS (
  SELECT m.id AS mine_id, m.kanal, m.price AS my_price, s.id AS store_id, l.price AS their_price
  FROM mine m
  JOIN products p ON p.set_code = m.set_code
  JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
  JOIN latest l ON l.product_ref = p.id AND l.price IS NOT NULL
  WHERE m.set_code IS NOT NULL
  UNION ALL
  SELECT m.id, m.kanal, m.price, s.id, l.price
  FROM mine m
  JOIN products p ON p.name % m.name AND similarity(p.name, m.name) >= 0.45
  JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
  JOIN latest l ON l.product_ref = p.id AND l.price IS NOT NULL
  WHERE m.set_code IS NULL AND m.name IS NOT NULL
),
best AS (SELECT mine_id, kanal, my_price, store_id, min(their_price) AS their_price FROM pairs GROUP BY 1,2,3,4),
scored AS (
  SELECT m.id, m.kanal, m.price, count(b.*) AS rivals, min(b.their_price) AS cheapest,
         count(*) FILTER (WHERE b.their_price < m.price) AS beaten_by
  FROM mine m LEFT JOIN best b ON b.mine_id = m.id GROUP BY m.id, m.kanal, m.price
)
SELECT kanal, count(*) AS listings, count(*) FILTER (WHERE rivals > 0) AS with_rivals,
       count(*) FILTER (WHERE rivals > 0 AND beaten_by = 0) AS cheapest,
       count(*) FILTER (WHERE rivals > 0 AND beaten_by > 0 AND beaten_by < rivals) AS middle,
       count(*) FILTER (WHERE rivals > 0 AND beaten_by = rivals) AS dearest,
       count(*) FILTER (WHERE rivals = 0) AS unmatched,
       coalesce(sum(price - cheapest) FILTER (WHERE price > cheapest), 0) AS at_stake
FROM scored GROUP BY kanal ORDER BY kanal;
COMMIT;
SQL
```

Expected (from the spec):

| kanal | listings | with_rivals | cheapest | middle | dearest | unmatched | at_stake |
|---|---|---|---|---|---|---|---|
| shopee | 1516 | 930 | 394 | 252 | 284 | 586 | 170870071 |
| tokopedia | 1452 | 890 | 385 | 232 | 273 | 562 | 170068254 |

If a screen disagrees with this table, the screen is wrong — this SQL is the same shape the spec was written from. The likely cause is a `mine` CTE that lost the `is_own`/channel join or an `atStake` that acquired an extreme-gap filter.

- [ ] **Step 2: Confirm no screen sums the channels**

```bash
cd dashboard && grep -rn "is_own" src/lib/queries.ts
```
Expected: every occurrence is inside `ourListings` or `channelOfOwnProduct`. Any other `is_own` join is an unscoped definition of "ours" and must go through the factory.

- [ ] **Step 3: Full gate**

Run: `cd dashboard && npx vitest run && npm run lint && npm run build`
Expected: all tests pass, 0 lint errors, build succeeds.

- [ ] **Step 4: Update the README if it describes these screens**

Check `README.md` for descriptions of the overview and analytics screens; if it says the dashboard reports on "toko sendiri" without mentioning that one channel is active at a time, add a sentence. Do not restructure the section.

- [ ] **Step 5: Commit and push the branch**

```bash
cd /Users/calvin/ecom-scraper
git add -A
git status --short   # confirm nothing stray (no node_modules, no .env*)
git commit -m "Verify each channel against the spec's benchmark figures"
git push -u origin <branch-name>
```

Stop there. Calvin merges to `main` himself and runs the deploy himself.

---

## Notes for the implementer

- `getOwnShops()` orders by product count, not marketplace — never rely on its order for the default channel; `resolveChannel` sorts for itself.
- The three scoped pages are `force-dynamic` and read `searchParams`; layouts cannot read search params, which is why the shell resolves the channel on the client.
- Prices are NUMERIC and arrive as strings. Keep them strings until `format.ts` renders them; `Number(...)` only inside tests and inside comparisons that already exist.
- Do not add a "gabungan" (combined) option anywhere. The absence of it is the feature.
- `src/app/(app)/products/`, `src/app/(app)/stores/`, `src/lib/client-api.ts`, the hooks and the four API routes are out of scope and must not change. Those screens research the market with their own marketplace filters; the channel does not reach them.
- The price worklist stays uncached. Its result depends on the filter and the page, so a cache key would differ almost every request and only accumulate; it pays for its own pairing as it does today.
- `Stat` takes `label`, `value`, `hint` (all `ReactNode`) and draws no box of its own — compose it inside a `Card`. `formatPrice` accepts `string | number | null | undefined` and renders `–` for nothing.
