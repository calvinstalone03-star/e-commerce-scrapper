import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/EmptyState';
import { PricingSearch } from '@/components/PricingSearch';
import { UrlChoice } from '@/components/UrlChoice';
import { Badge, Card, CardContent, Stat, TBody, TD, TH, THead, TR, Table, cn } from '@/components/ui';
import { channelFromParams, channelShop, withChannel, type Channel } from '@/lib/channel';
import { MARKETPLACE_LABELS, formatDate, formatPrice, formatStoreName } from '@/lib/format';
import { getOwnShops, getPricePositions } from '@/lib/queries';
import {
  pricePositionFilterSchema,
  toSearchParams,
  type OwnShop,
  type PricePositionFilter,
} from '@/lib/schemas';

/**
 * Where our prices sit against everyone else's.
 *
 * A worklist rather than a browser: 1600 products is far past the number anyone
 * opens one at a time, so the question this screen answers is "which prices do I
 * need to touch today", and the default sort — biggest gap above the cheapest
 * rival first — is that question.
 *
 * Server-rendered with link-driven filters, like /compare and unlike /products.
 * The filter set here is four chips and a sort; wiring up a client component to
 * hold that would cost a hydration boundary and buy nothing, and every state
 * stays a URL somebody can send to somebody else.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Posisi harga',
  description: 'Produk kita dibanding produk kompetitor dengan nomor set sama.',
};

const count = new Intl.NumberFormat('id-ID');
const percent = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filter = pricePositionFilterSchema.parse(flatten(params));

  const shops = await getOwnShops();

  // Nothing on this page means anything without a shop of ours to compare from,
  // and no scrape can work out which shop that is — so say exactly which command
  // fixes it rather than rendering an empty table.
  if (shops.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <EmptyState
          title="Belum ada toko yang ditandai sebagai toko kita"
          description={
            <>
              Halaman ini membandingkan produk toko sendiri dengan produk toko lain, jadi ia perlu
              tahu toko mana yang milik kita. Marketplace tidak menyimpan informasi itu di mana pun,
              jadi tandai sekali lewat terminal:
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper own-shop shopee i_bricks
              </code>
              Tokonya harus sudah pernah di-scrape lebih dulu — kalau belum ada barisnya di
              database, tidak ada yang bisa ditandai.
            </>
          }
        />
      </div>
    );
  }

  const channel = channelFromParams(params, shops);
  const shop = channelShop(channel, shops);

  // Unreachable in practice — the zero-shops return above already guarantees
  // a channel resolves — but this is the same idiom the other scoped pages use
  // rather than asserting past a case that cannot happen.
  if (!channel || !shop) {
    return (
      <div className="space-y-6">
        <PageHeader />
      </div>
    );
  }

  // One statement answers all three: the page, its total, and the headline
  // counts over the whole catalogue.
  const { rows, total, summary } = await getPricePositions(channel, filter);

  const unmatched = summary.products - summary.matched;

  return (
    <div className="space-y-6">
      <PageHeader shop={shop} channel={channel} />

      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Produk kita"
            value={count.format(summary.products)}
            hint={`${count.format(summary.matched)} punya pembanding`}
          />
          <Stat
            label="Kemahalan"
            value={<span className="text-negative">{count.format(summary.overpriced)}</span>}
            hint="ada yang menjual lebih murah"
          />
          <Stat
            label="Termurah"
            value={<span className="text-positive">{count.format(summary.cheapest)}</span>}
            hint="tidak ada yang di bawah kita"
          />
          <Stat
            label="Belum ada lawan"
            value={count.format(unmatched)}
            hint={
              summary.withoutSetCode > 0
                ? `${count.format(summary.withoutSetCode)} tanpa nomor set`
                : 'scrape katalog kompetitor lagi'
            }
          />
        </CardContent>
      </Card>

      <SearchBox filter={filter} channel={channel} />
      <Filters filter={filter} />

      {rows.length === 0 ? (
        <EmptyState
          title="Tidak ada produk yang cocok dengan saringan ini"
          description={
            filter.matched === 'none'
              ? 'Bagus — berarti setiap produk yang tersaring sudah punya pembanding.'
              : 'Longgarkan saringannya, atau scrape katalog toko kompetitor supaya ada yang bisa dibandingkan.'
          }
        />
      ) : (
        <>
          <Table maxHeight="none">
            <THead>
              <TR>
                <TH>Produk</TH>
                <TH className="text-right">Harga kita</TH>
                <TH className="text-right">Termurah lawan</TH>
                <TH className="text-right">Posisi</TH>
                <TH className="text-right">Selisih</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                // The whole row is the target. `relative` here plus the
                // stretched link below is what makes that work without
                // JavaScript: it stays a real anchor, so middle-click, ⌘-click
                // and "copy link" all behave, and the row keeps its one entry in
                // the tab order rather than gaining a handler no keyboard can
                // reach.
                <TR key={row.id} className="relative hover:bg-surface-muted">
                  <TD>
                    <Link
                      href={withChannel(`/pricing/${row.id}`, channel)}
                      className="font-medium text-foreground underline-offset-4 before:absolute before:inset-0 before:content-[''] hover:underline"
                    >
                      {row.name ?? 'Produk tanpa nama'}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {row.setCode ? (
                        <Badge variant="default">set {row.setCode}</Badge>
                      ) : (
                        <Badge variant="muted">tanpa nomor set</Badge>
                      )}
                      {row.extreme ? (
                        // A set number is one box, but LEGO gives a whole
                        // collectible series one number: the single blind bag,
                        // the keychain and the box of twelve all read 71049 and
                        // legitimately cost 52rb, 140rb and 1,25jt. The pairing
                        // is right and the percentage is meaningless, so say so
                        // where the number is, rather than letting someone
                        // reprice against a different package.
                        //
                        // Read from the row rather than recomputed here: the
                        // server already decided this — the same value the
                        // extreme:'hide' filter used — so this badge and that
                        // filter can never again disagree about which rows
                        // qualify.
                        <Badge variant="muted" title="selisih sebesar ini biasanya beda kemasan — satuan, keychain, atau satu set penuh">
                          periksa kemasan
                        </Badge>
                      ) : null}
                      {row.matchKind === 'name' ? (
                        // Named apart from a set match on purpose: this row was
                        // paired on how the titles read, which is a guess, and a
                        // guess shown as confidently as an identity would put the
                        // whole table in doubt.
                        <Badge variant="muted" title="dicocokkan dari kemiripan nama, bukan nomor set">
                          ~ cocok via nama
                        </Badge>
                      ) : null}
                      <span className="text-xs text-muted">{formatDate(row.scrapedAt)}</span>
                    </div>
                  </TD>
                  <TD className="text-right tabular-nums">{formatPrice(row.price)}</TD>
                  <TD className="text-right">
                    {row.rivals === 0 ? (
                      <span className="text-sm text-muted">belum ada lawan</span>
                    ) : (
                      <>
                        <div className="tabular-nums">{formatPrice(row.cheapestPrice)}</div>
                        <div className="text-xs text-muted">
                          {formatStoreName(row.cheapestStore, null)}
                          {row.cheapestMarketplace
                            ? ` · ${MARKETPLACE_LABELS[row.cheapestMarketplace] ?? row.cheapestMarketplace}`
                            : ''}
                        </div>
                      </>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {row.position === null ? (
                      <span className="text-muted">–</span>
                    ) : (
                      <>
                        {row.position}
                        <span className="text-muted">/{row.rivals + 1}</span>
                      </>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    <Gap value={row.gapPercent} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <PageLinks filter={filter} total={total} channel={channel} />
        </>
      )}
    </div>
  );
}

function PageHeader({
  shop = null,
  channel = null,
}: {
  shop?: OwnShop | null;
  channel?: Channel | null;
}) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Posisi harga</h1>
      <p className="max-w-2xl text-sm text-muted">
        {shop && channel ? (
          <>
            Produk <span className="font-medium text-foreground">{shop.username}</span> di{' '}
            {MARKETPLACE_LABELS[channel]} dibanding produk toko lain dengan nomor set LEGO yang
            sama, lintas marketplace.
          </>
        ) : (
          // No shop resolved yet — the zero-own-shops branch above renders this
          // header before any channel exists to name. A complete, generic
          // sentence here rather than interpolating missing pieces: the
          // EmptyState right below already explains why there is nothing to
          // name, so this line only has to stay grammatical, not specific.
          'Produk kita dibanding produk toko lain dengan nomor set LEGO yang sama, lintas marketplace.'
        )}
      </p>
    </header>
  );
}

/** Selisih harga kita terhadap lawan termurah. Positif berarti kita lebih mahal. */
function Gap({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">–</span>;
  if (value === 0) return <span className="text-muted">0,0%</span>;
  return (
    <span className={value > 0 ? 'text-negative' : 'text-positive'}>
      {value > 0 ? '+' : '−'}
      {percent.format(Math.abs(value))}%
    </span>
  );
}

/**
 * Search by name or set number, in one box.
 *
 * The input is the only client component on this screen: it navigates as you
 * type, and the server renders the results exactly as it does for a bookmark.
 * The "clear" link stays here because it is a plain link and belongs to the
 * server-rendered part.
 */
function SearchBox({ filter, channel }: { filter: PricePositionFilter; channel: Channel | null }) {
  const carried = { ...filter, q: undefined, page: undefined };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <PricingSearch q={filter.q ?? ''} carried={carried} channel={channel} />
      {filter.q ? (
        <Link
          href={withChannel(`/pricing?${toSearchParams(carried)}`, channel)}
          className="text-sm text-muted underline-offset-4 hover:underline"
        >
          Hapus pencarian
        </Link>
      ) : null}
    </div>
  );
}

