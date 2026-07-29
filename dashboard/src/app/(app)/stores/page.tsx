import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { StoreTable } from '@/components/StoreTable';
import { Input, Select } from '@/components/ui';
import { storeSearchParams } from '@/lib/client-api';
import { MARKETPLACE_LABELS } from '@/lib/format';
import { getFilterOptions, getStores } from '@/lib/queries';
import { storeFilterSchema } from '@/lib/schemas';

export const metadata: Metadata = {
  title: 'Toko',
  description: 'Semua toko yang terekam, dengan jumlah produk dan rentang harganya.',
};

const SORT_LABELS: Record<StoreSort, string> = {
  products: 'Jumlah produk',
  avgPrice: 'Harga rata-rata',
  name: 'Nama toko',
};

type StoreSort = 'products' | 'avgPrice' | 'name';

export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = storeFilterSchema.parse(await searchParams);
  const [{ rows, total }, options] = await Promise.all([getStores(filter), getFilterOptions()]);

  // `getStores` turns `page` into an OFFSET without checking it against the row
  // count, so `?page=9` on a two-page list comes back empty while `total` still
  // says 94 — and the pager, which derives its range from the page number,
  // would announce rows nobody is looking at. The row count is not known until
  // the query has run, so the correction happens here. A redirect rather than a
  // clamp, so the pager's own links and a reload agree with what was served.
  const lastPage = Math.max(1, Math.ceil(total / filter.pageSize));
  if (total > 0 && filter.page > lastPage) {
    redirect(`/stores?${storeSearchParams({ ...filter, page: lastPage })}`);
  }

  const filtered = Boolean(filter.q || filter.marketplace || filter.location);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Toko</h1>
        <p className="max-w-2xl text-sm text-muted">
          Setiap penjual yang pernah muncul di hasil scrape, dengan jumlah produk dan rentang
          harganya. Lokasi hanya terisi bila marketplace menampilkannya, jadi kolom kosong bukan
          berarti tokonya tanpa alamat.
        </p>
      </header>

      {/*
        next/form keeps filter state in the URL instead of in React state: the page
        stays a Server Component, the back button works, and a filtered view is a
        link someone can send. Each control is keyed by its own URL value so it
        re-mounts when that value changes — without the key an uncontrolled input
        keeps whatever the DOM node already held after a client-side navigation,
        and "Reset" would leave the old text sitting in the box.
      */}
      {/*
        Each control sits in a width-setting wrapper rather than carrying its own
        width class: the kit's fields are `w-full` by design and `cn` does not
        merge Tailwind classes, so a `w-auto` passed in here would not win and
        every control would claim its own row.
      */}
      <Form action="/stores" className="flex flex-wrap items-center gap-2">
        <div className="min-w-56 flex-1">
          <Input
            key={filter.q ?? ''}
            type="search"
            name="q"
            defaultValue={filter.q ?? ''}
            placeholder="Cari nama atau username toko"
            aria-label="Cari toko"
          />
        </div>

        <div className="w-full sm:w-44">
          <Select
            key={`marketplace-${filter.marketplace ?? ''}`}
            name="marketplace"
            defaultValue={filter.marketplace ?? ''}
            aria-label="Marketplace"
          >
            <option value="">Semua marketplace</option>
            {options.marketplaces.map((marketplace) => (
              <option key={marketplace} value={marketplace}>
                {MARKETPLACE_LABELS[marketplace] ?? marketplace}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-full sm:w-44">
          <Select
            key={`location-${filter.location ?? ''}`}
            name="location"
            defaultValue={filter.location ?? ''}
            aria-label="Lokasi"
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
        </div>

        <div className="w-full sm:w-52">
          <Select
            key={`sort-${filter.sort}`}
            name="sort"
            defaultValue={filter.sort}
            aria-label="Urutkan"
          >
            {(Object.keys(SORT_LABELS) as StoreSort[]).map((value) => (
              <option key={value} value={value}>
                Urutkan: {SORT_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>

        {/* Direction is owned by the column headers; carry it through a submit so
            re-filtering does not quietly flip a column back to descending. */}
        <input key={`dir-${filter.dir}`} type="hidden" name="dir" defaultValue={filter.dir} />

        <button
          type="submit"
          className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Terapkan
        </button>

        {filtered ? (
          <Link
            href="/stores"
            className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            Reset
          </Link>
        ) : null}
      </Form>

      <StoreTable rows={rows} filter={filter} total={total} filtered={filtered} />
    </div>
  );
}
