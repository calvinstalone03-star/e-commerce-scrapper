import 'server-only';

import { sql } from '@/lib/db';

/**
 * Which rival sellers moved their price on a set our own shops also sell.
 *
 * The whole notifications feature is this query. There is no event table: the
 * page is a pure derivation of `price_snapshots`, and the only stored state is
 * a marker saying how far the reader has got, which never filters anything.
 *
 * **"Baru" is not "unread", and the difference is a day.** The landing view is
 * still unfiltered, but the second tab *is* a filter, and it is an OR: a move
 * belongs there while it sits above the marker, **and also** while it is
 * younger than `graceHours`, even once the marker has passed it. It leaves only
 * once both have lapsed. That is a repair rather than a flourish — opening the
 * page POSTs the marker to the window's ceiling, so before this one refresh
 * emptied the tab outright and a move glimpsed for three seconds was gone
 * before it had been read. The bell is deliberately *not* widened to match; see
 * `unreadRivalMoves`, which still counts strictly by the marker.
 *
 * **One row per qualifying snapshot, never per product.** This is the point of
 * the shape, not a stylistic preference. An earlier draft took the newest
 * snapshot per product with `DISTINCT ON (product_ref)` and then compared that
 * one row backwards. Measured against the hosted database it returned 49 rows
 * where this form returns 57: `scraper/store.py` writes an unchanged snapshot
 * anyway once the dedupe window has passed, so a day after a rival repriced,
 * the newest capture for that listing is an unchanged one whose own 24-hour
 * comparison is the moved price — an honest 0% — and the real move, which
 * nobody had read yet, was no longer the newest row. Eight events had already
 * been buried that way. A buried event vanishes from the list AND from the
 * unread badge with no record. Per snapshot, the event set only ever grows in
 * id order, which is what gives an id-based read marker a footing at all. A
 * listing that moves twice — or that is re-reported by a capture too soon to
 * see past the move — is folded in the UI (`group.ts`), not in SQL.
 *
 * The scraper's own local database does not currently show that divergence —
 * both forms return 56 rows there today, across 56 distinct listings — which is
 * the point rather than a counter-example. Burial depends on which capture
 * happens to be newest at the moment you look, so a form that is only correct
 * when no listing has been captured since it moved is a form whose correctness
 * expires on a schedule nobody controls.
 *
 * **Why the comparison must be at least `gapHours` older.** Every consecutive
 * pair of captures 1.5 to 3.5 hours apart in this database disagrees about
 * price without anything having been repriced — 32 such pairs, and all 32
 * differ. Comparing against the immediately preceding snapshot would therefore
 * report mostly noise. This database has no consecutive pairs anywhere near 24
 * hours apart to check that specific gap against — captures jump from about 3.5
 * hours apart straight to about 3 days 6 hours apart, with nothing in between —
 * so the 24-hour figure is not one this database can confirm directly. The
 * nearest thing to a same-day control it does have is 4 days 16-18 hours apart:
 * 1,335 such pairs, of which only 3 differ, consistent with disagreement being
 * rare once captures are days apart rather than hours. `maxLookbackDays` is the
 * other end of the same argument: a listing with no predecessor inside the
 * window yields no row at all, rather than a comparison against ancient
 * history.
 *
 * **The plan, checked with `EXPLAIN (ANALYZE, BUFFERS)` against the scraper's
 * own database** — 22,121 snapshots, 18,255 products, 4,285 rival listings
 * inside our sets, 2,530 own listings with a set code. 56 rows out, 27-51ms
 * warm, all buffers hit.
 *
 * Both LATERALs are served by `ix_price_snapshots_product_ref_scraped_at`
 * (migrations/001_init.sql:94), and that is what makes one row per snapshot
 * affordable at all. `moves` drives off a sequential scan of `price_snapshots`
 * hashed against `rival_listings` — 5,302 rival snapshots in the window — and
 * then probes the index once per those, 56 surviving the threshold. `our_price`
 * probes the same index once per own listing, 2,530 times, each an index scan
 * plus a 25kB incremental sort to break a `scraped_at` tie by id.
 *
 * The scoping CTEs are `MATERIALIZED` so that the narrowing is done before
 * `price_snapshots` is touched at all: `own_sets` and `rival_listings` settle
 * which products can possibly matter, and the LATERALs then only ever walk
 * those products' history. Note what the freshness predicate is not doing yet:
 * every snapshot in this database is currently inside the 14-day window, so it
 * removes nothing and the driving scan is the whole table. That is the cheap
 * plan at this size, and the predicate is what will keep the plan bounded
 * rather than the table when it is not.
 *
 * **Money is a string end to end.** `price` is a Postgres NUMERIC and snapshot
 * ids are bigint; both arrive from postgres.js as strings and stay strings.
 * Nothing here calls `Number()` on a price — that happens once, in a formatter,
 * at the edge.
 */

