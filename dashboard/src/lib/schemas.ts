import { z } from 'zod';

/**
 * The contract between the database, the route handlers and the client.
 *
 * One definition, used three ways: route handlers parse their query strings
 * with it, the SQL layer validates what came back, and the client infers its
 * types from it. A filter that the UI can express but the API rejects is the
 * failure mode this prevents, and it is the reason these live in one file
 * rather than being restated per route.
 *
 * Money is a string everywhere. Postgres NUMERIC arrives as a string and stays
 * one until it is formatted for display — turning it into a JS number would
 * reintroduce exactly the float rounding the scraper avoids.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const marketplaceSchema = z.enum(['shopee', 'tokopedia']);
export type Marketplace = z.infer<typeof marketplaceSchema>;

/** A NUMERIC column: a decimal string, or null when never observed. */
export const moneySchema = z.union([z.string(), z.number()]).nullable().transform((value) =>
  value === null ? null : String(value),
);

/** Postgres timestamps arrive as Date over the wire; normalise to ISO. */
export const timestampSchema = z
  .union([z.date(), z.string()])
  .nullable()
  .transform((value) => {
    if (value === null) return null;
    return value instanceof Date ? value.toISOString() : value;
  });

/** BIGINT ids exceed Number.MAX_SAFE_INTEGER once slugs are hashed, so they stay strings. */
export const bigIntIdSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => String(value));

const intFromQuery = z.coerce.number().int();

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export const storeRowSchema = z.object({
  id: z.number().int(),
  marketplace: marketplaceSchema,
  shopId: bigIntIdSchema,
  username: z.string(),
  name: z.string().nullable(),
  location: z.string().nullable(),
  productCount: z.coerce.number().int(),
  minPrice: moneySchema,
  maxPrice: moneySchema,
  avgPrice: moneySchema,
  totalSold: z.coerce.number().int().nullable(),
  lastSeen: timestampSchema,
});
export type StoreRow = z.infer<typeof storeRowSchema>;

export const productRowSchema = z.object({
  id: z.number().int(),
  marketplace: marketplaceSchema,
  itemId: bigIntIdSchema,
  name: z.string().nullable(),
  url: z.string().nullable(),
  image: z.string().nullable(),
  storeId: z.number().int().nullable(),
  storeUsername: z.string().nullable(),
  storeLocation: z.string().nullable(),
  price: moneySchema,
  sold: z.coerce.number().int().nullable(),
  ratingStar: moneySchema,
  scrapedAt: timestampSchema,
  keywords: z.array(z.string()).default([]),
  /** How many snapshots exist — a product with 1 has no history to chart yet. */
  snapshotCount: z.coerce.number().int().default(0),
});
export type ProductRow = z.infer<typeof productRowSchema>;

export const keywordRowSchema = z.object({
  keyword: z.string(),
  marketplace: marketplaceSchema,
  products: z.coerce.number().int(),
  stores: z.coerce.number().int(),
  minPrice: moneySchema,
  maxPrice: moneySchema,
  avgPrice: moneySchema,
});
export type KeywordRow = z.infer<typeof keywordRowSchema>;

export const pricePointSchema = z.object({
  scrapedAt: timestampSchema,
  price: moneySchema,
  sold: z.coerce.number().int().nullable(),
  ratingStar: moneySchema,
});
export type PricePoint = z.infer<typeof pricePointSchema>;

export const overviewSchema = z.object({
  stores: z.coerce.number().int(),
  products: z.coerce.number().int(),
  snapshots: z.coerce.number().int(),
  keywords: z.coerce.number().int(),
  marketplaces: z.array(
    z.object({
      marketplace: marketplaceSchema,
      stores: z.coerce.number().int(),
      products: z.coerce.number().int(),
    }),
  ),
  lastScrapedAt: timestampSchema,
});
export type Overview = z.infer<typeof overviewSchema>;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const sortFieldSchema = z.enum(['price', 'sold', 'rating', 'name', 'scrapedAt']);
export const sortDirSchema = z.enum(['asc', 'desc']);

/**
 * Every filter the product views accept.
 *
 * `.catch()` on each field rather than a hard failure: a stale bookmark with a
 * filter that no longer exists should render the dashboard, not a 400. The
 * defaults are the "no filter" state.
 */
export const productFilterSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  marketplace: marketplaceSchema.optional().catch(undefined),
  storeId: intFromQuery.positive().optional().catch(undefined),
  keyword: z.string().trim().max(200).optional().catch(undefined),
  location: z.string().trim().max(120).optional().catch(undefined),
  minPrice: intFromQuery.nonnegative().optional().catch(undefined),
  maxPrice: intFromQuery.nonnegative().optional().catch(undefined),
  minSold: intFromQuery.nonnegative().optional().catch(undefined),
  minRating: z.coerce.number().min(0).max(5).optional().catch(undefined),
  hasImage: z.coerce.boolean().optional().catch(undefined),
  sort: sortFieldSchema.default('sold').catch('sold'),
  dir: sortDirSchema.default('desc').catch('desc'),
  page: intFromQuery.min(1).default(1).catch(1),
  pageSize: intFromQuery.min(1).max(200).default(50).catch(50),
});
export type ProductFilter = z.infer<typeof productFilterSchema>;

export const storeFilterSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  marketplace: marketplaceSchema.optional().catch(undefined),
  location: z.string().trim().max(120).optional().catch(undefined),
  sort: z.enum(['products', 'name', 'avgPrice']).default('products').catch('products'),
  dir: sortDirSchema.default('desc').catch('desc'),
  page: intFromQuery.min(1).default(1).catch(1),
  pageSize: intFromQuery.min(1).max(200).default(50).catch(50),
});
export type StoreFilter = z.infer<typeof storeFilterSchema>;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Paginated responses share a shape so the table component is filter-agnostic. */
export function pagedSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({
    rows: z.array(row),
    total: z.coerce.number().int(),
    page: z.coerce.number().int(),
    pageSize: z.coerce.number().int(),
  });
}

export const pagedProductsSchema = pagedSchema(productRowSchema);
export type PagedProducts = z.infer<typeof pagedProductsSchema>;

export const pagedStoresSchema = pagedSchema(storeRowSchema);
export type PagedStores = z.infer<typeof pagedStoresSchema>;

/** Distinct values for the filter dropdowns, so they only offer real options. */
export const filterOptionsSchema = z.object({
  marketplaces: z.array(marketplaceSchema),
  locations: z.array(z.string()),
  keywords: z.array(z.string()),
  priceRange: z.object({ min: moneySchema, max: moneySchema }),
});
export type FilterOptions = z.infer<typeof filterOptionsSchema>;

/**
 * Turn a filter object back into a query string.
 *
 * Shared by the client (URL sync) and the fetchers (cache keys), so a filter can
 * never be serialised one way in the address bar and another in the request.
 * Undefined and empty values are dropped so the URL stays readable.
 */
export function toSearchParams(filter: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  params.sort(); // stable ordering => stable cache keys
  return params;
}
