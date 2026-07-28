import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ComparisonChart,
  PriceDistributionChart,
  type ComparisonDatum,
  type DistributionPoint,
} from '@/components/ComparisonChart';
import { EmptyState } from '@/components/EmptyState';
import { Card, CardContent, CardHeader, CardTitle, Stat, cn } from '@/components/ui';
import { MARKETPLACE_LABELS, formatPrice, formatStoreName, priceDelta } from '@/lib/format';
import { getKeywordComparison, getKeywords, getProducts } from '@/lib/queries';
import { productFilterSchema, toSearchParams } from '@/lib/schemas';

/**
 * Competitor price comparison — the screen the whole scraper exists to feed.
 *
 * Nothing here compares a product against its own past: there is one snapshot
 * per product, so there is no past to compare against yet. What it does compare
 * is shops against each other at one moment, which is both what the data
 * supports today and what "berapa harga pesaing?" actually asks.
 */

// Live read on every request. A comparison prerendered at build time would keep
// showing the prices that were true when the container was built.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Perbandingan',
  description: 'Harga tiap toko untuk satu istilah pencarian.',
};

const count = new Intl.NumberFormat('id-ID');

// `format.ts` has no percent formatter and is not ours to extend. Same locale as
// the money beside it, so "6,0%" does not sit next to "Rp 159.000".
const percent = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.keyword;
  const requested = Array.isArray(raw) ? raw[0] : raw;

  const keywords = await getKeywords();

  if (keywords.length === 0) {
    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Perbandingan</h1>
          <p className="max-w-2xl text-sm text-muted">
            Harga tiap toko untuk satu istilah pencarian.
          </p>
        </header>
        <EmptyState
          title="Belum ada kata kunci untuk dibandingkan"
          description="Perbandingan disusun per istilah pencarian. Jalankan scraper dalam mode pencarian dulu, lalu halaman ini terisi sendiri."
        />
      </div>
    );
  }

  // The same term can be scraped on more than one marketplace and the
  // comparison spans all of them, so the selector is per keyword rather than
  // per keyword-and-marketplace row.
  const options = new Map<string, Set<string>>();
  for (const row of keywords) {
    const marketplaces = options.get(row.keyword) ?? new Set<string>();
    marketplaces.add(MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace);
    options.set(row.keyword, marketplaces);
  }

  // A bookmark pointing at a keyword that no longer exists should still render
  // something useful — the same tolerance `productFilterSchema` applies to a
  // stale filter.
  const known = requested !== undefined && options.has(requested);
  const selected = known ? (requested as string) : keywords[0].keyword;

  const [comparison, products] = await Promise.all([
    getKeywordComparison(selected),
    // Individual prices for the distribution. Parsed through the filter schema
    // so this page asks for products exactly the way the products page does.
    getProducts(
      productFilterSchema.parse({ keyword: selected, sort: 'price', dir: 'asc', pageSize: 200 }),
    ),
  ]);

  const rows: ComparisonDatum[] = comparison.map((row) => ({
    storeId: row.storeId,
    // Shopee search cards carry no slug, so most usernames are `shop-<id>`
    // placeholders. Printing one raw would read as a broken value.
    label: row.storeId === null ? 'Toko tidak diketahui' : formatStoreName(row.storeUsername, null),
    products: row.products,
    minPrice: row.minPrice,
    maxPrice: row.maxPrice,
    avgPrice: row.avgPrice,
  }));

  const distribution: DistributionPoint[] = [];
  for (const product of products.rows) {
    if (product.price === null) continue;
    distribution.push({
      id: product.id,
      name: product.name ?? 'Produk tanpa nama',
      store:
        product.storeId === null
          ? 'Toko tidak diketahui'
          : formatStoreName(product.storeUsername, null),
      price: product.price,
    });
  }

  // `getKeywordComparison` groups on `s.id`, and `products.shop_ref` is
  // nullable — so every product whose shop was never resolved collapses into one
  // synthetic row whose min, max and average span unrelated sellers. That row is
  // fine to draw (it is labelled "Toko tidak diketahui") but it is not a shop,
  // so it must not be able to win "termurah" or set the spread between shops.
  const identified = rows.filter((row) => row.storeId !== null);
  const orphan = rows.find((row) => row.storeId === null) ?? null;

  const priced = identified.filter((row) => row.avgPrice !== null);
  const totalProducts = rows.reduce((sum, row) => sum + row.products, 0);
  const cheapest = priced.length > 0 ? priced[0] : null;
  const dearest = priced.length > 1 ? priced[priced.length - 1] : null;
  // `priceDelta` keeps the Number() conversion inside format.ts, where money is
  // allowed to become a float because the result is only ever displayed.
  const spread = cheapest && dearest ? priceDelta(cheapest.avgPrice, dearest.avgPrice) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Perbandingan</h1>
        <p className="max-w-2xl text-sm text-muted">
          Untuk satu istilah pencarian: berapa yang dipatok masing-masing toko. Semua angka diambil
          dari snapshot terbaru tiap produk, jadi ini potret satu titik waktu — bukan tren.
        </p>
      </header>

      {/* Links rather than a select: with a handful of terms every option is
          one click away, each is a shareable URL, and the page stays a Server
          Component with nothing to hydrate. */}
      <nav aria-label="Pilih kata kunci">
        <ul className="flex flex-wrap gap-2">
          {[...options].map(([keyword, marketplaces]) => {
            const active = keyword === selected;
            return (
              <li key={keyword}>
                <Link
                  href={`/compare?${toSearchParams({ keyword })}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex items-baseline gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors',
                    active
                      ? 'border-accent/25 bg-accent/10 font-medium text-accent'
                      : 'border-line bg-surface text-muted hover:text-foreground',
                  )}
                >
                  {keyword}
                  <span className="text-xs opacity-70">{[...marketplaces].join(' · ')}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {requested !== undefined && !known ? (
        <p className="rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-muted">
          Kata kunci <span className="font-medium text-foreground">“{requested}”</span> belum pernah
          di-scrape. Menampilkan <span className="font-medium text-foreground">{selected}</span>{' '}
          sebagai gantinya.
        </p>
      ) : null}

      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Toko"
            value={count.format(identified.length)}
            hint={
              orphan
                ? `menjual “${selected}” · ${count.format(orphan.products)} produk tanpa toko`
                : `menjual “${selected}”`
            }
          />
          <Stat
            label="Produk"
            value={count.format(totalProducts)}
            hint="pada kata kunci ini"
          />
          <Stat
            label="Termurah"
            value={
              cheapest ? (
                <span className="text-positive">{formatPrice(cheapest.avgPrice)}</span>
              ) : (
                '–'
              )
            }
            hint={cheapest ? storeHint(cheapest) : 'belum ada harga'}
          />
          <Stat
            label="Termahal"
            value={
              dearest ? <span className="text-negative">{formatPrice(dearest.avgPrice)}</span> : '–'
            }
            hint={dearest ? storeHint(dearest) : 'butuh minimal dua toko'}
          />
        </CardContent>
      </Card>

      {spread ? (
        <p className="text-sm leading-relaxed text-muted">
          Jarak antara toko termurah dan termahal:{' '}
          <span className="font-semibold tabular-nums text-foreground">
            {formatPrice(spread.absolute)}
          </span>{' '}
          <span className="tabular-nums">({percent.format(spread.percent)}%)</span>, dihitung dari harga
          rata-rata tiap toko.
        </p>
      ) : (
        <p className="rounded-md border border-line bg-surface-muted px-3 py-2.5 text-sm leading-relaxed text-muted">
          {identified.length <= 1
            ? `Baru ${count.format(identified.length)} toko yang tercatat untuk “${selected}”, jadi belum ada selisih antar toko yang bisa dihitung. Scrape pencarian yang sama sekali lagi untuk menjaring lebih banyak toko.`
            : 'Belum ada harga rata-rata yang bisa dibandingkan antar toko pada kata kunci ini.'}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Harga rata-rata per toko</CardTitle>
          <span className="text-xs text-muted">diurutkan dari termurah</span>
        </CardHeader>
        <CardContent>
          <ComparisonChart rows={rows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sebaran harga produk</CardTitle>
          <span className="text-xs text-muted">
            {products.total > products.rows.length
              ? `${count.format(products.rows.length)} produk termurah dari ${count.format(products.total)}`
              : `${count.format(distribution.length)} produk`}
          </span>
        </CardHeader>
        <CardContent>
          <PriceDistributionChart
            points={distribution}
            truncated={products.total > products.rows.length}
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link
          href={`/products?${toSearchParams({ keyword: selected, sort: 'price', dir: 'asc' })}`}
          className="text-accent underline-offset-4 hover:underline"
        >
          Lihat daftar produk “{selected}”
        </Link>
        <Link href="/keywords" className="text-muted underline-offset-4 hover:underline">
          Semua kata kunci
        </Link>
      </div>
    </div>
  );
}

/** "Toko #30203584 · 3 produk" — the shop behind a headline figure. */
function storeHint(row: ComparisonDatum): string {
  return `${row.label} · ${count.format(row.products)} produk`;
}