export type RivalMove = {
  /** `price_snapshots.id`, a bigint — the marker compares these. */
  snapshotId: string;
  productId: number;
  name: string | null;
  setCode: string | null;
  marketplace: string;
  storeId: number | null;
  username: string | null;
  /** NUMERIC, so a string. Converted only where it is formatted. */
  price: string;
  previousPrice: string;
  scrapedAt: Date;
  previousScrapedAt: Date;
  ourPrice: string | null;
  /** null when we have no price for the set — unknown, not "no". */
  undercutsUs: boolean | null;
};

export type RivalMovesOptions = {
  /** Minimum age difference of the comparison snapshot. 24. */
  gapHours: number;
  /** Minimum relative move. 0.05. */
  threshold: number;
  /** How far back the rendered window reaches. 14. */
  windowDays: number;
  /** How stale a comparison may be before the move is not reported. 7. */
  maxLookbackDays: number;
  /**
   * The read marker, when the caller wants the page's "Baru" tab, and `null`
   * for the whole window, which is the "Semua" tab and the default landing
   * view.
   *
   * Not "everything above this id": that is only half of what the tab asks for
   * now, the other half being `graceHours`. What this field says is *where the
   * reader has got to*, and the tab decides what to do with that.
   *
   * Stated rather than optional, so a caller has to decide. This is the one
   * predicate in the feature that can hide a row, and a filter that could be
   * left off by accident is how the first draft shipped a page that rendered
   * empty on day one.
   */
  seenSnapshotId: string | null;
  /**
   * How long a move keeps its place in "Baru" after the marker has passed it,
   * measured from `scraped_at`. Whole hours — `make_interval` takes an int.
   * Defaults to `DEFAULT_GRACE_HOURS`.
   *
   * Optional where `seenSnapshotId` is stated, and the asymmetry is the point:
   * the two fields fail in opposite directions. Forgetting the marker hides
   * rows, which is the failure this feature was rebuilt to avoid. Forgetting
   * this one only ever shows *more* — the tab widens to a day's grace, which is
   * the direction the page is allowed to be wrong in.
   *
   * Ignored entirely when `seenSnapshotId` is `null`; "Semua" already shows
   * everything, so there is nothing for a grace period to rescue.
   */
  graceHours?: number;
  limit: number;
  offset: number;
};

/**
 * Everything that defines the window; what both exports must agree on.
 *
 * `seenSnapshotId` is omitted alongside `limit` and `offset`, and that omission
 * is the important one. The ceiling exists to say how far the marker may
 * advance; a ceiling taken over rows already filtered *by* the marker would be a
 * ceiling that could never move past the marker's own position, and the rows
 * above it would be stranded. The type says so, and `qualifyingMoves` never
 * reads the field regardless — the marker predicate lives in `rivalMoves`'s
 * outer SELECT, not in the shared fragment.
 *
 * `graceHours` is omitted for the same reason and travels with the marker
 * rather than with the window: it is the other half of one predicate, in the
 * same outer SELECT. Inside the shared fragment it would widen the ceiling and
 * the bell too, and the bell is the one thing this grace period must not touch.
 */
export type RivalMovesWindow = Omit<
  RivalMovesOptions,
  'limit' | 'offset' | 'seenSnapshotId' | 'graceHours'
