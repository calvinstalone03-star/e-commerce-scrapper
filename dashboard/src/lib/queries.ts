import 'server-only';

import { sql } from '@/lib/db';
import {
  filterOptionsSchema,
  keywordRowSchema,
  overviewSchema,
  ownShopSchema,
  pricePointSchema,
  pricePositionRowSchema,
  pricePositionSummarySchema,
  productRowSchema,
  rivalRowSchema,
  storeRowSchema,
  type FilterOptions,
  type KeywordRow,
  type Overview,
  type OwnShop,
  type PricePoint,
  type PricePositionFilter,
  type PricePositionRow,
  type PricePositionSummary,
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
        (SELECT count(*) FROM price_snapshots)               AS snapshots,
        (SELECT count(DISTINCT keyword) FROM product_keywords) AS keywords
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
    ${
      filter.keyword
        ? sql`AND EXISTS (
            SELECT 1 FROM product_keywords pk
            WHERE pk.product_ref = p.id AND pk.keyword = ${filter.keyword}
          )`
        : sql``
    }
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
        -- Aggregated in the same round trip. Fetching keywords per row would be
        -- N+1, and on a 50-row page that is 50 extra queries per keystroke.
        coalesce(
          (SELECT array_agg(pk.keyword ORDER BY pk.keyword)
           FROM product_keywords pk WHERE pk.product_ref = p.id),
          '{}'
        ) AS keywords,
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

/** Full snapshot history for one product — the price chart's source. */
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
// Keywords
// ---------------------------------------------------------------------------

export async function getKeywords(marketplace?: string): Promise<KeywordRow[]> {
  const rows = await sql`
    WITH latest AS (${latestSnapshots})
    SELECT
      pk.keyword, pk.marketplace,
      count(DISTINCT pk.product_ref) AS products,
      count(DISTINCT p.shop_ref)     AS stores,
      min(l.price)                   AS "minPrice",
      max(l.price)                   AS "maxPrice",
      round(avg(l.price))            AS "avgPrice"
    FROM product_keywords pk
    JOIN products p ON p.id = pk.product_ref
    LEFT JOIN latest l ON l.product_ref = pk.product_ref
    ${marketplace ? sql`WHERE pk.marketplace = ${marketplace}` : sql``}
    GROUP BY pk.keyword, pk.marketplace
    -- The group is (keyword, marketplace), so keyword alone does not break a
    -- tie: one term scraped on both marketplaces is two rows that can hold the
    -- same product count.
    ORDER BY products DESC, pk.keyword ASC, pk.marketplace ASC
  `;
  return rows.map((row) => keywordRowSchema.parse(row));
}

/**
 * Per-store price summary within one keyword — the competitor comparison chart.
 *
 * This is the question the whole project exists to answer: for this search term,
 * what does each shop charge?
 */
export async function getKeywordComparison(keyword: string): Promise<
  Array<{
    storeId: number | null;
    storeUsername: string | null;
    products: number;
    minPrice: string | null;
    maxPrice: string | null;
    avgPrice: string | null;
  }>
> {
  const rows = await sql`
    WITH latest AS (${latestSnapshots})
    SELECT
      s.id       AS "storeId",
      s.username AS "storeUsername",
      count(DISTINCT p.id) AS products,
      min(l.price)         AS "minPrice",
      max(l.price)         AS "maxPrice",
      round(avg(l.price))  AS "avgPrice"
    FROM product_keywords pk
    JOIN products p ON p.id = pk.product_ref
    LEFT JOIN stores s ON s.id = p.shop_ref
    LEFT JOIN latest l ON l.product_ref = p.id
    WHERE pk.keyword = ${keyword}
    GROUP BY s.id, s.username
    HAVING count(DISTINCT p.id) > 0
    -- Shops that price a keyword identically are common, and without a tiebreak
    -- they swap places between requests — which reorders the bars in the
    -- comparison chart, and with them which shop the page calls "termurah".
    -- s.id is NULL for the one synthetic row of shopless products, so it sorts
    -- last rather than jumping to the front of its tie group.
    ORDER BY avg(l.price) ASC NULLS LAST, s.id ASC NULLS LAST
  `;
  return rows.map((row) => ({
    storeId: row.storeId ?? null,
    storeUsername: row.storeUsername ?? null,
    products: Number(row.products),
    minPrice: row.minPrice === null ? null : String(row.minPrice),
    maxPrice: row.maxPrice === null ? null : String(row.maxPrice),
    avgPrice: row.avgPrice === null ? null : String(row.avgPrice),
  }));
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
 */
const EXTREME_GAP = 1.0;

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

/** Our shops and their listings, newest price each. */
const ourProducts = sql`
  SELECT p.id, p.marketplace, p.name, p.url, p.image, p.set_code,
         l.price, l.scraped_at
  FROM products p
  JOIN stores s ON s.id = p.shop_ref AND s.is_own
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

/** Shops marked ours. Empty means the screen has nothing to stand on. */
export async function getOwnShops(): Promise<OwnShop[]> {
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
}

export async function getPricePositions(
  filter: PricePositionFilter,
): Promise<{ rows: PricePositionRow[]; total: number }> {
  const offset = (filter.page - 1) * filter.pageSize;

  const where = sql`
    WHERE TRUE
    ${filter.marketplace ? sql`AND m.marketplace = ${filter.marketplace}` : sql``}
    ${filter.q ? sql`AND (m.name ILIKE ${'%' + filter.q + '%'} OR m.set_code = ${filter.q})` : sql``}
    ${filter.minRivals !== undefined ? sql`AND agg.rivals >= ${filter.minRivals}` : sql``}
    ${
      // Stated as the conditions themselves rather than against the CASE above:
      // a SELECT alias is not visible in WHERE, and repeating the two-line rule
      // beats wrapping the whole query in a subselect to reach the alias.
      filter.matched === 'none'
        ? sql`AND agg.rivals = 0`
        : filter.matched === 'set'
          ? sql`AND agg.rivals > 0 AND m.set_code IS NOT NULL`
          : filter.matched === 'name'
            ? sql`AND agg.rivals > 0 AND m.set_code IS NULL`
            : sql``
    }
    ${
      // Extreme gaps are a packaging artefact far more often than a pricing
      // mistake — one set number spans a single minifigure and a box of sixty.
      // A row with no rival has no gap and is not extreme, so it stays.
      filter.extreme === 'hide'
        ? sql`AND (
            agg.cheapest_price IS NULL
            OR m.price IS NULL
            OR agg.cheapest_price = 0
            OR abs((m.price - agg.cheapest_price) / agg.cheapest_price) < ${EXTREME_GAP}
          )`
        : sql``
    }
    ${
      // A stance is a claim about our price against the cheapest rival, so it
      // only means anything where both exist.
      filter.stance === 'over'
        ? sql`AND m.price > agg.cheapest_price`
        : filter.stance === 'under'
          ? sql`AND m.price < agg.cheapest_price`
          : filter.stance === 'equal'
            ? sql`AND m.price = agg.cheapest_price`
            : sql``
    }
  `;

  const direction = filter.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  const orderBy =
    filter.sort === 'name'
      ? sql`ORDER BY m.name ${direction}`
      : filter.sort === 'price'
        ? sql`ORDER BY m.price ${direction}`
        : filter.sort === 'rivals'
          ? sql`ORDER BY agg.rivals ${direction}`
          : filter.sort === 'position'
            ? sql`ORDER BY "position" ${direction}`
            : sql`ORDER BY "gapPercent" ${direction}`;

  // `agg` is one lateral per product rather than a GROUP BY over the whole
  // cross product: it keeps the rival scan bounded by that product's matches,
  // and it is where the cheapest rival's identity comes from — an aggregate
  // alone would give the price but not who charges it.
  const body = sql`
    WITH latest AS (${latestSnapshots}),
    mine AS (${ourProducts}),
    rivals AS (${theirProducts})
    SELECT
      m.id, m.marketplace, m.name, m.url, m.image,
      m.set_code AS "setCode",
      m.price,
      m.scraped_at AS "scrapedAt",
      -- Which rule paired this row, derived rather than aggregated: a product
      -- with a set number was matched on it and one without it was not, so
      -- there is nothing to count. Computing it inside the lateral made it an
      -- aggregate over none of the lateral's own columns, which Postgres reads
      -- as belonging to the outer query and rejects outright.
      CASE
        WHEN agg.rivals = 0 THEN NULL
        WHEN m.set_code IS NOT NULL THEN 'set'
        ELSE 'name'
      END AS "matchKind",
      agg.rivals,
      agg.cheapest_price AS "cheapestPrice",
      agg.cheapest_store AS "cheapestStore",
      agg.cheapest_marketplace AS "cheapestMarketplace",
      agg.dearest_price AS "dearestPrice",
      CASE
        WHEN m.price IS NULL OR agg.rivals = 0 THEN NULL
        ELSE agg.cheaper_than_us + 1
      END AS "position",
      CASE
        WHEN m.price IS NULL OR agg.cheapest_price IS NULL OR agg.cheapest_price = 0 THEN NULL
        ELSE round(((m.price - agg.cheapest_price) / agg.cheapest_price) * 100, 1)
      END AS "gapPercent"
    FROM mine m
    LEFT JOIN LATERAL (
      SELECT
        count(*)                                              AS rivals,
        min(r.price)                                          AS cheapest_price,
        max(r.price)                                          AS dearest_price,
        count(*) FILTER (WHERE r.price < m.price)             AS cheaper_than_us,
        (array_agg(r.store_username ORDER BY r.price ASC))[1] AS cheapest_store,
        (array_agg(r.marketplace ORDER BY r.price ASC))[1]    AS cheapest_marketplace
      FROM rivals r
      WHERE ${rivalMatch}
    ) agg ON TRUE
    ${where}
  `;

  const [rows, counted] = await Promise.all([
    sql`${body} ${orderBy} LIMIT ${filter.pageSize} OFFSET ${offset}`,
    sql`SELECT count(*) AS total FROM (${body}) counted`,
  ]);

  return {
    rows: rows.map((row) => pricePositionRowSchema.parse(row)),
    total: Number(counted[0]?.total ?? 0),
  };
}

/** Headline counts over the whole own catalogue, unfiltered. */
export async function getPricePositionSummary(): Promise<PricePositionSummary> {
  const rows = await sql`
    WITH latest AS (${latestSnapshots}),
    mine AS (${ourProducts}),
    rivals AS (${theirProducts}),
    scored AS (
      SELECT
        m.id, m.price, m.set_code,
        agg.rivals, agg.cheapest_price
      FROM mine m
      LEFT JOIN LATERAL (
        SELECT count(*) AS rivals, min(r.price) AS cheapest_price
        FROM rivals r
        WHERE ${rivalMatch}
      ) agg ON TRUE
    )
    SELECT
      count(*)                                                              AS products,
      count(*) FILTER (WHERE rivals > 0)                                    AS matched,
      count(*) FILTER (WHERE rivals > 0 AND price <= cheapest_price)        AS cheapest,
      count(*) FILTER (WHERE rivals > 0 AND price > cheapest_price)         AS overpriced,
      count(*) FILTER (WHERE set_code IS NULL)                              AS "withoutSetCode"
    FROM scored
  `;
  return pricePositionSummarySchema.parse(rows[0]);
}

/** One of our products and every rival tied to it, dearest question first. */
export async function getPricePositionDetail(
  productId: number,
): Promise<{ product: PricePositionRow; rivals: RivalRow[] } | null> {
  const [mine] = await sql`
    WITH latest AS (${latestSnapshots}),
    mine AS (${ourProducts})
    SELECT m.id, m.marketplace, m.name, m.url, m.image,
           m.set_code AS "setCode", m.price, m.scraped_at AS "scrapedAt"
    FROM mine m
    WHERE m.id = ${productId}
  `;
  if (!mine) return null;

  const rivals = await sql`
    WITH latest AS (${latestSnapshots}),
    mine AS (SELECT * FROM (${ourProducts}) o WHERE o.id = ${productId}),
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
  `;

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
}

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
  const [marketplaces, locations, keywords, range] = await Promise.all([
    sql`SELECT DISTINCT marketplace FROM products ORDER BY marketplace`,
    sql`
      SELECT DISTINCT location FROM stores
      WHERE location IS NOT NULL AND location <> ''
      ORDER BY location
      LIMIT 200
    `,
    sql`
      SELECT keyword, count(*) AS n FROM product_keywords
      GROUP BY keyword ORDER BY n DESC, keyword ASC LIMIT 200
    `,
    sql`SELECT min(price) AS min, max(price) AS max FROM price_snapshots`,
  ]);

  return filterOptionsSchema.parse({
    marketplaces: marketplaces.map((row) => row.marketplace),
    locations: locations.map((row) => row.location),
    keywords: keywords.map((row) => row.keyword),
    priceRange: { min: range[0]?.min ?? null, max: range[0]?.max ?? null },
  });
}
