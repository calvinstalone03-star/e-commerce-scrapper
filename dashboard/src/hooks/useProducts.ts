'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { fetchPriceHistory, fetchProducts, productSearchParams } from '@/lib/client-api';
import { productFilterSchema, type PagedProducts, type ProductFilter } from '@/lib/schemas';

/**
 * The products view's state and its queries.
 *
 * The filter lives in the URL, not in React state. That is what makes a
 * filtered table shareable and reload-proof, and it means the two client
 * components on this page (the filter bar and the table) need no shared parent
 * or context: both read the same URL and both write to it.
 */

/** Fields that narrow the result set, as opposed to ordering or paging it. */
const NARROWING_FIELDS = [
  'q',
  'marketplace',
  'storeId',
  'location',
  'minPrice',
  'maxPrice',
  'minSold',
  'minRating',
  'hasImage',
] as const satisfies ReadonlyArray<keyof ProductFilter>;

/**
 * Whether a filter change earns a Back step.
 *
 * `'replace'` is for a value the user is still in the middle of expressing — a
 * debounced text or number field, where every intermediate string would
 * otherwise become its own history entry and Back would walk out one character
 * at a time. `'push'` is for everything discrete: a page, a sort, a chosen
 * option, a cleared chip. Those are the steps someone means to undo.
 */
export type HistoryMode = 'push' | 'replace';

export type ProductFilterControls = {
  filter: ProductFilter;
  setFilter: (patch: Partial<ProductFilter>, history?: HistoryMode) => void;
  resetFilter: () => void;
  /** True when at least one narrowing filter is set — sorting and paging do not count. */
  isFiltered: boolean;
};

export function useProductFilter(): ProductFilterControls {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  // Keyed on the serialised query rather than the hook's return value so the
  // filter object keeps its identity across unrelated re-renders — it is a
  // query key and an effect dependency downstream.
  const filter = useMemo(
    () => productFilterSchema.parse(Object.fromEntries(new URLSearchParams(search))),
    [search],
  );

  const write = useCallback(
    (next: ProductFilter, history: HistoryMode) => {
      const query = productSearchParams(next).toString();
      const url = query ? `${pathname}?${query}` : pathname;
      // The native History API rather than router.replace: this page is a
      // dynamic Server Component, so a router navigation would re-run its SQL
      // on every keystroke to produce props the client query is already
      // fetching. Next syncs both pushState and replaceState into
      // useSearchParams, so the URL stays shareable either way — the choice
      // between them is purely about what the Back button should undo.
      if (history === 'push') {
        window.history.pushState(null, '', url);
      } else {
        window.history.replaceState(null, '', url);
      }
    },
    [pathname],
  );

  const setFilter = useCallback(
    (patch: Partial<ProductFilter>, history: HistoryMode = 'push') => {
      const next: ProductFilter = { ...filter, ...patch };
      // Page 7 of the old filter is usually past the end of the new one, and an
      // empty table right after tightening a filter reads as "no matches".
      if (patch.page === undefined) next.page = 1;
      write(next, history);
    },
    [filter, write],
  );

  const resetFilter = useCallback(() => {
    write(productFilterSchema.parse({}), 'push');
  }, [write]);

  const isFiltered = NARROWING_FIELDS.some((field) => filter[field] !== undefined);

  return { filter, setFilter, resetFilter, isFiltered };
}

/**
 * The server already rendered one page of results; this is that page, with the
 * filter it was fetched under so the hook can tell whether it still applies.
 */
export type ProductsSeed = {
  filter: ProductFilter;
  data: PagedProducts;
};

export function useProducts(filter: ProductFilter, seed?: ProductsSeed) {
  const key = productSearchParams(filter).toString();
  // `initialData` belongs to one query key. Handing the server's page to every
  // key would show the first page's rows under a filter that never asked for
  // them, and mark them fresh enough not to refetch.
  const initialData =
    seed && productSearchParams(seed.filter).toString() === key ? seed.data : undefined;

  return useQuery({
    queryKey: ['products', filter],
    queryFn: ({ signal }) => fetchProducts(filter, signal),
    // The single most important line for how this table feels: without it every
    // keystroke empties the table and the page jumps as the rows unmount.
    placeholderData: keepPreviousData,
    initialData,
  });
}

/**
 * Snapshot history for one product.
 *
 * `enabled` is the caller's answer to "is there more than one snapshot" — with
 * a single observation there is nothing to plot and the row already carries it,
 * so the request is not worth making.
 */
export function usePriceHistory(productId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['price-history', productId],
    queryFn: ({ signal }) => fetchPriceHistory(productId, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}
