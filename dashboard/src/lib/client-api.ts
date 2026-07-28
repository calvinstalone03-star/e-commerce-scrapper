import { z } from 'zod';

import { formatStoreName } from '@/lib/format';
import {
  filterOptionsSchema,
  pagedProductsSchema,
  pagedStoresSchema,
  pricePointSchema,
  productFilterSchema,
  storeFilterSchema,
  toSearchParams,
  type FilterOptions,
  type Marketplace,
  type PagedProducts,
  type PagedStores,
  type PricePoint,
  type ProductFilter,
  type StoreFilter,
  type StoreRow,
} from '@/lib/schemas';

/**
 * The browser's half of the contract: one fetcher per route, each parsing the
 * response with the same Zod schema the route handler and the SQL layer use.
 *
 * Parsing on arrival is not ceremony. These fetchers feed a cache that survives
 * navigations, so an unvalidated field lands in the table minutes later and far
 * from its cause; parsing here fails at the fetch, naming the field.
 *
 * Query strings are built by `toSearchParams` from `schemas.ts` — the same
 * function the URL sync uses — so the address bar, the request URL and the
 * cache key are three views of one filter object rather than three chances to
 * disagree.
 */

/** A failed request, carrying enough context for the UI to say what broke. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The "no filter" state, read off the schema rather than restated here.
 *
 * Serialising a filter omits anything equal to a default, which keeps a shared
 * URL down to what the user actually chose (`?q=lego` rather than
 * `?dir=desc&page=1&pageSize=50&q=lego&sort=sold`). The route handler re-applies
 * the same defaults on the way in, so the shorter URL means the same thing.
 */
const PRODUCT_FILTER_DEFAULTS = productFilterSchema.parse({});
const STORE_FILTER_DEFAULTS = storeFilterSchema.parse({});

function withoutDefaults(
  filter: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const explicit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === defaults[key]) continue;
    // An off toggle must be absent, never `false`: the filter schema coerces
    // with `z.coerce.boolean()`, and `Boolean('false')` is `true`, so a
    // round-trip through `?hasImage=false` would switch the filter back on.
    if (value === false) continue;
    explicit[key] = value;
  }
  return explicit;
}

/** The canonical query string for a product filter. Used for both URL and request. */
export function productSearchParams(filter: ProductFilter): URLSearchParams {
  return toSearchParams(withoutDefaults(filter, PRODUCT_FILTER_DEFAULTS));
}

export function storeSearchParams(filter: StoreFilter): URLSearchParams {
  return toSearchParams(withoutDefaults(filter, STORE_FILTER_DEFAULTS));
}

async function getJson<Schema extends z.ZodType>(
  url: string,
  schema: Schema,
  signal?: AbortSignal,
): Promise<z.output<Schema>> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new ApiError(`Permintaan gagal (HTTP ${response.status})`, response.status, url);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('Respons bukan JSON yang valid', response.status, url);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue?.path.length ? issue.path.join('.') : 'respons';
    throw new ApiError(`Bentuk data tidak sesuai kontrak: ${field} — ${issue?.message ?? ''}`, response.status, url);
  }
  return parsed.data;
}

export function fetchProducts(filter: ProductFilter, signal?: AbortSignal): Promise<PagedProducts> {
  return getJson(`/api/products?${productSearchParams(filter)}`, pagedProductsSchema, signal);
}

export function fetchFilterOptions(signal?: AbortSignal): Promise<FilterOptions> {
  return getJson('/api/filter-options', filterOptionsSchema, signal);
}

export function fetchStores(filter: StoreFilter, signal?: AbortSignal): Promise<PagedStores> {
  return getJson(`/api/stores?${storeSearchParams(filter)}`, pagedStoresSchema, signal);
}

/** Snapshot history for one product, oldest first. */
const priceHistorySchema = z.array(pricePointSchema);

export function fetchPriceHistory(productId: number, signal?: AbortSignal): Promise<PricePoint[]> {
  return getJson(`/api/products/${productId}/history`, priceHistorySchema, signal);
}

// ---------------------------------------------------------------------------
// Store options
// ---------------------------------------------------------------------------

/**
 * One entry in the store dropdown.
 *
 * `getFilterOptions` covers marketplaces, keywords, locations and the price
 * range but not stores — there are as many stores as rows in the table, so the
 * store list is the store list. It is fetched once, sorted by product count so
 * the shops worth comparing are at the top of the dropdown.
 */
export type StoreOption = {
  id: number;
  label: string;
  marketplace: Marketplace;
  productCount: number;
};

/**
 * 200 is the schema's page ceiling and comfortably above the current 94 stores,
 * so the dropdown is one request rather than a paged search.
 *
 * `sort: 'name'` because it is the one ordering `getStores` executes: its
 * `products` and `avgPrice` branches order by `product_count` and `avg_price`
 * while those columns are aliased `"productCount"` and `"avgPrice"`, which
 * Postgres rejects. The order the picker actually wants is applied below.
 */
export const STORE_OPTIONS_FILTER: StoreFilter = storeFilterSchema.parse({
  pageSize: 200,
  sort: 'name',
  dir: 'asc',
});

/** Biggest shops first: a picker's job is to put the useful choices near the top. */
export function toStoreOptions(rows: StoreRow[]): StoreOption[] {
  return rows
    .map((row) => ({
      id: row.id,
      label: formatStoreName(row.username, row.name),
      marketplace: row.marketplace,
      productCount: row.productCount,
    }))
    .sort((a, b) => b.productCount - a.productCount || a.label.localeCompare(b.label, 'id'));
}