>;

/**
 * The window the page renders and the marker advances over — one constant, read
 * by both.
 *
 * Not a default parameter and not two copies. `/api/notifications/seen` moves
 * the marker to `rivalMovesCeiling` of *this* window, and the page renders
 * `rivalMoves` over *this* window; if those two ever named different windows the
 * marker would jump past rows the page can still show, and the rows it stranded
 * would be exactly the ones nobody had read. The invariant is "same window", so
 * it is stated as one value rather than as two matching literals.
 *
 * The numbers themselves are the design's, and one of them is measured to be
 * nearly inert: the query was run at 1, 6, 12, 24, 48 and 72 hours against the
 * scraper's database and returned the same 56 rows every time — it first moves
 * at 96 hours (55). What binds is not `gapHours` but the scrape spacing, and in
 * those 56 rows the comparison actually chosen ranges from 78 to 140 hours old.
 * `gapHours` is a floor against the noise between captures a few hours apart —
 * 32 consecutive pairs 1.5 to 3.5 hours apart, all 32 disagreeing about price —
 * not a description of what a row compares against. That is why every row on the
 * page states its own real comparison age instead of claiming "24 jam".
 */
export const DEFAULT_WINDOW: RivalMovesWindow = {
  gapHours: 24,
  threshold: 0.05,
  windowDays: 14,
  maxLookbackDays: 7,
};

/**
 * How long "Baru" holds on to a move after it has been read. A day, as asked
 * for.
 *
 * Deliberately **not** a fifth field of `DEFAULT_WINDOW`, even though it is the
 * same kind of number. That constant is the shared definition of the window
 * `rivalMoves` renders and `rivalMovesCeiling` advances the marker over, and its
 * whole job is to be the same value in both places. This is not part of that
 * window: it belongs to one tab of one page, `rivalMovesCeiling` and
 * `unreadRivalMoves` must not see it, and the type keeps them from doing so.
 */
export const DEFAULT_GRACE_HOURS = 24;

/**
 * Past this the unread count stops counting and says "99+".
 *
 * Shared for the same reason as the window above, and it is not a style point:
 * the bell in the topbar and the count on the page's "Baru" tab are two
 * renderings of one number, on screen at the same time. Two constants that
 * happen to be equal would show 99+ next to 120 the day one of them was changed.
 */
export const BADGE_CAP = 99;

type Row = {
  id: string;
  product_ref: number;
  name: string | null;
  set_code: string | null;
  marketplace: string;
  shop_ref: number | null;
  username: string | null;
  price: string;
  previous_price: string;
  scraped_at: Date;
  previous_scraped_at: Date;
  our_price: string | null;
  undercuts_us: boolean | null;
};

/**
 * The window, as a fragment both exports splice in unchanged.
 *
 * Shared rather than copied because `rivalMovesCeiling` is only well-founded if
 * it counts exactly the rows `rivalMoves` can return. Two hand-kept copies of
 * this SQL would drift, and the drift would show up as rows the reader can see
 * but the marker skips past — or worse, silently strands.
 */
