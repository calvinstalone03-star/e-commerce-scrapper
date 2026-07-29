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
  /** How many snapshots exist — a product with 1 has no history to chart yet. */
  snapshotCount: z.coerce.number().int().default(0),
});
export type ProductRow = z.infer<typeof productRowSchema>;

export const pricePointSchema = z.object({
  scrapedAt: timestampSchema,
  price: moneySchema,
  sold: z.coerce.number().int().nullable(),
  ratingStar: moneySchema,
});
export type PricePoint = z.infer<typeof pricePointSchema>;

/**
 * How a competitor listing was tied to one of ours.
 *
 * `set` is the LEGO set number both titles carry — the same box, whatever words
 * surround it. `name` is trigram similarity, used only for listings with no set
 * number in them at all, and surfaced separately in the UI because it is the
 * weaker claim: one wrong pairing shown as confidently as a set match would put
 * every row in doubt.
 */
export const matchKindSchema = z.enum(['set', 'name']);
export type MatchKind = z.infer<typeof matchKindSchema>;

/** One of our products, with where its price sits among the competition. */
export const pricePositionRowSchema = z.object({
  id: z.number().int(),
  marketplace: marketplaceSchema,
  name: z.string().nullable(),
  url: z.string().nullable(),
  image: z.string().nullable(),
  setCode: z.string().nullable(),
  price: moneySchema,
  scrapedAt: timestampSchema,
  matchKind: matchKindSchema.nullable(),
  rivals: z.coerce.number().int().default(0),
  cheapestPrice: moneySchema,
  cheapestStore: z.string().nullable(),
  cheapestMarketplace: marketplaceSchema.nullable(),
  dearestPrice: moneySchema,
  /** 1 means nobody undercuts us. Null when there is nothing to rank against. */
  position: z.coerce.number().int().nullable(),
  /** Our price against the cheapest rival, in percent. Positive means dearer. */
  gapPercent: z.coerce.number().nullable(),
});
export type PricePositionRow = z.infer<typeof pricePositionRowSchema>;

/** A competitor listing on the detail screen. */
export const rivalRowSchema = z.object({
  id: z.number().int(),
  marketplace: marketplaceSchema,
  name: z.string().nullable(),
  url: z.string().nullable(),
  /** Thumbnail. The fastest way to spot a pairing that is plainly wrong. */
  image: z.string().nullable(),
  setCode: z.string().nullable(),
  storeId: z.number().int().nullable(),
  storeUsername: z.string().nullable(),
  storeName: z.string().nullable(),
  price: moneySchema,
  sold: z.coerce.number().int().nullable(),
  ratingStar: moneySchema,
  scrapedAt: timestampSchema,
  matchKind: matchKindSchema,
  /** Trigram score, present only for name matches — the reason to distrust one. */
  similarity: z.coerce.number().nullable(),
});
export type RivalRow = z.infer<typeof rivalRowSchema>;

/** A shop marked as ours by `ecom-scraper own-shop`. */
export const ownShopSchema = z.object({
  id: z.number().int(),
  marketplace: marketplaceSchema,
  username: z.string(),
  name: z.string().nullable(),
  products: z.coerce.number().int(),
});
export type OwnShop = z.infer<typeof ownShopSchema>;

/** Headline counts for the price-position screen, over the whole catalogue. */
export const pricePositionSummarySchema = z.object({
  products: z.coerce.number().int(),
  matched: z.coerce.number().int(),
  cheapest: z.coerce.number().int(),
  overpriced: z.coerce.number().int(),
  withoutSetCode: z.coerce.number().int(),
});
export type PricePositionSummary = z.infer<typeof pricePositionSummarySchema>;

/** One competitor's pressure on our catalogue. */
export const rivalPressureSchema = z.object({
  username: z.string(),
  marketplace: marketplaceSchema,
  /** Our products this shop sells cheaper than we do. */
  beats: z.coerce.number().int(),
  /** Our products they also stock but do not undercut. */
  meets: z.coerce.number().int(),
  /** Average depth of the undercut, in percent, negative. */
  averageGap: z.coerce.number().nullable(),
});
export type RivalPressure = z.infer<typeof rivalPressureSchema>;

