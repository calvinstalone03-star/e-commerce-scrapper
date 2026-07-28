'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Card, Input, Select } from '@/components/ui';
import { useFilterOptions, useStoreOptions } from '@/hooks/useFilterOptions';
import { useProductFilter } from '@/hooks/useProducts';
import type { StoreOption } from '@/lib/client-api';
import { MARKETPLACE_LABELS, formatPrice, formatSold } from '@/lib/format';
import type { FilterOptions, Marketplace, ProductFilter } from '@/lib/schemas';

/**
 * Every filter the product query understands, offered only where the data can
 * answer it: the dropdowns are built from `getFilterOptions`, so picking a
 * keyword or a location that returns nothing is not a state the UI can reach.
 *
 * Text and number fields are debounced, selects are not — they differ in kind.
 * A half-typed word is not a filter anyone meant; a chosen option always is.
 */

const RATING_STEPS = [3, 4, 4.5, 4.8] as const;
const PAGE_SIZES = [25, 50, 100] as const;

const SORT_LABELS: Record<ProductFilter['sort'], string> = {
  sold: 'Terjual',
  price: 'Harga',
  rating: 'Rating',
  name: 'Nama',
  scrapedAt: 'Terakhir discrape',
};

type FiltersProps = {
  /** Server-rendered lists, so every control is usable in the first paint. */
  initialOptions: FilterOptions;
  initialStores: StoreOption[];
};