function qualifyingMoves({ gapHours, threshold, windowDays, maxLookbackDays }: RivalMovesWindow) {
  return sql`
    WITH own_sets AS MATERIALIZED (
      -- Every set_code an is_own shop carries. Membership, not prices: a set we
      -- list but have never had a price for still makes a rival's move on it
      -- our business.
      SELECT DISTINCT p.set_code
        FROM products p
        JOIN stores s ON s.id = p.shop_ref
       WHERE s.is_own AND p.set_code IS NOT NULL
    ),
    rival_listings AS MATERIALIZED (
      -- Every listing that is not ours on one of those sets. Computed before
      -- price_snapshots is touched, so the LATERAL below only ever walks these
      -- products' history.
      SELECT p.id, p.set_code, p.name, p.marketplace, p.shop_ref, s.username
        FROM products p
        JOIN own_sets o ON o.set_code = p.set_code
        JOIN stores s ON s.id = p.shop_ref
       WHERE NOT s.is_own
    ),
    own_listings AS MATERIALIZED (
      SELECT p.id, p.set_code
        FROM products p
        JOIN stores s ON s.id = p.shop_ref
       WHERE s.is_own AND p.set_code IS NOT NULL
    ),
    our_price AS MATERIALIZED (
      -- What we charge for the set today: the cheapest of our shops' current
      -- prices. No channel split, deliberately — the question a notification
      -- answers is "has someone gone under us on this set, anywhere", so the
      -- cheaper of our two shops is the one being undercut.
      --
      -- A LATERAL per own listing rather than a DISTINCT ON over their pooled
      -- history: same index, and it keeps this file to one idiom.
      SELECT ol.set_code, min(latest.price) AS price
        FROM own_listings ol
        CROSS JOIN LATERAL (
          SELECT o.price
            FROM price_snapshots o
           WHERE o.product_ref = ol.id
             AND o.price IS NOT NULL
           ORDER BY o.scraped_at DESC, o.id DESC
           LIMIT 1
        ) latest
       GROUP BY ol.set_code
    ),
    moves AS (
      SELECT ps.id, ps.product_ref, ps.price, ps.scraped_at,
             older.price AS previous_price, older.scraped_at AS previous_scraped_at
        FROM price_snapshots ps
        JOIN rival_listings r ON r.id = ps.product_ref
        CROSS JOIN LATERAL (
          -- The newest capture at least gapHours older, and no older than
          -- maxLookbackDays. CROSS JOIN, not LEFT: a listing with no such
          -- predecessor has nothing to be a move against, and dropping it here
          -- is cheaper than carrying a NULL through the division below.
          --
          -- The o.price > 0 test rather than a nullif afterwards: it takes the bad
          -- datum out of consideration entirely, instead of turning the
          -- division into a NULL that some later predicate has to remember to
          -- handle.
          --
          -- The id tiebreak matches the our_price LATERAL above. Nothing in the
          -- live data ties on (product_ref, scraped_at) today, but rivalMoves
          -- and rivalMovesCeiling are separate queries over this same fragment:
          -- an undetermined pick could hand them different predecessors for one
          -- snapshot, and the two would then disagree about whether it moved 5%.
          SELECT o.price, o.scraped_at
            FROM price_snapshots o
           WHERE o.product_ref = ps.product_ref
             AND o.price IS NOT NULL
             AND o.price > 0
             AND o.scraped_at <= ps.scraped_at - make_interval(hours => ${gapHours})
             AND o.scraped_at >= ps.scraped_at - make_interval(days => ${maxLookbackDays})
           ORDER BY o.scraped_at DESC, o.id DESC
           LIMIT 1
        ) older
       WHERE ps.price IS NOT NULL
         AND ps.scraped_at > now() - make_interval(days => ${windowDays})
         AND abs(ps.price - older.price) / older.price >= ${threshold}
    )`;
}

/**
 * One page of the window.
 *
 * Ordered by consequence rather than by time: a rival who has gone under our
 * price first, then by the size of the move, and only then by id. `NULLS LAST`
 * on the first key puts the sets we have no price for after the ones we know we
 * are still winning — an unknown is not evidence of anything.
 *
 * `seenSnapshotId` is the page's second tab and the **only** predicate here that
 * depends on read state. It sits in this outer SELECT rather than in
 * `qualifyingMoves` for a reason that is easy to undo by accident: the shared
 * fragment is what `rivalMovesCeiling` counts over, and a marker predicate
 * inside it would cap the ceiling at the marker and strand everything above.
 *
 * **That predicate is an OR, and both halves are load-bearing.** A move is in
 * "Baru" while it is unread, and *also* while it is younger than `graceHours`
 * even after it has been read; it leaves only when both have lapsed. An AND
 * would be the old behaviour with extra steps, and dropping either disjunct
 * restores a bug that was reported rather than imagined: the page marks the
 * whole window read on arrival, so with only `m.id > marker` one refresh emptied
 * the tab, and with only the age test a backlog older than a day would never
 * appear in it at all.
 *
 * **The day is anchored to `scraped_at`, not to a per-row "first seen" stamp.**
 * There is no such column and adding one would mean storing a row per event, in
 * a feature whose entire shape is that it stores none — so the capture time
 * stands in for "when this could first have been read". That substitution is
 * only sound because id order and time order agree here, which was checked
 * rather than assumed: **zero of 28,287 snapshots on the live Neon database
 * have a `scraped_at` older than any lower-id predecessor**. Because they agree,
 * nothing above the marker is older than anything below it, so the two
 * disjuncts nest — the tab is always a contiguous run in id order, rows leave it
 * oldest-first, and none of them comes back. If a backfill, an import or a clock
 * skew ever lands a snapshot whose `scraped_at` predates a lower id, **this
 * predicate is what breaks**: a row already scrolled past would re-enter "Baru"
 * out of order and sit there for a day, and the tab would stop being a run and
 * start being a scatter.
 */