/** What being overpriced costs, per price bracket. */
export const priceBandSchema = z.object({
  band: z.string(),
  /** Sort key, since "Rp 100–500rb" does not sort as a number. */
  floor: z.coerce.number(),
  products: z.coerce.number().int(),
  overpriced: z.coerce.number().int(),
  /** Sum of (our price − cheapest rival) across the overpriced ones. */
  atStake: moneySchema,
});
export type PriceBand = z.infer<typeof priceBandSchema>;

/** One point: how far off the cheapest rival we are, against how much we sell. */
export const gapVolumePointSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  gapPercent: z.coerce.number(),
  sold: z.coerce.number().int(),
  price: moneySchema,
});
export type GapVolumePoint = z.infer<typeof gapVolumePointSchema>;

export const pricingAnalyticsSchema = z.object({
  position: z.object({
    cheapest: z.coerce.number().int(),
    middle: z.coerce.number().int(),
    dearest: z.coerce.number().int(),
    unmatched: z.coerce.number().int(),
  }),
  rivals: z.array(rivalPressureSchema),
  bands: z.array(priceBandSchema),
  gapVolume: z.array(gapVolumePointSchema),
});
export type PricingAnalytics = z.infer<typeof pricingAnalyticsSchema>;

export const overviewSchema = z.object({
  stores: z.coerce.number().int(),
  products: z.coerce.number().int(),
  snapshots: z.coerce.number().int(),
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

/**
 * Filters for the price-position screen.
 *
 * `matched: 'none'` is not a nag — it is the scraping worklist. Those are the
 * products nobody has been scraped against yet, and they are the reason to run
 * another competitor's catalogue.
 */
export const pricePositionFilterSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  /** 'over' = we are dearer than the cheapest rival, 'under' = we undercut it. */
  stance: z.enum(['any', 'over', 'under', 'equal']).default('any').catch('any'),
  matched: z.enum(['any', 'set', 'name', 'none']).default('any').catch('any'),
  /**
   * Gaps too large to be a pricing decision, hidden by default.
   *
   * A LEGO collectible series carries one set number across the single blind
   * bag, the keychain and the box of sixty, so a pairing can be perfectly
   * correct and still read as "+20.900%". Sorted by gap — the default — those
   * rows occupy the entire first page and bury every real decision behind them.
   * They are still one click away, because a genuinely mispriced product can
   * also land here.
   */
  extreme: z.enum(['hide', 'show']).default('hide').catch('hide'),
  minRivals: intFromQuery.nonnegative().max(50).optional().catch(undefined),
  marketplace: marketplaceSchema.optional().catch(undefined),
  sort: z.enum(['gap', 'position', 'rivals', 'price', 'name']).default('gap').catch('gap'),
  dir: sortDirSchema.default('desc').catch('desc'),
  page: intFromQuery.min(1).default(1).catch(1),
  /**
   * Ten by default, not fifty.
   *
   * This is a worklist: the rows anyone acts on are the first few, and a
   * catalogue of 1600 makes every extra row a row nobody reads. Larger pages
   * stay available for scanning, capped where a single response stops being
   * reasonable to send.
   */
  pageSize: intFromQuery.min(1).max(100).default(10).catch(10),
});
export type PricePositionFilter = z.infer<typeof pricePositionFilterSchema>;

export const storeFilterSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  marketplace: marketplaceSchema.optional().catch(undefined),
  location: z.string().trim().max(120).optional().catch(undefined),
  sort: z.enum(['products', 'name', 'avgPrice']).default('products').catch('products'),
  dir: sortDirSchema.default('desc').catch('desc'),
  page: intFromQuery.min(1).default(1).catch(1),
  //: Ten, matching the price list. Fifty put every shop on one page and left the
  //: pager permanently hidden, which read as "this table has no paging" rather
  //: than "this table happens to fit".
  pageSize: intFromQuery.min(1).max(100).default(10).catch(10),
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
