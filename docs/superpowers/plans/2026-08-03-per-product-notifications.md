# Per-Product Notifications Implementation Plan

> **SUPERSEDED.** The feature this document describes was replaced by the
> in-dashboard notifications page. See
> [`docs/superpowers/specs/2026-08-07-dashboard-notifications-design.md`](../specs/2026-08-07-dashboard-notifications-design.md).
> Kept as the record of what was built and why it was removed; nothing here
> describes code that still exists.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Send one Telegram message per price change on a set our own shops also carry, each carrying our position on that set, and leave everything else in the existing digest.

**Architecture:** Three additions to the existing notifier. A batched position query answers "where do we stand" for every own set in one round trip. A per-product renderer turns one change plus its position into one message. `runNotify` splits the change list into two streams, caps the per-product one, and spills the overflow into the digest.

**Spec:** `docs/superpowers/specs/2026-08-03-per-product-notifications-design.md` — read it first; it carries the reasoning and the measured numbers.

## Global Constraints

- Import `{ sql }` from `@/lib/db`; never call `postgres()`.
- Writes stay confined to `notify/watermark.ts`. Nothing in this plan adds a write.
- `price_snapshots.id` is `bigint`, a string in JS — never coerced or compared in JavaScript. NUMERIC prices likewise stay strings until the formatting edge.
- `EXTREME_GAP` must be **imported** from `@/lib/queries`, never copied as a literal. Two thresholds with one name is how they come to disagree.
- Comments and identifiers English; user-facing strings Indonesian.
- Pure modules (`format.ts`, `links.ts`) must not import `server-only`; type-only imports from `events.ts` stay `import type`.
- Tests run against `ecom_scraper_test`, `fileParallelism: false`. `src/lib/queries.test.ts:71-89` is the DB-test pattern.
- Run `npm run test` and `npx tsc --noEmit` from `dashboard/` before every commit. `src/lib/api-session.test.ts:67` has a pre-existing, unrelated type error — ignore only that one.
- Count `test(...)` blocks yourself and report the real number. This plan's predecessor miscounted twice.

## File Structure

| File | Change |
|---|---|
| `dashboard/src/lib/queries.ts` | Export the existing `EXTREME_GAP` constant. One word. |
| `dashboard/src/lib/notify/positions.ts` | **New.** The batched own-set position query. |
| `dashboard/src/lib/notify/format.ts` | Add the per-product renderer and the stream split. |
| `dashboard/src/lib/notify/run.ts` | Orchestrate two streams, cap, spill. |

---

### Task 1: The position query

**Files:** create `dashboard/src/lib/notify/positions.ts` and `dashboard/src/lib/notify/positions.test.ts`; modify `dashboard/src/lib/queries.ts:285`.

**Produces:**
- `type SetPosition = { setCode: string; ourPrice: string | null; ourShop: string | null; cheapestRival: string | null; rivalCount: number; extreme: boolean }`
- `ownSetPositions(tx: Sql): Promise<Map<string, SetPosition>>`

**Behaviour:** one query returning a row per `set_code` that any `is_own` shop carries. `ourPrice` is the cheapest own listing's latest price, `ourShop` its username, `cheapestRival` the cheapest non-own latest price, `rivalCount` how many non-own listings have a price. `extreme` is true when both prices exist and `abs(ourPrice - cheapestRival) / cheapestRival >= EXTREME_GAP`, using the constant imported from `@/lib/queries`.

The query must scope `price_snapshots` to candidate products before taking latest-per-product — measured at 28ms that way, against 9.5ms × 77 for per-set queries.

**Tests (DB):** a set with two own shops and rivals; a set with one own shop; a set our shops carry with no rivals (`rivalCount` 0, `cheapestRival` null, `extreme` false); a set where we have no priced listing (`ourPrice` null, `extreme` false); an extreme pair modelled on `8827` (ours 8,500,000 against a rival at 397,000 → `extreme` true); a pair just under the threshold → `extreme` false. Assert the boundary from `EXTREME_GAP` rather than hardcoding 1.0.

**Verify against production** (`psql postgresql://calvin@127.0.0.1:5432/ecom_scraper`): the map covers every set an own shop carries, and set `8827` comes back `extreme: true`.

