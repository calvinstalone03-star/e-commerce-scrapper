import 'server-only';

import { unstable_cache } from 'next/cache';
import type { PendingQuery, Row, TransactionSql } from 'postgres';
import { cache } from 'react';

import type { Channel } from '@/lib/channel';
import { sql } from '@/lib/db';
import {
  filterOptionsSchema,
  overviewSchema,
  ownShopSchema,
  ownShopScorecardSchema,
  pricePointSchema,
  pricePositionRowSchema,
  pricePositionSummarySchema,
  pricingAnalyticsSchema,
  productRowSchema,
  rivalRowSchema,
  storeRowSchema,
  type FilterOptions,
  type Overview,
  type OwnShop,
  type OwnShopScorecard,
  type PricePoint,
  type PricePositionFilter,
  type PricePositionRow,
  type PricePositionSummary,
  type PricingAnalytics,
  type ProductFilter,
  type ProductRow,
  type RivalRow,
  type StoreFilter,
  type StoreRow,
} from '@/lib/schemas';

/**
 * Every read the dashboard performs.
 *
 * The one query that matters for latency is "the latest snapshot per product".
 * `price_snapshots` is append-only, so every list view needs the newest row per
 * product and nothing else. That is expressed as `DISTINCT ON (product_ref)
 * ORDER BY product_ref, scraped_at DESC`, which Postgres answers straight from
 * the existing `(product_ref, scraped_at DESC)` index — no window function, no
 * sort of the whole table. A correlated subquery per row, or fetching all
 * snapshots and picking in JS, both look fine on 128 rows and fall over at
 * 100k.
 *
 * Results are validated with the same Zod schemas the client uses, so a schema
 * change on the Python side surfaces here as a parse error naming the column
 * rather than as undefined leaking into the UI.
 */

