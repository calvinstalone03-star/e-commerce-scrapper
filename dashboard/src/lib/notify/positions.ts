import 'server-only';

import type { Sql } from '@/lib/notify/watermark';
import { isExtremeGap } from '@/lib/queries';

/**
 * Where we stand on every set an own shop sells, computed once for all of
 * them rather than once per set.
 *
 * "Once for all of them" is the point, not an incidental optimisation.
 * Scoping `price_snapshots` to the candidate products — our own listings in
 * these sets, and every rival listing that shares one of their `set_code`s —
 * before `DISTINCT ON (product_ref)` picks the newest price, rather than
 * taking the newest price for the whole table and filtering after, is what
 * makes this cheap: measured at 28ms for every own set at once, against
 * 9.5ms asked per set (77 sets the naive way, so 9.5ms x 77).
 *
 * What that scoping actually buys, checked with `EXPLAIN (ANALYZE, BUFFERS)`
 * against production: Postgres answers `latest` with a sequential scan of
 * the whole `price_snapshots` table (19,796 rows — cheap at this size)
 * hashed and probed by `candidates` (6,681 rows), not an index or bitmap
 * scan on `ix_price_snapshots_product_ref_scraped_at`
 * (migrations/001_init.sql:94). That is the right plan today: reading a
 * 19,796-row table once beats thousands of individual index probes. The win
 * is not less I/O, it is less downstream work — the sort, dedup and
 * grouping after `latest` process about 6,681 candidate rows, not one row
 * per product in the whole catalogue. It also leaves the planner a way out
 * as `price_snapshots` keeps growing and a full scan stops being the cheap
 * choice: it can switch to the index without this query changing, an option
 * an unscoped `DISTINCT ON` over every product's history would not have.
 *
 * No channel parameter, unlike `ourListings` in `queries.ts`. The dashboard
 * needs that split because the Shopee shop and the Tokopedia shop list the
 * same catalogue, and a channel screen must not blend their figures. A
 * per-product Telegram message asks a different question — are we priced
 * right on this set, anywhere — so the cheapest own listing wins regardless
 * of which of our shops carries it.
 */

export type SetPosition = {
  setCode: string;
  /** NUMERIC, so a string. Converted only where it is formatted. */
  ourPrice: string | null;
  ourShop: string | null;
  cheapestRival: string | null;
  rivalCount: number;
  extreme: boolean;
};

export async function ownSetPositions(tx: Sql): Promise<Map<string, SetPosition>> {
  const rows = await tx<
    {
      set_code: string;
      our_price: string | null;
      our_shop: string | null;
      cheapest_rival: string | null;
      rival_count: string;
    }[]
  >`
    WITH own_sets AS MATERIALIZED (
      -- Every set_code any is_own shop carries, priced or not: the row this
      -- query returns per set, and the membership the per-product split
      -- filters change events on.
      SELECT DISTINCT p.set_code
        FROM products p
        JOIN stores s ON s.id = p.shop_ref
       WHERE s.is_own AND p.set_code IS NOT NULL
    ),
    candidates AS MATERIALIZED (
      -- Both sides of every comparison this query can need: our own listings
      -- in these sets, and every rival listing that shares one of them.
      -- Computed before price_snapshots is touched at all, so the DISTINCT
      -- ON below only ever walks these products' history.
      SELECT p.id AS product_id, p.set_code, s.is_own, s.username
        FROM products p
        JOIN own_sets o ON o.set_code = p.set_code
        JOIN stores s ON s.id = p.shop_ref
    ),
    latest AS MATERIALIZED (
      SELECT DISTINCT ON (ps.product_ref) ps.product_ref, ps.price
        FROM price_snapshots ps
        JOIN candidates c ON c.product_id = ps.product_ref
       WHERE ps.price IS NOT NULL
       ORDER BY ps.product_ref, ps.scraped_at DESC, ps.id DESC
    ),
    priced AS MATERIALIZED (
      SELECT c.set_code, c.is_own, c.username, l.price
        FROM candidates c
        JOIN latest l ON l.product_ref = c.product_id
    ),
    agg AS MATERIALIZED (
      SELECT set_code,
             min(price) FILTER (WHERE is_own)                                  AS our_price,
             (array_agg(username ORDER BY price ASC, username ASC)
               FILTER (WHERE is_own))[1]                                       AS our_shop,
             min(price) FILTER (WHERE NOT is_own)                              AS cheapest_rival,
             count(*) FILTER (WHERE NOT is_own)                                AS rival_count
        FROM priced
       GROUP BY set_code
    )
    SELECT o.set_code,
           a.our_price,
           a.our_shop,
           a.cheapest_rival,
           coalesce(a.rival_count, 0) AS rival_count
      FROM own_sets o
      LEFT JOIN agg a ON a.set_code = o.set_code`;

  const positions = new Map<string, SetPosition>();
  for (const row of rows) {
    const ourPrice = row.our_price === null ? null : String(row.our_price);
    const cheapestRival = row.cheapest_rival === null ? null : String(row.cheapest_rival);
    positions.set(row.set_code, {
      setCode: row.set_code,
      ourPrice,
      ourShop: row.our_shop,
      cheapestRival,
      rivalCount: Number(row.rival_count),
      // The shared rule, not a copy of it — see `isExtremeGap` for why the
      // denominator is the smaller price and why a zero is excluded before
      // the division. The dashboard's own JS caller decides it the same way,
      // through the same function.
      extreme: isExtremeGap(
        ourPrice === null ? null : Number(ourPrice),
        cheapestRival === null ? null : Number(cheapestRival),
      ),
    });
  }
  return positions;
}
