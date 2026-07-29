import Link from 'next/link';

import { EmptyState } from '@/components/EmptyState';
import { Badge, TBody, TD, TH, THead, TR, Table } from '@/components/ui';
import {
  MARKETPLACE_LABELS,
  formatDate,
  formatPrice,
  formatSold,
  formatStoreName,
  isPlaceholderStore,
} from '@/lib/format';
import { toSearchParams, type StoreFilter, type StoreRow } from '@/lib/schemas';

/**
 * The shop list.
 *
 * A Server Component on purpose: sorting and paging live in the URL, so there is
 * no client state to hold and nothing to hydrate. That also rules out the kit's
 * `Pagination`, which is callback-driven — a server tree cannot hand it an
 * `onPageChange` — so the pager here is links carrying the current filter.
 */

const count = new Intl.NumberFormat('id-ID');

function storesHref(filter: StoreFilter, overrides: Partial<StoreFilter>): string {
  return `/stores?${toSearchParams({ ...filter, ...overrides })}`;
}

function SortHeader({
  field,
  label,
  filter,
  numeric,
}: {
  field: StoreFilter['sort'];
  label: string;
  filter: StoreFilter;
  numeric?: boolean;
}) {
  const active = filter.sort === field;
  // Names read best A→Z on the first click; counts and money read best
  // largest-first. Re-clicking the active column flips it.
  const nextDir = active
    ? filter.dir === 'desc'
      ? 'asc'
      : 'desc'
    : field === 'name'
      ? 'asc'
      : 'desc';

  return (
    <TH numeric={numeric} aria-sort={active ? (filter.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <Link
        href={storesHref(filter, { sort: field, dir: nextDir, page: 1 })}
        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
          active ? 'text-foreground' : ''
        }`}
      >
        {label}
        <span aria-hidden className={active ? '' : 'opacity-0'}>
          {filter.dir === 'asc' ? '↑' : '↓'}
        </span>
      </Link>
    </TH>
  );
}

function PriceRange({ store }: { store: StoreRow }) {
  if (store.minPrice === null) {
    return <span className="text-muted">–</span>;
  }
  // Compared as rendered, not as stored. Postgres NUMERIC keeps each value's own
  // scale, so two equal prices can arrive as '105000' and '105000.0' — equal
  // money, unequal strings, and a `===` here would invent a range the shop does
  // not have. `formatPrice` is also the only place allowed to turn money into a
  // number, so asking it whether both ends read the same keeps that rule intact.
  const low = formatPrice(store.minPrice);
  const high = formatPrice(store.maxPrice);
  const single = low === high;
  return (
    <span className="flex flex-col items-end">
      <span>{single ? low : `${low} – ${high}`}</span>
      {!single && store.avgPrice !== null ? (
        <span className="text-xs text-muted">rata-rata {formatPrice(store.avgPrice)}</span>
      ) : null}
    </span>
  );
}

function Pager({ filter, total, shown }: { filter: StoreFilter; total: number; shown: number }) {
  const pages = Math.max(1, Math.ceil(total / filter.pageSize));
  const from = shown === 0 ? 0 : (filter.page - 1) * filter.pageSize + 1;
  // Derived from the rows actually on screen, never from the page number: a
  // request past the last page returns nothing while `total` stays 94, and
  // `from + shown - 1` would then print the range backwards ("401 – 400").
  const to = from + shown - 1;
  const step =
    'inline-flex h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium transition-colors hover:bg-surface-muted';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
      <p>
        {shown === 0 ? (
          'Tidak ada baris'
        ) : (
          <>
            <span className="font-medium text-foreground tabular-nums">
              {count.format(from)}–{count.format(to)}
            </span>{' '}
            dari <span className="tabular-nums">{count.format(total)}</span> toko
          </>
        )}
      </p>

      {/* Always rendered, even at one page: a control that appears only once a
          list grows past 10 rows teaches nobody that the list can be paged, and
          "1 / 1" is a complete, honest answer. */}
      <nav aria-label="Navigasi halaman" className="flex items-center gap-2">
          {filter.page > 1 ? (
            <Link href={storesHref(filter, { page: filter.page - 1 })} className={step}>
              Sebelumnya
            </Link>
          ) : (
            <span className={`${step} opacity-45`}>Sebelumnya</span>
          )}
          <span className="whitespace-nowrap tabular-nums">
            {count.format(filter.page)} / {count.format(pages)}
          </span>
        {filter.page < pages ? (
          <Link href={storesHref(filter, { page: filter.page + 1 })} className={step}>
            Berikutnya
          </Link>
        ) : (
          <span className={`${step} opacity-45`}>Berikutnya</span>
        )}
      </nav>
    </div>
  );
}

/**
 * Three different reasons a page can hold no rows, and one message for each.
 *
 * "Filter yang aktif tidak menyisakan satu toko pun" is only true when a filter
 * is actually set — on a freshly created database it sends the reader hunting
 * for a filter that is not there, and offers a reset link that is a no-op.
 */
function StoresEmptyState({ filtered, total }: { filtered: boolean; total: number }) {
  if (total > 0) {
    return (
      <EmptyState
        title="Halaman ini kosong"
        description="Nomor halaman yang diminta melewati baris terakhir. Kembali ke halaman pertama untuk melihat daftarnya."
        action={
          <Link href="/stores" className="text-sm text-accent underline-offset-4 hover:underline">
            Ke halaman pertama
          </Link>
        }
      />
    );
  }

  if (filtered) {
    return (
      <EmptyState
        title="Tidak ada toko yang cocok"
        description="Filter yang aktif tidak menyisakan satu toko pun. Longgarkan pencarian atau mulai dari daftar penuh."
        action={
          <Link href="/stores" className="text-sm text-accent underline-offset-4 hover:underline">
            Hapus semua filter
          </Link>
        }
      />
    );
  }

  return (
    <EmptyState
      title="Belum ada toko"
      description="Database belum berisi satu toko pun. Jalankan scraper terlebih dahulu, lalu muat ulang halaman ini."
    />
  );
}

export function StoreTable({
  rows,
  filter,
  total,
  filtered,
}: {
  rows: StoreRow[];
  filter: StoreFilter;
  total: number;
  /** True when a narrowing filter is set — sorting and paging do not count. */
  filtered: boolean;
}) {
  return (
    <div className="space-y-3">
      <Table>
        <caption className="sr-only">Daftar toko beserta jumlah produk dan rentang harganya</caption>
        <THead>
          <TR>
            <SortHeader field="name" label="Toko" filter={filter} />
            <TH>Marketplace</TH>
            <TH>Lokasi</TH>
            <SortHeader field="products" label="Produk" filter={filter} numeric />
            <SortHeader field="avgPrice" label="Rentang harga" filter={filter} numeric />
            <TH numeric>Terjual</TH>
            <TH numeric>Terakhir dilihat</TH>
          </TR>
        </THead>
        <TBody>
          {rows.length === 0 ? (
            <TR>
              <TD colSpan={7}>
                <StoresEmptyState filtered={filtered} total={total} />
              </TD>
            </TR>
          ) : (
            rows.map((store) => (
              <TR key={store.id}>
                <TD>
                  <Link
                    href={`/stores/${store.id}`}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {formatStoreName(store.username, store.name)}
                  </Link>
                  {isPlaceholderStore(store.username) ? (
                    // The marketplace never exposed a slug for this shop, so the
                    // numeric id is all there is. Labelled, not passed off as a name.
                    <span className="block text-xs text-muted">nama toko tidak terekam</span>
                  ) : null}
                </TD>
                <TD>
                  <Badge variant={store.marketplace}>
                    {MARKETPLACE_LABELS[store.marketplace] ?? store.marketplace}
                  </Badge>
                </TD>
                <TD className="text-muted">
                  {store.location ?? <span aria-label="tidak terekam">–</span>}
                </TD>
                <TD numeric>
                  {store.productCount > 0 ? (
                    <Link
                      href={`/products?storeId=${store.id}`}
                      className="text-foreground underline-offset-4 hover:underline"
                    >
                      {count.format(store.productCount)}
                    </Link>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD numeric>
                  <PriceRange store={store} />
                </TD>
                <TD numeric>{formatSold(store.totalSold)}</TD>
                <TD numeric className="whitespace-nowrap text-muted">
                  {formatDate(store.lastSeen)}
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>

      <Pager filter={filter} total={total} shown={rows.length} />
    </div>
  );
}