export async function rivalMoves(opts: RivalMovesOptions): Promise<RivalMove[]> {
  const graceHours = opts.graceHours ?? DEFAULT_GRACE_HOURS;
  const rows = await sql<Row[]>`
    ${qualifyingMoves(opts)}
    SELECT m.id,
           m.product_ref,
           r.name,
           r.set_code,
           r.marketplace,
           r.shop_ref,
           r.username,
           m.price,
           m.previous_price,
           m.scraped_at,
           m.previous_scraped_at,
           op.price            AS our_price,
           (m.price < op.price) AS undercuts_us
      FROM moves m
      JOIN rival_listings r ON r.id = m.product_ref
      LEFT JOIN our_price op ON op.set_code = r.set_code
     WHERE ${
       opts.seenSnapshotId === null
         ? sql`true`
         : sql`(m.id > ${opts.seenSnapshotId}::bigint
                OR m.scraped_at > now() - make_interval(hours => ${graceHours}))`
     }
     ORDER BY (m.price < op.price) DESC NULLS LAST,
              abs(m.price - m.previous_price) / m.previous_price DESC,
              m.id DESC
     LIMIT ${opts.limit} OFFSET ${opts.offset}`;

  return rows.map((row) => ({
    snapshotId: String(row.id),
    productId: row.product_ref,
    name: row.name,
    setCode: row.set_code,
    marketplace: row.marketplace,
    storeId: row.shop_ref,
    username: row.username,
    price: String(row.price),
    previousPrice: String(row.previous_price),
    scrapedAt: row.scraped_at,
    previousScrapedAt: row.previous_scraped_at,
    ourPrice: row.our_price === null ? null : String(row.our_price),
    undercutsUs: row.undercuts_us,
  }));
}

/**
 * The largest snapshot id in the **complete** window — no limit, no offset, no
 * user filter.
 *
 * Its own function, taking `RivalMovesWindow` — `RivalMovesOptions` with `limit`
 * and `offset` omitted. That omission does not, by itself, stop a caller from
 * handing it a full `RivalMovesOptions`: TypeScript's excess-property check only
 * fires on a fresh object literal, and a variable of the wider type (this file's
 * own tests pass `DEFAULTS`, `limit` and all) is structurally assignable without
 * complaint. The actual guarantee lives in the body: `qualifyingMoves`
 * destructures only `gapHours`, `threshold`, `windowDays` and `maxLookbackDays`
 * off `opts`, and the SQL it builds has no `LIMIT` or `OFFSET` clause at all —
 * so a `limit`/`offset` a caller happens to include rides along on the object
 * but is never read. The read marker advances to exactly this value; advancing
 * it to the maximum of a displayed page instead would jump the marker past rows
 * further down that same window and strand them as permanently unread, because
 * the feed is ordered by consequence and "what was shown" is therefore not a
 * prefix of id order.
 *
 * Advancing over the complete window is also what turns the page's row cap into
 * a real limit rather than a display one, and that is a cost rather than a
 * defence. `(app)/notifications/page.tsx` prints the top `PAGE_LIMIT` rows and
 * has no pager, so a row ranked past the cap is never rendered — and since the
 * marker moved over the whole window anyway, `unreadRivalMoves` stops counting it
 * too. The marker keeps its promise for every row the reader can reach; the cap
 * is what decides which rows those are, and pagination is what would fix it.
 *
 * `null` when nothing in the window qualifies, which the caller must treat as
 * "leave the marker where it is". Not 0 — 0 is a legitimate starting marker,
 * and conflating the two would rewind it.
 */
