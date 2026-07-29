'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { ProductImage } from '@/components/ProductImage';
import { Badge, Pagination, Skeleton, TBody, TD, TH, THead, TR, Table } from '@/components/ui';
import {
  useProductFilter,
  useProducts,
  usePriceHistory,
  type ProductsSeed,
} from '@/hooks/useProducts';
import {
  MARKETPLACE_LABELS,
  formatDate,
  formatDateTime,
  formatPrice,
  formatRating,
  formatSold,
  formatStoreName,
  isPlaceholderStore,
} from '@/lib/format';
import type { ProductFilter, ProductRow } from '@/lib/schemas';

/**
 * One page of products.
 *
 * Sorting and paging are SQL, not table state. The component only ever holds
 * the fifty rows the server sent, so sorting them here would reorder fifty rows
 * out of a hundred and twenty-eight and call the result "sorted by price".
 * Every header writes the filter in the URL instead, and the query re-runs.
 */

/** Column id to the sort field its header writes. Columns absent from this map do not sort. */
const SORT_FIELDS: Record<string, ProductFilter['sort'] | undefined> = {
  name: 'name',
  price: 'price',
  sold: 'sold',
  rating: 'rating',
  scrapedAt: 'scrapedAt',
};

const NUMERIC_COLUMNS = new Set(['price', 'sold', 'rating', 'scrapedAt']);

const SORT_LABELS: Record<ProductFilter['sort'], string> = {
  sold: 'Terjual',
  price: 'Harga',
  rating: 'Rating',
  name: 'Nama',
  scrapedAt: 'Terakhir discrape',
};

/** Stable identity, so an unchanged query does not remount every row. */
const NO_ROWS: ProductRow[] = [];

/**
 * The chart arrives with the drawer, not with the page.
 *
 * Recharts is the heaviest thing this route could pull in, and it is only ever
 * seen by someone who has opened a product that has more than one snapshot —
 * which today is nobody, since the scraper has run once.
 */
const PriceChart = dynamic(
  () => import('@/components/PriceChart').then((module) => module.PriceChart),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> },
);

type ProductTableProps = {
  /** The filter the server rendered `initialData` under. */
  initialFilter: ProductFilter;
  initialData: ProductsSeed['data'];
};

