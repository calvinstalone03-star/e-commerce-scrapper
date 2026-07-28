import 'server-only';

import { sql } from '@/lib/db';
import {
  filterOptionsSchema,
  keywordRowSchema,
  overviewSchema,
  pricePointSchema,
  productRowSchema,
  storeRowSchema,
  type FilterOptions,
  type KeywordRow,
  type Overview,
  type PricePoint,
  type ProductFilter,
  type ProductRow,
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
      ${orderBy}
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
      ${orderBy}
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
    ORDER BY scraped_at ASC
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
    ORDER BY products DESC, pk.keyword ASC
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
    ORDER BY avg(l.price) ASC NULLS LAST
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
