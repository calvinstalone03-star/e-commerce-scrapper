import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { StoreTable } from '@/components/StoreTable';
import { UrlChoice } from '@/components/UrlChoice';
import { Input } from '@/components/ui';
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Toko</h1>
          <p className="max-w-2xl text-sm text-muted">
            Setiap penjual yang pernah muncul di hasil scrape, dengan jumlah produk dan rentang
            harganya. Lokasi hanya terisi bila marketplace menampilkannya, jadi kolom kosong bukan
            berarti tokonya tanpa alamat.
          </p>
        </div>

        {/*
          A plain link, not a button with state: this is a download, and the
          response carries its own filename. `download` is a hint the browser
          mostly ignores for an attachment, but it keeps the file named right
          when someone middle-clicks it.

          The instruction travels in the file's own header as well — a
          stores.txt sitting in ~/Downloads is inert, and the thing that makes
          it work is knowing where to put it.
        */}
        <div className="text-right">
          <a
            href="/api/stores/export"
            download="stores.txt"
            className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm text-foreground transition-colors hover:bg-surface-muted"
          >
            Unduh stores.txt
          </a>
          <p className="mt-1 max-w-64 text-xs text-muted">
            Daftar toko untuk disimpan ke <code>config/stores.txt</code>. Itu yang dijalankan
            tombol “Scrape semua toko” di extension.
          </p>
        </div>
      </header>

      {/*
        Search stays a `next/form` — a text box wants a submit — while every
        choice navigates on selection through the shared dropdown. Both keep the
        state in the URL, so the page remains a Server Component and a filtered
        view is still a link.
      */}
      <div className="space-y-3">
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
          {/* The rest of the filter travels with the search, or submitting would
              silently reset it. */}
          {filter.marketplace ? (
            <input type="hidden" name="marketplace" value={filter.marketplace} />
          ) : null}
          {filter.location ? <input type="hidden" name="location" value={filter.location} /> : null}
          <input type="hidden" name="sort" value={filter.sort} />
          <input type="hidden" name="dir" value={filter.dir} />
          <input type="hidden" name="pageSize" value={filter.pageSize} />

          <button
            type="submit"
            className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Cari
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

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UrlChoice
            label="Marketplace"
            param="marketplace"
            value={filter.marketplace ?? 'all'}
            options={[
              { value: 'all', label: 'Semua marketplace' },
              ...options.marketplaces.map((marketplace) => ({
                value: marketplace,
                label: MARKETPLACE_LABELS[marketplace] ?? marketplace,
              })),
            ]}
          />
          <UrlChoice
            label="Lokasi toko"
            param="location"
            value={filter.location ?? 'all'}
            options={[
              {
                value: 'all',
                label: options.locations.length === 0 ? 'Lokasi belum terekam' : 'Semua lokasi',
              },
              ...options.locations.map((location) => ({ value: location, label: location })),
            ]}
          />
          <UrlChoice
            label="Urutkan"
            param="sort"
            value={filter.sort}
            options={(Object.keys(SORT_LABELS) as StoreSort[]).map((value) => ({
              value,
              label: SORT_LABELS[value],
            }))}
          />
          <UrlChoice
            label="Baris per halaman"
            param="pageSize"
            value={String(filter.pageSize)}
            options={[10, 25, 50, 100].map((size) => ({
              value: String(size),
              label: `${size} baris`,
            }))}
          />
        </div>
      </div>

      <StoreTable rows={rows} filter={filter} total={total} filtered={filtered} />
    </div>
  );
}