/**
 * The filter row.
 *
 * Three dropdowns and a sort, where there used to be four groups of chips. The
 * chips were honest about their options and silent about what they did: by the
 * time there were fifteen of them across three rows, they took more height than
 * the table and read as decoration. A labelled control says what it filters
 * while closed, which is most of the time.
 *
 * Marketplace used to be a fourth dropdown here; it is gone now that a channel
 * — not a filter — decides which shop of ours the whole page is about.
 */
function Filters({ filter }: { filter: PricePositionFilter }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <UrlChoice
        label="Posisi"
        param="stance"
        value={filter.stance}
        options={[
          { value: 'any', label: 'Semua produk' },
          { value: 'over', label: 'Kemahalan', hint: 'ada yang menjual lebih murah' },
          { value: 'under', label: 'Termurah', hint: 'tidak ada yang di bawah kita' },
          { value: 'equal', label: 'Sama persis' },
        ]}
      />
      <UrlChoice
        label="Pencocokan"
        param="matched"
        value={filter.matched}
        options={[
          { value: 'any', label: 'Semua' },
          { value: 'set', label: 'Nomor set', hint: 'pasangan pasti' },
          { value: 'name', label: 'Via nama', hint: 'kemiripan judul, lebih lemah' },
          { value: 'none', label: 'Belum ada lawan', hint: 'daftar kerja scraping' },
        ]}
      />
      <UrlChoice
        label="Selisih ekstrem"
        param="extreme"
        value={filter.extreme}
        options={[
          { value: 'hide', label: 'Sembunyikan', hint: 'di luar ±100%, biasanya beda kemasan' },
          { value: 'show', label: 'Tampilkan' },
        ]}
      />
      <UrlChoice
        label="Urutkan"
        param="sort"
        value={filter.sort}
        options={[
          { value: 'gap', label: 'Selisih terbesar' },
          { value: 'position', label: 'Posisi' },
          { value: 'rivals', label: 'Jumlah lawan' },
          { value: 'price', label: 'Harga kita' },
          { value: 'name', label: 'Nama produk' },
        ]}
      />
    </div>
  );
}

