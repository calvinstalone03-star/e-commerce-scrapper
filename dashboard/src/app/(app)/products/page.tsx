import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { Filters } from '@/components/Filters';
import { ProductTable } from '@/components/ProductTable';
import { Skeleton } from '@/components/ui';
import { STORE_OPTIONS_FILTER, productSearchParams, toStoreOptions } from '@/lib/client-api';
import { resolveMinGapHours } from '@/lib/price-change';
import { getFilterOptions, getProducts, getStores } from '@/lib/queries';
import { productFilterSchema, type PagedProducts } from '@/lib/schemas';

export const metadata: Metadata = {
  title: 'Produk',
  description: 'Semua listing yang pernah discrape, dengan harga dari snapshot terbaru per produk.',
};

/**
 * The product view.
 *
 * A Server Component: the first page of rows and both option lists are already
 * in the HTML, so the table is readable before any JavaScript runs. The client
 * components below take over from there, and because they are handed exactly
 * what the server fetched — under the filter it was fetched with — the first
 * thing TanStack Query does is nothing.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Cannot throw: every field carries `.catch()`, so a stale bookmark degrades
  // to the default view rather than to an error page.
  const filter = productFilterSchema.parse(await searchParams);

  const [products, options, stores] = await Promise.all([
    getProducts(filter),
    getFilterOptions(),
    getStores(STORE_OPTIONS_FILTER),
  ]);

  // `getProducts` turns `page` into an OFFSET without bounding it, so a
  // bookmarked `?page=9` on a three-page list returns nothing while `total`
  // still reports 128 rows — an empty table under a pager claiming to show rows
  // 101–128. The row count only exists once the query has run, so the correction
  // happens here, and it is a redirect rather than a silent clamp: the table
  // reads the page number back out of the URL, so leaving `?page=9` in the
  // address bar would just hand the client the same out-of-range request again.
  const lastPage = Math.max(1, Math.ceil(products.total / filter.pageSize));
  if (products.total > 0 && filter.page > lastPage) {
    redirect(`/products?${productSearchParams({ ...filter, page: lastPage })}`);
  }

  const initialData: PagedProducts = {
    rows: products.rows,
    total: products.total,
    page: filter.page,
    pageSize: filter.pageSize,
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Produk</h1>
        <p className="max-w-2xl text-sm text-muted">
          Setiap listing yang pernah muncul di hasil scrape, dengan harga dari snapshot terbarunya.
          Saring lalu urutkan untuk melihat apa saja yang sudah terkumpul — itu
          perbandingan yang sudah bisa dijawab hari ini, sementara riwayat harga per produk baru
          terbentuk setelah scrape kedua.
        </p>
      </header>

      {/* Both children read the filter from the URL, and useSearchParams falls
          back to client rendering if this route is ever prerendered. */}
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <Filters initialOptions={options} initialStores={toStoreOptions(stores.rows)} />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        {/* The comparison window is a server setting, so the legend states the
            real number instead of the documented default. */}
        <ProductTable
          initialFilter={filter}
          initialData={initialData}
          minGapHours={resolveMinGapHours()}
        />
      </Suspense>
    </div>
  );
}
