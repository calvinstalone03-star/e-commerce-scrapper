'use client';

import { useQuery } from '@tanstack/react-query';

import {
  fetchFilterOptions,
  fetchStores,
  toStoreOptions,
  STORE_OPTIONS_FILTER,
  type StoreOption,
} from '@/lib/client-api';
import type { FilterOptions } from '@/lib/schemas';

/**
 * The lists behind the filter controls.
 *
 * A new marketplace, keyword or location only appears when a scrape runs, which
 * is minutes of work by hand — nothing like the cadence of a user changing
 * filters. Half an hour of trust means the dropdowns cost one request per
 * session instead of one per mount, and the server hands both lists over as
 * initial data anyway, so a first load costs none at all.
 */
const OPTIONS_STALE_TIME = 30 * 60_000;

export function useFilterOptions(initialData?: FilterOptions) {
  return useQuery({
    queryKey: ['filter-options'],
    queryFn: ({ signal }) => fetchFilterOptions(signal),
    staleTime: OPTIONS_STALE_TIME,
    gcTime: OPTIONS_STALE_TIME,
    initialData,
  });
}

export function useStoreOptions(initialData?: StoreOption[]) {
  return useQuery({
    queryKey: ['store-options'],
    queryFn: async ({ signal }) => {
      const page = await fetchStores(STORE_OPTIONS_FILTER, signal);
      return toStoreOptions(page.rows);
    },
    staleTime: OPTIONS_STALE_TIME,
    gcTime: OPTIONS_STALE_TIME,
    initialData,
  });
}

export type { StoreOption };