/** Newest snapshot per product. Composed into most other queries. */
const latestSnapshots = sql`
  SELECT DISTINCT ON (product_ref)
    product_ref, price, sold, rating_star, scraped_at
  FROM price_snapshots
  ORDER BY product_ref, scraped_at DESC, id DESC
`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<Overview> {
  const [totals, byMarketplace, latest] = await Promise.all([
    sql`
      SELECT
        (SELECT count(*) FROM stores)                        AS stores,
        (SELECT count(*) FROM products)                      AS products,
        (SELECT count(*) FROM price_snapshots)               AS snapshots
    `,
    sql`
      SELECT s.marketplace,
             count(DISTINCT s.id) AS stores,
             count(DISTINCT p.id) AS products
      FROM stores s
      LEFT JOIN products p ON p.shop_ref = s.id
      GROUP BY s.marketplace
      ORDER BY s.marketplace
    `,
    sql`SELECT max(scraped_at) AS last_scraped_at FROM price_snapshots`,
  ]);

  return overviewSchema.parse({
    ...totals[0],
    marketplaces: byMarketplace,
    lastScrapedAt: latest[0]?.last_scraped_at ?? null,
  });
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export async function getStores(
  filter: StoreFilter,
): Promise<{ rows: StoreRow[]; total: number }> {
  const offset = (filter.page - 1) * filter.pageSize;

  // Built as fragments rather than string concatenation: postgres.js
  // parameterises these, so a location containing a quote is data, not SQL.
  const where = sql`
    WHERE TRUE
    ${filter.marketplace ? sql`AND s.marketplace = ${filter.marketplace}` : sql``}
    ${filter.location ? sql`AND s.location = ${filter.location}` : sql``}
    ${
      filter.q
        ? sql`AND (s.username ILIKE ${'%' + filter.q + '%'} OR s.name ILIKE ${'%' + filter.q + '%'})`
        : sql``
    }
  `;

  const orderBy =
    filter.sort === 'name'
      ? sql`ORDER BY coalesce(s.name, s.username) ${filter.dir === 'asc' ? sql`ASC` : sql`DESC`}`
      : // Quoted, because the SELECT list aliases these as camelCase. Postgres
        // folds an unquoted identifier to lowercase, so `avg_price` and
        // `product_count` can never resolve to `"avgPrice"` / `"productCount"`
        // — and `products` is the default sort, so this was the common path.
        filter.sort === 'avgPrice'
        ? sql`ORDER BY "avgPrice" ${filter.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`}`
        : sql`ORDER BY "productCount" ${filter.dir === 'asc' ? sql`ASC` : sql`DESC`}`;

  const [rows, counted] = await Promise.all([
    sql`
      WITH latest AS (${latestSnapshots})
      SELECT
        s.id, s.marketplace, s.shop_id AS "shopId", s.username, s.name, s.location,
        s.last_seen AS "lastSeen",
        count(DISTINCT p.id)  AS "productCount",
        min(l.price)          AS "minPrice",
        max(l.price)          AS "maxPrice",
        round(avg(l.price))   AS "avgPrice",
        sum(l.sold)           AS "totalSold"
      FROM stores s
      LEFT JOIN products p ON p.shop_ref = s.id
      LEFT JOIN latest   l ON l.product_ref = p.id
      ${where}
      GROUP BY s.id
      -- The trailing s.id is the tiebreak, and it is not decoration: none of the
      -- sort keys above is unique, and an ORDER BY that leaves rows tied leaves
      -- Postgres free to return them in a different order on the next execution.
      -- Under LIMIT/OFFSET that is a paging bug — a shop can appear on both page
      -- 1 and page 2 while another is never shown at all.
      ${orderBy}, s.id ASC
      LIMIT ${filter.pageSize} OFFSET ${offset}
    `,
    sql`SELECT count(*) AS total FROM stores s ${where}`,
  ]);

  return {
    rows: rows.map((row) => storeRowSchema.parse(row)),
    total: Number(counted[0].total),
  };
}

export async function getStore(id: number): Promise<StoreRow | null> {
  const rows = await sql`
    WITH latest AS (${latestSnapshots})
    SELECT
      s.id, s.marketplace, s.shop_id AS "shopId", s.username, s.name, s.location,
      s.last_seen AS "lastSeen",
      count(DISTINCT p.id) AS "productCount",
      min(l.price)         AS "minPrice",
      max(l.price)         AS "maxPrice",
      round(avg(l.price))  AS "avgPrice",
      sum(l.sold)          AS "totalSold"
    FROM stores s
    LEFT JOIN products p ON p.shop_ref = s.id
    LEFT JOIN latest   l ON l.product_ref = p.id
    WHERE s.id = ${id}
    GROUP BY s.id
  `;
  return rows.length ? storeRowSchema.parse(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function getProducts(
  filter: ProductFilter,
): Promise<{ rows: ProductRow[]; total: number }> {
  const offset = (filter.page - 1) * filter.pageSize;

  const where = sql`
    WHERE TRUE
    ${filter.marketplace ? sql`AND p.marketplace = ${filter.marketplace}` : sql``}
    ${filter.storeId ? sql`AND p.shop_ref = ${filter.storeId}` : sql``}
    ${filter.location ? sql`AND s.location = ${filter.location}` : sql``}
    ${filter.q ? sql`AND p.name ILIKE ${'%' + filter.q + '%'}` : sql``}
    ${filter.minPrice !== undefined ? sql`AND l.price >= ${filter.minPrice}` : sql``}
    ${filter.maxPrice !== undefined ? sql`AND l.price <= ${filter.maxPrice}` : sql``}
    ${filter.minSold !== undefined ? sql`AND l.sold >= ${filter.minSold}` : sql``}
    ${filter.minRating !== undefined ? sql`AND l.rating_star >= ${filter.minRating}` : sql``}
    ${filter.hasImage ? sql`AND p.image IS NOT NULL AND p.image <> ''` : sql``}
  `;

  const direction = filter.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  const orderBy =
    filter.sort === 'price'
      ? sql`ORDER BY l.price ${direction}`
      : filter.sort === 'rating'
        ? sql`ORDER BY l.rating_star ${direction}`
        : filter.sort === 'name'
          ? sql`ORDER BY p.name ${direction}`
          : filter.sort === 'scrapedAt'
            ? sql`ORDER BY l.scraped_at ${direction}`
            : sql`ORDER BY l.sold ${direction}`;

  const [rows, counted] = await Promise.all([
    sql`
      WITH latest AS (${latestSnapshots})
      SELECT
        p.id, p.marketplace, p.item_id AS "itemId", p.name, p.url, p.image,
        s.id       AS "storeId",
        s.username AS "storeUsername",
        s.location AS "storeLocation",
        l.price, l.sold, l.rating_star AS "ratingStar", l.scraped_at AS "scrapedAt",
        (SELECT count(*) FROM price_snapshots ps WHERE ps.product_ref = p.id)
          AS "snapshotCount"
      FROM products p
      LEFT JOIN stores s ON s.id = p.shop_ref
      LEFT JOIN latest l ON l.product_ref = p.id
      ${where}
      -- Unique tiebreak, so a page boundary cannot duplicate or swallow a row.
      -- Ties are the norm here rather than the exception: sold and rating_star
      -- repeat across most of the table.
      ${orderBy}, p.id ASC
      LIMIT ${filter.pageSize} OFFSET ${offset}
    `,
    sql`
      WITH latest AS (${latestSnapshots})
      SELECT count(*) AS total
      FROM products p
      LEFT JOIN stores s ON s.id = p.shop_ref
      LEFT JOIN latest l ON l.product_ref = p.id
      ${where}
    `,
  ]);

  return {
    rows: rows.map((row) => productRowSchema.parse(row)),
    total: Number(counted[0].total),
  };
}



/** Every observation of one product, oldest first, for the history chart. */
export async function getPriceHistory(productId: number): Promise<PricePoint[]> {
  const rows = await sql`
    SELECT scraped_at AS "scrapedAt", price, sold, rating_star AS "ratingStar"
    FROM price_snapshots
    WHERE product_ref = ${productId}
    -- Two snapshots of one product can share a timestamp; id decides which of
    -- them the line visits first instead of leaving it to the planner.
    ORDER BY scraped_at ASC, id ASC
  `;
  return rows.map((row) => pricePointSchema.parse(row));
}

// ---------------------------------------------------------------------------
// Price position
// ---------------------------------------------------------------------------

/**
 * How close two titles must read before they count as the same product.
 *
 * Only ever consulted for listings carrying no set number — accessories,
 * bundles, the knock-offs that never print one. 0.45 is deliberately stricter
 * than pg_trgm's own 0.3 default: at 0.3 "Mainan Balok Edukasi Anak" matches
 * half the marketplace, and a comparison screen full of confident nonsense is
 * worse than one that admits it has no rival to show.
 */
const NAME_MATCH_THRESHOLD = 0.45;

/**
 * A price ratio past which the pairing is a packaging difference, not a
 * position: 1.0 means "double, or half". Expressed as a ratio rather than a
 * percentage because that is what the SQL compares.
 *
 * Exported so `lib/notify/positions.ts` imports this exact constant rather
 * than copying the literal. Two thresholds with one name is how the
 * dashboard and the notifier would come to silently disagree about which
 * comparisons are trustworthy.
 */
export const EXTREME_GAP = 1.0;

/**
 * Our products beside their rivals'.
 *
 * The join is on `set_code` wherever both sides have one. That is the whole
 * design: a LEGO set number is an exact identity, so two listings sharing one
 * are the same box no matter how differently the sellers describe it, and
 * `42217` never matches `42218` however similar the words around them read.
 *
 * `%` before `similarity()` in the name fallback is not redundant — `%` is the
 * operator the GIN trigram index answers, and it prunes the candidate set
 * before the exact score is computed on what survives.
 */
/**
 * Runs one query with the trigram threshold the name matching compares on.
 *
 * `%` is the operator the GIN index answers, and it answers it at whatever
 * `pg_trgm.similarity_threshold` says — 0.3 by default, which is not what
 * `NAME_MATCH_THRESHOLD` means. The answer is the same either way, because every
 * pairing is also filtered by an explicit `similarity() >= 0.45`; what changes is
 * who does the work. At 0.3 the index hands over every loosely-similar title and
 * the filter throws most of them away: measured on 12k listings, 22s instead of
 * 7s for the same rows.
 *
 * This used to be a connection-level startup parameter, which is both cheaper
 * and unusable: Neon's pooled endpoint refuses the connection over it
 * ("unsupported startup parameter in options"), and a pooled connection is the
 * only kind a serverless deployment should hold. `SET LOCAL` inside a
 * transaction is the form a pooler in transaction mode honours — it is scoped to
 * the transaction, so the connection goes back to the pool exactly as it came
 * out, and the next client to borrow it is unaffected.
 *
 * Exported so a test can pin both halves of that: the threshold in force where
 * the matching happens, and nothing left behind afterwards.
 */
export function withNameMatching<T>(
  run: (tx: TransactionSql) => Promise<T> | PendingQuery<Row[]>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // `SET` takes no bind parameters, so the value is interpolated — it is a
    // numeric constant in this file, never anything from a request.
    await tx.unsafe(`SET LOCAL pg_trgm.similarity_threshold = ${NAME_MATCH_THRESHOLD}`);
    return run(tx);
  }) as Promise<T>;
}

const rivalMatch = sql`
  (
    (m.set_code IS NOT NULL AND r.set_code = m.set_code)
    OR (
      m.set_code IS NULL
      AND m.name IS NOT NULL
      AND r.name % m.name
      AND similarity(r.name, m.name) >= ${NAME_MATCH_THRESHOLD}
    )
  )
`;

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

/** Everyone else's, priced. A rival with no price cannot undercut anyone. */
const theirProducts = sql`
  SELECT p.id, p.marketplace, p.name, p.url, p.image, p.set_code,
         s.id AS store_id, s.username AS store_username, s.name AS store_name,
         l.price, l.sold, l.rating_star, l.scraped_at
  FROM products p
  JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
  JOIN latest l ON l.product_ref = p.id
  WHERE l.price IS NOT NULL
`;

/**
 * Shops marked ours. Empty means the screen has nothing to stand on.
 *
 * `React.cache()`-wrapped: every scoped screen calls this once in the layout
 * (to build the shop switcher) and again in the page itself, and without the
 * wrapper that is the same query twice per request for two callers that were
 * always going to agree.
 */
export const getOwnShops = cache(async (): Promise<OwnShop[]> => {
  const rows = await sql`
    SELECT s.id, s.marketplace, s.username, s.name,
           count(p.id) AS products
    FROM stores s
    LEFT JOIN products p ON p.shop_ref = s.id
    WHERE s.is_own
    GROUP BY s.id, s.marketplace, s.username, s.name
    ORDER BY products DESC, s.username
  `;
  return rows.map((row) => ownShopSchema.parse(row));
});

export async function getPricePositions(
  channel: Channel,
  filter: PricePositionFilter,
): Promise<{ rows: PricePositionRow[]; total: number; summary: PricePositionSummary }> {
  const offset = (filter.page - 1) * filter.pageSize;

  const where = sql`
    WHERE TRUE
    ${
      // One box searches both ways a person identifies a product: the words on
      // it, and the number printed on the corner. A set number typed in full is
      // an exact hit; a partial one still narrows, which is what makes typing
      // "712" while looking for 71049 useful rather than empty.
      filter.q
        ? sql`AND (
            b.name ILIKE ${'%' + filter.q + '%'}
            OR b.set_code LIKE ${filter.q + '%'}
          )`
        : sql``
    }
    ${filter.minRivals !== undefined ? sql`AND b.rivals >= ${filter.minRivals}` : sql``}
    ${
      filter.matched === 'none'
        ? sql`AND b.rivals = 0`
        : filter.matched === 'set'
          ? sql`AND b.rivals > 0 AND b.set_code IS NOT NULL`
          : filter.matched === 'name'
            ? sql`AND b.rivals > 0 AND b.set_code IS NULL`
            : sql``
    }
    ${
      // Extreme gaps are a packaging artefact far more often than a pricing
      // mistake — one set number spans a single minifigure and a box of sixty.
      // A row with no rival has no gap and is not extreme, so it stays.
      filter.extreme === 'hide'
        ? sql`AND (b.gap_ratio IS NULL OR b.gap_ratio < ${EXTREME_GAP})`
        : sql``
    }
    ${
      // A stance is a claim about our price against the cheapest rival, so it
      // only means anything where both exist.
      filter.stance === 'over'
        ? sql`AND b.price > b.cheapest_price`
        : filter.stance === 'under'
          ? sql`AND b.price < b.cheapest_price`
          : filter.stance === 'equal'
            ? sql`AND b.price = b.cheapest_price`
            : sql``
    }
  `;

  const direction = filter.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  const orderBy =
    filter.sort === 'name'
      ? sql`ORDER BY f.name ${direction}`
      : filter.sort === 'price'
        ? sql`ORDER BY f.price ${direction}`
        : filter.sort === 'rivals'
          ? sql`ORDER BY f.rivals ${direction}`
          : filter.sort === 'position'
            ? sql`ORDER BY f.position ${direction}`
            : sql`ORDER BY f.gap_percent ${direction}`;

  // One statement, three answers: the page of rows, how many rows the filter
  // matched, and the unfiltered headline counts.
  //
  // They were three round trips, each recomputing every pairing in the
  // catalogue — the same second-and-a-half of work, three times over, to render
  // one screen. Sharing the CTE costs nothing and is the difference between a
  // page that feels instant and one that does not.
  //
  // `pairs` is also why this is a set-based join rather than the LATERAL it
  // started as. A LATERAL whose aggregates are then filtered in the outer WHERE
  // — which is what `extreme` does — makes Postgres re-evaluate the subquery per
  // row: measured, that one clause took the query from 9ms to 6.5s. And joining
  // `products` directly rather than a CTE of rivals is what lets the set-code
  // and trigram indexes be used at all; a CTE is an optimisation fence.
  const rows = await withNameMatching((tx) => tx`
    WITH latest AS (${latestSnapshots}),
    mine AS MATERIALIZED (${ourListings(channel)}),
    pairs AS MATERIALIZED (
      -- The exact half: same set number, therefore the same box.
      SELECT m.id AS mine_id, m.price AS my_price, l.price, p.marketplace,
             s.username AS store_username
      FROM mine m
      JOIN products p ON p.set_code = m.set_code
      JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
      JOIN latest l ON l.product_ref = p.id AND l.price IS NOT NULL
      WHERE m.set_code IS NOT NULL
      UNION ALL
      -- The fallback: no number to match on, so the titles have to do it.
      SELECT m.id, m.price, l.price, p.marketplace, s.username
      FROM mine m
      JOIN products p ON p.name % m.name AND similarity(p.name, m.name) >= ${NAME_MATCH_THRESHOLD}
      JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
      JOIN latest l ON l.product_ref = p.id AND l.price IS NOT NULL
      WHERE m.set_code IS NULL AND m.name IS NOT NULL
    ),
    agg AS MATERIALIZED (
      SELECT mine_id,
             count(*)                                            AS rivals,
             min(price)                                          AS cheapest_price,
             max(price)                                          AS dearest_price,
             count(*) FILTER (WHERE price < my_price)            AS cheaper_than_us,
             (array_agg(store_username ORDER BY price ASC))[1]   AS cheapest_store,
             (array_agg(marketplace ORDER BY price ASC))[1]      AS cheapest_marketplace
      FROM pairs
      GROUP BY mine_id
    ),
    base AS MATERIALIZED (
      SELECT
        m.id, m.marketplace, m.name, m.url, m.image, m.set_code, m.price,
        m.scraped_at,
        coalesce(g.rivals, 0) AS rivals,
        g.cheapest_price, g.dearest_price, g.cheapest_store, g.cheapest_marketplace,
        CASE
          WHEN g.rivals IS NULL OR m.price IS NULL THEN NULL
          ELSE g.cheaper_than_us + 1
        END AS position,
        CASE
          WHEN m.price IS NULL OR g.cheapest_price IS NULL OR g.cheapest_price = 0 THEN NULL
          ELSE round(((m.price - g.cheapest_price) / g.cheapest_price) * 100, 1)
        END AS gap_percent,
        -- Precomputed so the filter reads a column instead of an expression over
        -- an aggregate, which is the whole reason this query is fast now.
        --
        -- Divided by the smaller of the two, not by cheapest_price alone —
        -- unlike gap_percent above. Dividing by the rival unconditionally only
        -- ever flags a gap when WE are the dearer side: when the rival is
        -- dearer the ratio is bounded below 1 for any positive pair, so no
        -- multiple, however large, trips a threshold of 1.0 in that direction.
        -- least() catches both. gap_ratio never reaches the client — only
        -- gap_percent is serialized, in "shaped" below — so this changes which
        -- rows the extreme filter hides, not any number already displayed.
        CASE
          WHEN m.price IS NULL OR g.cheapest_price IS NULL OR least(m.price, g.cheapest_price) = 0
            THEN NULL
          ELSE abs((m.price - g.cheapest_price) / least(m.price, g.cheapest_price))
        END AS gap_ratio
      FROM mine m
      LEFT JOIN agg g ON g.mine_id = m.id
    ),
    filtered AS (SELECT b.* FROM base b ${where}),
    page AS (
      SELECT f.* FROM filtered f
      -- id breaks ties: none of the sort keys is unique, and an ORDER BY that
      -- leaves rows tied lets Postgres return them in a different order per
      -- execution — under LIMIT/OFFSET that shows one product on two pages and
      -- hides another entirely.
      ${orderBy}, f.id ASC
      LIMIT ${filter.pageSize} OFFSET ${offset}
    )
    SELECT
      (SELECT count(*) FROM filtered) AS total,
      (
        SELECT json_build_object(
          'products',       count(*),
          'matched',        count(*) FILTER (WHERE rivals > 0),
          'cheapest',       count(*) FILTER (WHERE rivals > 0 AND price <= cheapest_price),
          'overpriced',     count(*) FILTER (WHERE rivals > 0 AND price > cheapest_price),
          'withoutSetCode', count(*) FILTER (WHERE set_code IS NULL)
        )
        FROM base
      ) AS summary,
      (
        SELECT coalesce(json_agg(row_to_json(shaped)), '[]'::json)
        FROM (
          SELECT id, marketplace, name, url, image,
                 set_code AS "setCode", price, scraped_at AS "scrapedAt",
                 CASE
                   WHEN rivals = 0 THEN NULL
                   WHEN set_code IS NOT NULL THEN 'set'
                   ELSE 'name'
                 END AS "matchKind",
                 rivals,
                 cheapest_price AS "cheapestPrice",
                 cheapest_store AS "cheapestStore",
                 cheapest_marketplace AS "cheapestMarketplace",
                 dearest_price AS "dearestPrice",
                 position,
                 gap_percent AS "gapPercent"
          FROM page
        ) shaped
      ) AS rows
  `);

  const answer = rows[0];
  return {
    rows: (answer?.rows ?? []).map((row: unknown) => pricePositionRowSchema.parse(row)),
    total: Number(answer?.total ?? 0),
    summary: pricePositionSummarySchema.parse(answer?.summary ?? {}),
  };
}

/**
 * Every figure both scoped screens need, computed once per channel.
 *
 * This statement was `getPricingAnalytics`, and its `mine` CTE joined
 * `is_own` alone — exactly the join that cannot tell the Shopee shop from the
 * Tokopedia one apart. Taking a channel is the fix. The scorecard's three
 * extra numbers (`listings`, `withRivals`, `atStake`) are computed here rather
 * than in a second statement for the same reason the worklist shares one CTE
 * for three answers: two figures that are supposed to be identical have to
 * come from the same `scored` rows, the same trigram threshold, the same
 * moment, or one of them eventually disagrees and nobody notices which.
 *
 * Uncached and exported so tests can call it directly. `getPairingSnapshot`
 * below is the cached entry point every page actually calls; it needs no Next
 * request context to run.
 */
export type PairingSnapshot = PricingAnalytics & {
  listings: number;
  withRivals: number;
  atStake: string | null;
};

export async function computePairingSnapshot(channel: Channel): Promise<PairingSnapshot> {
  const [row] = await withNameMatching((tx) => tx`
    WITH latest AS (${latestSnapshots}),
    mine AS MATERIALIZED (
      SELECT o.id, o.name, o.set_code, o.price, l.sold
      FROM (${ourListings(channel)}) o
      JOIN latest l ON l.product_ref = o.id
      WHERE o.price IS NOT NULL
    ),
    pairs AS MATERIALIZED (
      SELECT m.id AS mine_id, m.price AS my_price, l.price AS their_price,
             s.id AS store_id, s.username, s.marketplace
      FROM mine m
      JOIN products p ON p.set_code = m.set_code
      JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
      JOIN latest l ON l.product_ref = p.id AND l.price IS NOT NULL
      WHERE m.set_code IS NOT NULL
      UNION ALL
      SELECT m.id, m.price, l.price, s.id, s.username, s.marketplace
      FROM mine m
      JOIN products p ON p.name % m.name AND similarity(p.name, m.name) >= ${NAME_MATCH_THRESHOLD}
      JOIN stores s ON s.id = p.shop_ref AND NOT s.is_own
      JOIN latest l ON l.product_ref = p.id AND l.price IS NOT NULL
      WHERE m.set_code IS NULL AND m.name IS NOT NULL
    ),
    -- One row per (our product, rival shop): a shop that lists the same set
    -- five times is one competitor with one best offer, not five.
    best AS (
      SELECT mine_id, my_price, store_id, username, marketplace,
             min(their_price) AS their_price
      FROM pairs
      GROUP BY mine_id, my_price, store_id, username, marketplace
    ),
    scored AS (
      SELECT m.id, m.price, m.sold,
             count(b.*) AS rivals,
             min(b.their_price) AS cheapest,
             count(*) FILTER (WHERE b.their_price < m.price) AS beaten_by
      FROM mine m
      LEFT JOIN best b ON b.mine_id = m.id
      GROUP BY m.id, m.price, m.sold
    )
    SELECT
      (
        SELECT json_build_object(
          'cheapest',  count(*) FILTER (WHERE rivals > 0 AND beaten_by = 0),
          'middle',    count(*) FILTER (WHERE rivals > 0 AND beaten_by > 0 AND beaten_by < rivals),
          'dearest',   count(*) FILTER (WHERE rivals > 0 AND beaten_by = rivals),
          'unmatched', count(*) FILTER (WHERE rivals = 0)
        ) FROM scored
      ) AS position,
      (
        SELECT coalesce(json_agg(r ORDER BY r.beats DESC), '[]'::json) FROM (
          SELECT username, marketplace,
                 count(*) FILTER (WHERE their_price < my_price)  AS beats,
                 count(*) FILTER (WHERE their_price >= my_price) AS meets,
                 round(
                   avg((their_price - my_price) / my_price * 100)
                     FILTER (WHERE their_price < my_price), 1
                 ) AS "averageGap"
          FROM best
          GROUP BY username, marketplace
          HAVING count(*) FILTER (WHERE their_price < my_price) > 0
        ) r
      ) AS rivals,
      (
        SELECT coalesce(json_agg(b ORDER BY b.floor DESC), '[]'::json) FROM (
          -- Brackets rather than a continuous axis: the question is "where is
          -- the money", and money clusters by order of magnitude here.
          SELECT
            CASE
              WHEN price >= 2000000 THEN '> Rp 2jt'
              WHEN price >= 500000  THEN 'Rp 500rb–2jt'
              WHEN price >= 100000  THEN 'Rp 100–500rb'
              ELSE '< Rp 100rb'
            END AS band,
            CASE
              WHEN price >= 2000000 THEN 2000000
              WHEN price >= 500000  THEN 500000
              WHEN price >= 100000  THEN 100000
              ELSE 0
            END AS floor,
            count(*) AS products,
            count(*) FILTER (WHERE price > cheapest) AS overpriced,
            coalesce(sum(price - cheapest) FILTER (WHERE price > cheapest), 0) AS "atStake"
          FROM scored
          WHERE rivals > 0
          GROUP BY band, floor
        ) b
      ) AS bands,
      (
        SELECT coalesce(json_agg(g), '[]'::json) FROM (
          SELECT s.id, m.name, s.sold, s.price,
                 round((s.price - s.cheapest) / s.cheapest * 100, 1) AS "gapPercent"
          FROM scored s
          JOIN mine m ON m.id = s.id
          WHERE s.rivals > 0 AND s.sold IS NOT NULL AND s.cheapest > 0 AND s.price > 0
            -- Beyond this the pairing is a packaging difference rather than a
            -- price, the same reason the worklist hides those rows by default.
            -- least(), not s.cheapest alone: dividing by the rival uncondition-
            -- ally only ever excludes a pairing when WE are the dearer side,
            -- because that ratio is bounded below 1 no matter how large the
            -- true multiple is when the rival is the dearer one. "gapPercent"
            -- above is untouched — same signed, rival-denominated figure the
            -- chart always plotted — only which rows reach it changes.
            AND abs((s.price - s.cheapest) / least(s.price, s.cheapest)) < ${EXTREME_GAP}
        ) g
      ) AS "gapVolume",
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
 * The same snapshot, served immediately and refreshed in the background.
 *
 * The pairing is the expensive part of this app — 2.9–3.3s against Neon — and
 * two screens need all of it. Snapshots only change when a scrape runs, so a
 * few-minutes-old answer is the same answer; the first visit after each
 * five-minute window pays for a refresh and the rest do not. `revalidate: 300`
 * is stale-while-revalidate, not a hard ceiling: a request past that window is
 * still answered from what is already cached while the refresh runs for
 * whoever asks next, so a figure can be one refresh older than five minutes,
 * never "at most" five.
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

/**
 * One of our products and every rival tied to it, dearest question first.
 *
 * `React.cache()`-wrapped: `generateMetadata` and the page body both call this
 * with the same id on every visit to the detail page, and without the wrapper
 * the whole pairing query — the expensive part of this app — runs twice just
 * to fill in a `<title>`.
 */
export const getPricePositionDetail = cache(async (
  productId: number,
): Promise<{ product: PricePositionRow; rivals: RivalRow[] } | null> => {
  const channel = await channelOfOwnProduct(productId);
  if (!channel) return null;

  const [mine] = await sql`
    WITH latest AS (${latestSnapshots}),
    mine AS (${ourListings(channel)})
    SELECT m.id, m.marketplace, m.name, m.url, m.image,
           m.set_code AS "setCode", m.price, m.scraped_at AS "scrapedAt"
    FROM mine m
    WHERE m.id = ${productId}
  `;
  if (!mine) return null;

  const rivals = await withNameMatching((tx) => tx`
    WITH latest AS (${latestSnapshots}),
    mine AS (SELECT * FROM (${ourListings(channel)}) o WHERE o.id = ${productId}),
    rivals AS (${theirProducts})
    SELECT r.id, r.marketplace, r.name, r.url, r.image,
           r.set_code AS "setCode",
           r.store_id AS "storeId",
           r.store_username AS "storeUsername",
           r.store_name AS "storeName",
           r.price, r.sold, r.rating_star AS "ratingStar",
           r.scraped_at AS "scrapedAt",
           CASE WHEN m.set_code IS NOT NULL THEN 'set' ELSE 'name' END AS "matchKind",
           CASE
             WHEN m.set_code IS NOT NULL THEN NULL
             ELSE round(similarity(r.name, m.name)::numeric, 2)
           END AS similarity
    FROM mine m
    JOIN rivals r ON ${rivalMatch}
    ORDER BY r.price ASC NULLS LAST
  `);

  const cheapest = rivals[0] ?? null;
  const prices = rivals.map((row) => Number(row.price)).filter((value) => Number.isFinite(value));
  const ours = mine.price === null ? null : Number(mine.price);
  const cheapestPrice = prices.length > 0 ? Math.min(...prices) : null;

  return {
    product: pricePositionRowSchema.parse({
      ...mine,
      matchKind: cheapest ? cheapest.matchKind : null,
      rivals: rivals.length,
      cheapestPrice: cheapest?.price ?? null,
      cheapestStore: cheapest?.storeUsername ?? null,
      cheapestMarketplace: cheapest?.marketplace ?? null,
      dearestPrice: prices.length > 0 ? String(Math.max(...prices)) : null,
      position:
        ours === null || prices.length === 0
          ? null
          : prices.filter((price) => price < ours).length + 1,
      gapPercent:
        ours === null || cheapestPrice === null || cheapestPrice === 0
          ? null
          : Math.round(((ours - cheapestPrice) / cheapestPrice) * 1000) / 10,
    }),
    rivals: rivals.map((row) => rivalRowSchema.parse(row)),
  };
});

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

/**
 * Distinct values for the filter controls.
 *
 * Populated from the data so the UI can only offer filters that would return
 * something — an empty result from a dropdown the app itself rendered reads as
 * a bug.
 */
export async function getFilterOptions(): Promise<FilterOptions> {
  const [marketplaces, locations, range] = await Promise.all([
    sql`SELECT DISTINCT marketplace FROM products ORDER BY marketplace`,
    sql`
      SELECT DISTINCT location FROM stores
      WHERE location IS NOT NULL AND location <> ''
      ORDER BY location
      LIMIT 200
    `,
    sql`SELECT min(price) AS min, max(price) AS max FROM price_snapshots`,
  ]);

  return filterOptionsSchema.parse({
    marketplaces: marketplaces.map((row) => row.marketplace),
    locations: locations.map((row) => row.location),
    priceRange: { min: range[0]?.min ?? null, max: range[0]?.max ?? null },
  });
}