export function ProductTable({ initialFilter, initialData }: ProductTableProps) {
  const { filter, setFilter, resetFilter, isFiltered } = useProductFilter();
  const seed = useMemo<ProductsSeed>(
    () => ({ filter: initialFilter, data: initialData }),
    [initialFilter, initialData],
  );
  const { data, error, isError, isPending, isFetching, refetch } = useProducts(filter, seed);
  const [selected, setSelected] = useState<ProductRow | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const openHistory = useCallback((product: ProductRow) => setSelected(product), []);

  const columns = useMemo<ColumnDef<ProductRow>[]>(() => buildColumns(openHistory), [openHistory]);

  const rows = data?.rows ?? NO_ROWS;
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.id),
    // The page in hand is the whole truth this component has: ordering, paging
    // and filtering all happened in Postgres before it arrived.
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
  });

  // Page 2 should start at row 51, not halfway down it.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter.page]);

  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / filter.pageSize));
  // A shared `?page=9` on a three-page list is an OFFSET past the end: the API
  // answers with zero rows and a total of 128, and the pager — which clamps for
  // display only — would then claim to be showing rows 101–128 above an empty
  // table. The buttons cannot reach this state, but a URL can, so walk back to
  // the last real page instead of rendering the contradiction.
  const outOfRange = total > 0 && filter.page > lastPage;
  useEffect(() => {
    // `'replace'`, emphatically: pushing the correction would put the broken
    // page back one Back press away, and pressing Back would bounce forward
    // again the moment this effect re-ran.
    if (outOfRange) setFilter({ page: lastPage }, 'replace');
  }, [outOfRange, lastPage, setFilter]);

  const toggleSort = (field: ProductFilter['sort']) => {
    if (filter.sort === field) {
      setFilter({ dir: filter.dir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    // Names read best A→Z; every other column is a "most of it first" question.
    setFilter({ sort: field, dir: field === 'name' ? 'asc' : 'desc' });
  };

  return (
    <div className="space-y-3">
      {isError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
          <span>Gagal memuat produk: {error?.message ?? 'penyebab tidak diketahui'}</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-md border border-negative/40 px-2 py-1 text-xs font-medium transition-colors hover:bg-negative/10"
          >
            Coba lagi
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 text-xs text-muted">
        <p>
          Diurutkan menurut{' '}
          <span className="font-medium text-foreground">{SORT_LABELS[filter.sort]}</span>{' '}
          {filter.dir === 'asc' ? 'menaik' : 'menurun'}
        </p>
        <span aria-live="polite">{isFetching ? 'Memuat…' : ''}</span>
      </div>

      <Table
        containerRef={scrollRef}
        containerClassName={isFetching ? 'opacity-70 transition-opacity' : undefined}
      >
        <caption className="sr-only">
          Daftar produk beserta harga, jumlah terjual, dan rating dari snapshot terbaru
        </caption>

        <THead>
          {table.getHeaderGroups().map((headerGroup) => (
            <TR key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sortField = SORT_FIELDS[header.column.id];
                const active = sortField !== undefined && filter.sort === sortField;
                const label = flexRender(header.column.columnDef.header, header.getContext());
                return (
                  <TH
                    key={header.id}
                    numeric={NUMERIC_COLUMNS.has(header.column.id)}
                    aria-sort={
                      active ? (filter.dir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                  >
                    {sortField ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(sortField)}
                        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
                          active ? 'text-foreground' : ''
                        }`}
                      >
                        {label}
                        <span aria-hidden className={active ? '' : 'opacity-0'}>
                          {active && filter.dir === 'asc' ? '↑' : '↓'}
                        </span>
                      </button>
                    ) : (
                      label
                    )}
                  </TH>
                );
              })}
            </TR>
          ))}
        </THead>

        <TBody>
          {isPending ? (
            Array.from({ length: 8 }, (_, index) => (
              <TR key={index}>
                <TD colSpan={columns.length}>
                  <Skeleton className="h-9 w-full" />
                </TD>
              </TR>
            ))
          ) : rows.length === 0 ? (
            <TR>
              <TD colSpan={columns.length}>
                {outOfRange ? (
                  <EmptyState
                    title="Halaman ini kosong"
                    description={`Nomor halaman yang diminta melewati baris terakhir. Kembali ke halaman ${lastPage}.`}
                    action={
                      <button
                        type="button"
                        onClick={() => setFilter({ page: lastPage })}
                        className="text-sm text-accent underline-offset-4 hover:underline"
                      >
                        Ke halaman terakhir
                      </button>
                    }
                  />
                ) : (
                  <EmptyState
                    title="Tidak ada produk yang cocok"
                    description={
                      isFiltered
                        ? 'Filter yang aktif tidak menyisakan satu produk pun. Longgarkan salah satunya, atau mulai lagi dari daftar penuh.'
                        : 'Belum ada produk di database. Jalankan scraper terlebih dahulu, lalu muat ulang halaman ini.'
                    }
                    action={
                      isFiltered ? (
                        <button
                          type="button"
                          onClick={resetFilter}
                          className="text-sm text-accent underline-offset-4 hover:underline"
                        >
                          Hapus semua filter
                        </button>
                      ) : null
                    }
                  />
                )}
              </TD>
            </TR>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TR
                key={row.id}
                onClick={() => openHistory(row.original)}
                className="cursor-pointer"
              >
                {row.getVisibleCells().map((cell) => (
                  <TD key={cell.id} numeric={NUMERIC_COLUMNS.has(cell.column.id)}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TD>
                ))}
              </TR>
            ))
          )}
        </TBody>
      </Table>

      <Pagination
        // The page being corrected to, not the one the URL still holds, so the
        // range never describes rows the table is not showing.
        page={Math.min(filter.page, lastPage)}
        pageSize={filter.pageSize}
        total={total}
        onPageChange={(page) => setFilter({ page })}
      />

      {selected ? (
        <PriceHistoryPanel product={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function buildColumns(openHistory: (product: ProductRow) => void): ColumnDef<ProductRow>[] {
  return [
    {
      id: 'image',
      header: () => <span className="sr-only">Gambar</span>,
      cell: ({ row }) => (
        <ProductImage src={row.original.image} alt={row.original.name} size={44} />
      ),
    },
    {
      id: 'name',
      accessorKey: 'name',
      header: 'Produk',
      cell: ({ row }) => {
        const product = row.original;
        const name = product.name ?? 'Tanpa nama';
        return (
          <div className="flex max-w-md min-w-56 flex-col gap-1">
            {product.url ? (
              <a
                href={product.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="line-clamp-2 font-medium text-foreground underline-offset-4 hover:underline"
              >
                {name}
              </a>
            ) : (
              <span className="line-clamp-2 font-medium text-foreground">{name}</span>
            )}
            <Badge variant={product.marketplace} className="self-start">
              {MARKETPLACE_LABELS[product.marketplace] ?? product.marketplace}
            </Badge>
          </div>
        );
      },
    },
    {
      id: 'store',
      header: 'Toko',
      cell: ({ row }) => {
        const product = row.original;
        if (product.storeId === null) return <span className="text-muted">–</span>;
        return (
          <div className="flex max-w-44 flex-col">
            <Link
              href={`/stores/${product.storeId}`}
              prefetch={false}
              onClick={(event) => event.stopPropagation()}
              className="truncate text-foreground underline-offset-4 hover:underline"
            >
              {formatStoreName(product.storeUsername, null)}
            </Link>
            {isPlaceholderStore(product.storeUsername) ? (
              // Shopee's search cards carry the shop id but no slug, so this is
              // labelled as the number it is rather than passed off as a name.
              <span className="text-xs text-muted">nama toko tidak terekam</span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'price',
      accessorKey: 'price',
      header: 'Harga',
      cell: ({ row }) => (
        <span className="font-medium text-foreground">{formatPrice(row.original.price)}</span>
      ),
    },
    {
      id: 'sold',
      accessorKey: 'sold',
      header: 'Terjual',
      cell: ({ row }) => formatSold(row.original.sold),
    },
    {
      id: 'rating',
      accessorKey: 'ratingStar',
      header: 'Rating',
      cell: ({ row }) => {
        const rating = formatRating(row.original.ratingStar);
        return rating === '–' ? <span className="text-muted">–</span> : rating;
      },
    },
    {
      id: 'scrapedAt',
      accessorKey: 'scrapedAt',
      header: 'Terakhir discrape',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted" title={formatDateTime(row.original.scrapedAt)}>
          {formatDate(row.original.scrapedAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Aksi</span>,
      // The row is clickable, but a table row is not a control: this is the
      // affordance a keyboard or screen reader can actually reach.
      cell: ({ row }) => (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openHistory(row.original);
          }}
          aria-haspopup="dialog"
          className="rounded-md border border-line px-2 py-1 text-xs font-medium whitespace-nowrap text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
        >
          Riwayat
        </button>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Price history drawer
// ---------------------------------------------------------------------------

function PriceHistoryPanel({
  product,
  onClose,
}: {
  product: ProductRow;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // One snapshot is not a history. The row already carries that single
  // observation, so there is nothing worth a request either.
  const hasHistory = product.snapshotCount > 1;
  const { data: points, isError, error } = usePriceHistory(product.id, hasHistory);

  useEffect(() => {
    // showModal, not the `open` attribute: the top layer, Escape, focus
    // trapping and inertness of the page behind all come with it.
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        // The backdrop is part of the dialog element, so a click that lands on
        // the element itself came from outside the panel.
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label={`Riwayat harga ${product.name ?? 'produk'}`}
      // `left-auto` undoes the UA stylesheet's `inset-inline-start: 0`, which
      // would otherwise over-constrain the box and pin the panel to the left.
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-full w-full max-w-2xl border-l border-line bg-surface p-0 text-foreground backdrop:bg-black/45"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <ProductImage src={product.image} alt={product.name} size={48} />

          <div className="min-w-0 flex-1">
            <h2 className="text-sm leading-snug font-semibold">
              {product.url ? (
                <a
                  href={product.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 hover:underline"
                >
                  {product.name ?? 'Tanpa nama'}
                </a>
              ) : (
                (product.name ?? 'Tanpa nama')
              )}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <Badge variant={product.marketplace}>
                {MARKETPLACE_LABELS[product.marketplace] ?? product.marketplace}
              </Badge>
              <span>{formatStoreName(product.storeUsername, null)}</span>
              {product.storeLocation ? <span>· {product.storeLocation}</span> : null}
            </p>
          </div>

          <button
            type="button"
            autoFocus
            onClick={() => dialogRef.current?.close()}
            className="rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            Tutup
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Harga" value={formatPrice(product.price)} />
            <Metric label="Terjual" value={formatSold(product.sold)} />
            <Metric label="Rating" value={formatRating(product.ratingStar)} />
            <Metric label="Snapshot" value={formatSold(product.snapshotCount)} />
          </dl>

          {!hasHistory ? (
            <EmptyState
              title="Belum ada riwayat harga"
              description={`Produk ini baru punya satu snapshot, diambil ${formatDateTime(
                product.scrapedAt,
              )}. Grafik butuh minimal dua titik, jadi scrape halaman ini lagi di hari lain dan riwayatnya akan terbentuk sendiri.`}
            />
          ) : isError ? (
            <p className="rounded-md border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
              Gagal memuat riwayat: {error?.message ?? 'penyebab tidak diketahui'}
            </p>
          ) : points === undefined ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <PriceChart points={points} />
          )}

        </div>
      </div>
    </dialog>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-2.5 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}