/**
 * Prev/next as links rather than the shared `Pagination`.
 *
 * That component is callback-driven for the client-side list views; this page is
 * a Server Component, so its paging has to survive in the URL.
 */
function PageLinks({
  filter,
  total,
  channel,
}: {
  filter: PricePositionFilter;
  total: number;
  channel: Channel | null;
}) {
  const pages = Math.max(1, Math.ceil(total / filter.pageSize));
  const from = total === 0 ? 0 : (filter.page - 1) * filter.pageSize + 1;
  const to = Math.min(filter.page * filter.pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted">
          {count.format(from)}–{count.format(to)} dari {count.format(total)} produk
        </span>
        {/* How many rows to a page, as links rather than a select: the page is a
            Server Component, and a select would need a client component to do
            what an anchor already does. */}
        <span className="flex items-center gap-1.5 text-muted">
          <span className="text-xs uppercase tracking-wide">baris</span>
          {[10, 25, 50, 100].map((size) => (
            <Link
              key={size}
              href={withChannel(`/pricing?${toSearchParams({ ...filter, pageSize: size, page: 1 })}`, channel)}
              aria-current={filter.pageSize === size ? 'true' : undefined}
              className={cn(
                'rounded px-1.5 py-0.5 tabular-nums transition-colors',
                filter.pageSize === size
                  ? 'bg-accent/10 font-medium text-accent'
                  : 'hover:text-foreground',
              )}
            >
              {size}
            </Link>
          ))}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-muted tabular-nums">
          hal {count.format(filter.page)}/{count.format(pages)}
        </span>
        {filter.page > 1 ? (
          <Link
            href={withChannel(`/pricing?${toSearchParams({ ...filter, page: filter.page - 1 })}`, channel)}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-muted transition-colors hover:text-foreground"
          >
            Sebelumnya
          </Link>
        ) : null}
        {filter.page < pages ? (
          <Link
            href={withChannel(`/pricing?${toSearchParams({ ...filter, page: filter.page + 1 })}`, channel)}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-muted transition-colors hover:text-foreground"
          >
            Berikutnya
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** `?a=1&a=2` is a bookmark oddity, not an error — take the first and move on. */
function flatten(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined) flat[key] = single;
  }
  return flat;
}