---

### Task 2: The per-product message

**Files:** modify `dashboard/src/lib/notify/format.ts`; extend `dashboard/src/lib/notify/format.test.ts`.

**Consumes:** `PriceChange` from `events.ts`, `SetPosition` from `positions.ts`, `priceChangeLink`/`absolute` from `links.ts`.

**Produces:**
- `splitByOwnSets(changes: PriceChange[], ownSetCodes: ReadonlySet<string>): { perProduct: PriceChange[]; rest: PriceChange[] }` — a change joins `perProduct` only when its `setCode` is non-null and present in the set. `perProduct` is ordered by absolute percentage change, largest first.
- `renderProductMessage(change: PriceChange, position: SetPosition | undefined, options: { baseUrl: string }): string`

**Message shape** — follow the spec's example exactly, in Indonesian:

```
📉 <name>
<shop> · <Marketplace>

Rp <prev> → Rp <now>   (−19,7%)

Kita        Rp <ourPrice>  (<ourShop>)
Termurah    Rp <cheapestRival>  dari <rivalCount> toko
→ kita TERMAHAL, selisih Rp <diff>

[posisi kita di <setCode>]
```

The arrow line states TERMURAH when our price is at or below the cheapest rival, TERMAHAL otherwise, with the absolute difference. When `ourPrice` is null the three position lines collapse to one saying we have no price on that set. When `position.extreme` is true they collapse to the spec's incomparable-comparison notice plus a link. A missing `position` (set not in the map) is treated the same as `ourPrice` null.

Reuse `escapeHtml`, `link()` and the existing money/percent formatters. A per-product message must always fit one Telegram message — assert that.

**Tests (pure):** rise; fall; we are cheapest; we are dearest; `ourPrice` null; `position` undefined; `extreme` true; a name containing `&`, `<`, `>`; the split putting null-`setCode` changes in `rest`; and the ordering being by percentage, largest first.

---

### Task 3: Two streams in the run

**Files:** modify `dashboard/src/lib/notify/run.ts`; extend `dashboard/src/lib/notify/run.test.ts`.

**Behaviour.** Inside the existing transaction, after `collectEvents`:

1. Read `ownSetPositions(tx)` once. Its keys are the own-set codes for the split.
2. Split the change list. Take at most `NOTIFY_PER_PRODUCT_MAX` from `perProduct`; the remainder joins `rest`.
3. Render one message per taken change, then the digest from `rest` plus the unchanged new-stores and new-products lists.
4. Send per-product messages first, then the digest, through the existing `sendMessages` — so a cap that bites still delivers the most significant moves.
5. Advance the watermark exactly as now. Both streams come from one event set and move together.

`NotifySettings` gains `perProductMax`, read from `NOTIFY_PER_PRODUCT_MAX` through the existing `wholeHours`-style parsing — blank, whitespace, non-integer and negative all fall back to **30**. Reuse the existing helper rather than writing a second parser; the blank-string defect it guards against is the same one.

`NotifyOutcome` gains `perProduct: number`. The digest must name how many changes spilled past the cap.

**Tests (DB):** a change on an own set producing one per-product message and no digest entry for it; a change on a non-own set producing only a digest entry; more changes than the cap, asserting the count sent and that the spilled ones are named in the digest; `NOTIFY_PER_PRODUCT_MAX` blank falling back to 30; the watermark advancing exactly as before.

**Verify against production data.** With the watermark set to snapshot 18830, the run must produce **449** price changes total, **77** in the per-product stream, **372** in the digest — the spec's benchmark table. Run it with a stub fetch so nothing reaches Telegram, and report the actual numbers.

---

## Self-Review

Spec coverage: the two streams and the set-membership filter are Task 2's split plus Task 3's wiring; the position line and its extreme case are Tasks 1 and 2; the cap and spill are Task 3; the shared `EXTREME_GAP` is Task 1. The spec's edge-case table maps onto the named tests except "nol kejadian sama sekali", which the existing suite already covers unchanged.

Type consistency: `SetPosition` is defined in Task 1 and consumed unchanged by Tasks 2 and 3; `splitByOwnSets` and `renderProductMessage` are defined in Task 2 with the signatures Task 3 calls.