export function Filters({ initialOptions, initialStores }: FiltersProps) {
  const { filter, setFilter, resetFilter, isFiltered } = useProductFilter();
  const optionsQuery = useFilterOptions(initialOptions);
  const storesQuery = useStoreOptions(initialStores);

  const options = optionsQuery.data ?? initialOptions;
  const stores = storesQuery.data ?? initialStores;
  const ids = useId();

  // Every debounced commit writes with `'replace'`: a half-typed word is not a
  // step anyone means to undo, and pushing one per pause would turn a single
  // Back press into a slow rewind through "l", "le", "leg". Discrete controls —
  // the selects, the chips, the sort and page buttons — take the default and do
  // earn a history entry.
  const [query, setQuery] = useDebouncedInput(filter.q ?? '', (value) =>
    setFilter({ q: value.trim() === '' ? undefined : value.trim() }, 'replace'),
  );
  const [minPrice, setMinPrice] = useDebouncedInput(numberToInput(filter.minPrice), (value) =>
    setFilter({ minPrice: inputToNumber(value) }, 'replace'),
  );
  const [maxPrice, setMaxPrice] = useDebouncedInput(numberToInput(filter.maxPrice), (value) =>
    setFilter({ maxPrice: inputToNumber(value) }, 'replace'),
  );
  const [minSold, setMinSold] = useDebouncedInput(numberToInput(filter.minSold), (value) =>
    setFilter({ minSold: inputToNumber(value) }, 'replace'),
  );

  // A shop belongs to one marketplace, so narrowing by marketplace narrows the
  // shops worth offering with it.
  const storeChoices = filter.marketplace
    ? stores.filter((store) => store.marketplace === filter.marketplace)
    : stores;

  const chips = activeChips(filter, stores, setFilter);

  return (
    <Card>
      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Cari nama produk" htmlFor={`${ids}-q`} className="lg:col-span-2">
          <Input
            id={`${ids}-q`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="mis. lego technic"
            autoComplete="off"
          />
        </Field>

        <Field label="Marketplace" htmlFor={`${ids}-marketplace`}>
          <Select
            id={`${ids}-marketplace`}
            value={filter.marketplace ?? ''}
            onChange={(event) =>
              setFilter({
                marketplace: (event.target.value || undefined) as Marketplace | undefined,
                // The selected shop may belong to the marketplace being filtered out.
                storeId: undefined,
              })
            }
          >
            <option value="">Semua marketplace</option>
            {options.marketplaces.map((marketplace) => (
              <option key={marketplace} value={marketplace}>
                {MARKETPLACE_LABELS[marketplace] ?? marketplace}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Toko" htmlFor={`${ids}-store`}>
          <Select
            id={`${ids}-store`}
            value={filter.storeId ?? ''}
            onChange={(event) =>
              setFilter({ storeId: event.target.value ? Number(event.target.value) : undefined })
            }
            disabled={storeChoices.length === 0}
          >
            <option value="">Semua toko ({storeChoices.length})</option>
            {storeChoices.map((store) => (
              <option key={store.id} value={store.id}>
                {store.label} · {store.productCount} produk
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Keyword" htmlFor={`${ids}-keyword`}>
          <Select
            id={`${ids}-keyword`}
            value={filter.keyword ?? ''}
            onChange={(event) => setFilter({ keyword: event.target.value || undefined })}
            disabled={options.keywords.length === 0}
          >
            <option value="">
              {options.keywords.length === 0 ? 'Keyword belum terekam' : 'Semua keyword'}
            </option>
            {options.keywords.map((keyword) => (
              <option key={keyword} value={keyword}>
                {keyword}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Lokasi toko" htmlFor={`${ids}-location`}>
          <Select
            id={`${ids}-location`}
            value={filter.location ?? ''}
            onChange={(event) => setFilter({ location: event.target.value || undefined })}
            disabled={options.locations.length === 0}
          >
            <option value="">
              {options.locations.length === 0 ? 'Lokasi belum terekam' : 'Semua lokasi'}
            </option>
            {options.locations.map((location) => (
              <option key={location} value={location}>
                {location}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Harga minimum" htmlFor={`${ids}-min-price`}>
          <Input
            id={`${ids}-min-price`}
            inputMode="numeric"
            value={minPrice}
            onChange={(event) => setMinPrice(event.target.value)}
            placeholder={priceHint(options.priceRange.min)}
          />
        </Field>

        <Field label="Harga maksimum" htmlFor={`${ids}-max-price`}>
          <Input
            id={`${ids}-max-price`}
            inputMode="numeric"
            value={maxPrice}
            onChange={(event) => setMaxPrice(event.target.value)}
            placeholder={priceHint(options.priceRange.max)}
          />
        </Field>

        <Field label="Terjual minimum" htmlFor={`${ids}-min-sold`}>
          <Input
            id={`${ids}-min-sold`}
            inputMode="numeric"
            value={minSold}
            onChange={(event) => setMinSold(event.target.value)}
            placeholder="0"
          />
        </Field>

        <Field label="Rating minimum" htmlFor={`${ids}-min-rating`}>
          <Select
            id={`${ids}-min-rating`}
            value={filter.minRating ?? ''}
            onChange={(event) =>
              setFilter({ minRating: event.target.value ? Number(event.target.value) : undefined })
            }
          >
            <option value="">Semua rating</option>
            {RATING_STEPS.map((step) => (
              <option key={step} value={step}>
                {step.toLocaleString('id-ID')} ke atas
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Urutkan" htmlFor={`${ids}-sort`}>
          <div className="flex gap-2">
            <Select
              id={`${ids}-sort`}
              value={filter.sort}
              onChange={(event) => setFilter({ sort: event.target.value as ProductFilter['sort'] })}
            >
              {(Object.keys(SORT_LABELS) as Array<ProductFilter['sort']>).map((field) => (
                <option key={field} value={field}>
                  {SORT_LABELS[field]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => setFilter({ dir: filter.dir === 'asc' ? 'desc' : 'asc' })}
              aria-label={
                filter.dir === 'asc' ? 'Urutan menaik, ubah ke menurun' : 'Urutan menurun, ubah ke menaik'
              }
              className="h-9 shrink-0 rounded-md border border-line bg-surface px-3 text-sm transition-colors hover:bg-surface-muted"
            >
              {filter.dir === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </Field>

        <Field label="Baris per halaman" htmlFor={`${ids}-page-size`}>
          <Select
            id={`${ids}-page-size`}
            value={filter.pageSize}
            onChange={(event) => setFilter({ pageSize: Number(event.target.value) })}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} baris
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-end">
          <label className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm transition-colors hover:bg-surface-muted">
            <input
              type="checkbox"
              checked={filter.hasImage === true}
              // Absent when off, never `false`: the schema coerces with
              // `z.coerce.boolean()`, and `?hasImage=false` would read as true.
              onChange={(event) => setFilter({ hasImage: event.target.checked || undefined })}
              className="size-4 accent-accent"
            />
            Hanya yang ada gambar
          </label>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-xs text-muted">Filter aktif</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.remove}
              aria-label={`Hapus filter ${chip.label}`}
              className="group inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted py-1 pr-1.5 pl-2 text-xs text-foreground transition-colors hover:border-muted/50"
            >
              {chip.label}
              <span aria-hidden className="text-muted transition-colors group-hover:text-foreground">
                ×
              </span>
            </button>
          ))}
          {isFiltered ? (
            <button
              type="button"
              onClick={resetFilter}
              className="ml-auto text-xs text-accent underline-offset-4 hover:underline"
            >
              Hapus semua filter
            </button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A field that lags the URL by `delay`.
 *
 * The draft lives here so typing is never blocked on a round trip, and the
 * effect only writes once the draft has diverged from the committed value —
 * which is also what keeps it from writing the URL back to what it already says.
 */
function useDebouncedInput(
  committed: string,
  commit: (value: string) => void,
  delay = 300,
): readonly [string, (value: string) => void] {
  const [draft, setDraft] = useState(committed);
  const [lastSeen, setLastSeen] = useState(committed);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const commitRef = useRef(commit);

  useEffect(() => {
    commitRef.current = commit;
  });

  // Adjusted during render rather than in an effect: an effect would paint the
  // stale draft once before correcting it.
  if (committed !== lastSeen) {
    setLastSeen(committed);
    // Our own write arriving back through the URL must not rewind an input the
    // user has kept typing into. Router updates are transitions, so a keystroke
    // can land between the write and the re-render. Only a change from
    // somewhere else — Reset, a removed chip, the back button — replaces the
    // draft.
    if (committed !== lastSent) setDraft(committed);
  }

  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      setLastSent(draft);
      commitRef.current(draft);
    }, delay);
    return () => clearTimeout(timer);
  }, [draft, committed, delay]);

  return [draft, setDraft] as const;
}

function numberToInput(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** The filter schema types its bounds as integers, so a typed bound becomes one here. */
function inputToNumber(value: string): number | undefined {
  const digits = value.replace(/\D/g, '');
  return digits === '' ? undefined : Number(digits);
}

function priceHint(value: string | null): string {
  return value === null ? '0' : formatPrice(value);
}

type Chip = { key: string; label: string; remove: () => void };

function activeChips(
  filter: ProductFilter,
  stores: StoreOption[],
  setFilter: (patch: Partial<ProductFilter>) => void,
): Chip[] {
  const chips: Chip[] = [];
  const add = (key: string, label: string, clear: Partial<ProductFilter>) =>
    chips.push({ key, label, remove: () => setFilter(clear) });

  if (filter.q) add('q', `Cari: “${filter.q}”`, { q: undefined });
  if (filter.marketplace) {
    const label = MARKETPLACE_LABELS[filter.marketplace] ?? filter.marketplace;
    add('marketplace', `Marketplace: ${label}`, { marketplace: undefined });
  }
  if (filter.storeId !== undefined) {
    const store = stores.find((candidate) => candidate.id === filter.storeId);
    add('storeId', `Toko: ${store?.label ?? `#${filter.storeId}`}`, { storeId: undefined });
  }
  if (filter.keyword) add('keyword', `Keyword: ${filter.keyword}`, { keyword: undefined });
  if (filter.location) add('location', `Lokasi: ${filter.location}`, { location: undefined });
  if (filter.minPrice !== undefined) {
    add('minPrice', `Harga ≥ ${formatPrice(filter.minPrice)}`, { minPrice: undefined });
  }
  if (filter.maxPrice !== undefined) {
    add('maxPrice', `Harga ≤ ${formatPrice(filter.maxPrice)}`, { maxPrice: undefined });
  }
  if (filter.minSold !== undefined) {
    add('minSold', `Terjual ≥ ${formatSold(filter.minSold)}`, { minSold: undefined });
  }
  if (filter.minRating !== undefined) {
    const label = filter.minRating.toLocaleString('id-ID');
    add('minRating', `Rating ≥ ${label}`, { minRating: undefined });
  }
  if (filter.hasImage) add('hasImage', 'Ada gambar', { hasImage: undefined });

  return chips;
}