export async function rivalMovesCeiling(opts: RivalMovesWindow): Promise<string | null> {
  const [row] = await sql<{ ceiling: string | null }[]>`
    ${qualifyingMoves(opts)}
    SELECT max(m.id) AS ceiling FROM moves m`;

  return row.ceiling === null ? null : String(row.ceiling);
}

/** How many unread moves there are, and whether that number stopped early. */
export type UnreadRivalMoves = { count: number; capped: boolean };

/**
 * What the bell says.
 *
 * Its own query rather than `rivalMoves(...).length`, because of where it is
 * called from: `(app)/layout.tsx` wraps **every** signed-in page, so this runs
 * on the overview, on the product table, on settings. Fetching the feed to count
 * it would put the page's whole cost on every screen in the app, ordering
 * included, to render a two-digit number.
 *
 * **Strictly `id > marker`, and it does not get the "Baru" tab's day of grace.**
 * The two numbers are allowed to disagree, and that is the decision rather than
 * an oversight: the bell has to be able to reach zero the moment the page is
 * opened, because a badge that keeps nagging for a day after it has been
 * answered is a badge people stop looking at. The tab may then list rows while
 * the bell reads 0 — `(app)/notifications/page.tsx` says so in words, because
 * otherwise it reads as a bug.
 *
 * Bounded twice over, and the two bounds are not the same bound. `LIMIT cap + 1`
 * bounds the *work*: `moves` is a plain CTE, so Postgres inlines it and the
 * `Limit` node sits directly over the nested loop, free to stop once enough rows
 * exist. `capped` bounds the *claim*: past the cap the honest answer is "at least
 * this many", which is what a "99+" badge says, and it keeps the number on screen
 * independent of how big the backlog got.
 *
 * Only the second of those is observable from the return value, so only the
 * second is what the tests assert. The first was checked with `EXPLAIN (ANALYZE,
 * BUFFERS)` against the scraper's own database — 22,121 snapshots — rather than
 * asserted: **33.6ms**, and the `Limit` node reports 56 rows, which is every
 * qualifying move there is. So the cap does not bind today and this is simply the
 * cost of the feed's `WHERE` clause without its ordering; it starts paying for
 * itself when the backlog passes 99.
 *
 * That same plan confirms the other half of the reasoning. The `our_price` CTE is
 * unreferenced from here and does not appear in the plan at all, and
 * `own_listings` appears but is reported "never executed" — Postgres does not
 * evaluate an unreferenced CTE. The 2,530 index probes that decide *undercutting*
 * are the expensive half of the feed's plan, and they are not paid for on every
 * page load. That falls out of reusing the shared fragment rather than being
 * arranged, but it is what makes reusing it affordable.
 *
 * Takes the marker rather than reading it, so the clamp in `readSeen` stays the
 * one definition of what the marker means. A caller with a raw
 * `last_seen_snapshot_id` from after a destructive mirror would otherwise count
 * against an id no row can reach and report a permanent zero.
 */
export async function unreadRivalMoves(
  opts: RivalMovesWindow,
  sinceSnapshotId: string,
  cap: number,
): Promise<UnreadRivalMoves> {
  const [row] = await sql<{ count: number }[]>`
    ${qualifyingMoves(opts)}
    SELECT count(*)::int AS count
      FROM (
        SELECT 1
          FROM moves m
         WHERE m.id > ${sinceSnapshotId}::bigint
         LIMIT ${cap + 1}
      ) bounded`;

  return { count: Math.min(row.count, cap), capped: row.count > cap };
}
