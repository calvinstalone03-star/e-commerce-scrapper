import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';

import { EmptyState } from '@/components/EmptyState';
import { OverviewCards } from '@/components/OverviewCards';
import { OwnShopScorecard } from '@/components/OwnShopScorecard';
import { ProductImage } from '@/components/ProductImage';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { channelFromParams, channelShop } from '@/lib/channel';
import {
  MARKETPLACE_LABELS,
  formatDateTime,
  formatPrice,
  formatSold,
  formatStoreName,
} from '@/lib/format';
import { getOverview, getOwnShopScorecard, getOwnShops, getProducts, getStores } from '@/lib/queries';
import {
  productFilterSchema,
  storeFilterSchema,
  type Overview,
  type ProductRow,
  type StoreRow,
} from '@/lib/schemas';

export const metadata: Metadata = {
  title: 'Ringkasan',
  description: 'Total toko, produk dan harga yang sudah terekam dari Shopee dan Tokopedia.',
};

const count = new Intl.NumberFormat('id-ID');

const BAR_COLORS: Record<string, string> = {
  shopee: 'bg-shopee',
  tokopedia: 'bg-tokopedia',
};

/**
 * "hari ini" / "kemarin" / "5 hari lalu".
 *
 * A timestamp alone does not answer the only question anyone actually asks of it
 * here, which is whether what they are looking at is still current.
 */
function freshness(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'hari ini';
  if (days === 1) return 'kemarin';
  return `${days} hari lalu`;
}

function ProductLine({ product }: { product: ProductRow }) {
  const name = product.name ?? 'Tanpa nama';
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <ProductImage src={product.image} alt={product.name} size={48} />
      <div className="min-w-0 flex-1">
        {product.url ? (
          <a
            href={product.url}
            target="_blank"
            rel="noopener noreferrer"
            className="line-clamp-2 text-sm text-foreground underline-offset-4 hover:underline"
          >
            {name}
          </a>
        ) : (
          <span className="line-clamp-2 text-sm text-foreground">{name}</span>
        )}
        <p className="mt-0.5 truncate text-xs text-muted">
          {product.storeId !== null ? (
            <Link
              href={`/stores/${product.storeId}`}
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              {formatStoreName(product.storeUsername, null)}
            </Link>
          ) : (
            formatStoreName(product.storeUsername, null)
          )}
          {product.sold !== null ? ` · ${formatSold(product.sold)} terjual` : null}
        </p>
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
        {formatPrice(product.price)}
      </span>
    </li>
  );
}

function ProductCard({
  title,
  caption,
  href,
  products,
}: {
  title: string;
  caption: string;
  href: string;
  products: ProductRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-0.5 text-xs text-muted">{caption}</p>
        </div>
        <Link href={href} className="text-xs text-accent underline-offset-4 hover:underline">
          Lihat semua →
        </Link>
      </CardHeader>
      {products.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="Belum ada harga"
            description="Tidak ada produk yang punya snapshot harga, jadi tidak ada yang bisa diurutkan."
          />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {products.map((product) => (
            <ProductLine key={product.id} product={product} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MarketplaceSplit({ overview }: { overview: Overview }) {
  const totalProducts = overview.marketplaces.reduce((sum, row) => sum + row.products, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sebaran marketplace</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {overview.marketplaces.length === 0 ? (
          <p className="text-sm text-muted">Belum ada toko yang terekam di marketplace mana pun.</p>
        ) : null}
        {overview.marketplaces.map((row) => {
          const share = totalProducts > 0 ? (row.products / totalProducts) * 100 : 0;
          return (
            <div key={row.marketplace}>
              <div className="flex items-center justify-between gap-3">
                <Badge variant={row.marketplace}>
                  {MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace}
                </Badge>
                <p className="text-xs text-muted">
                  <Link
                    href={`/stores?marketplace=${row.marketplace}`}
                    className="underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {count.format(row.stores)} toko
                  </Link>
                  {' · '}
                  <Link
                    href={`/products?marketplace=${row.marketplace}`}
                    className="underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {count.format(row.products)} produk
                  </Link>
                </p>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                {/* Runtime percentage, so the width has to be an inline style —
                    Tailwind cannot generate a class for a value it never sees. */}
                <div
                  className={`h-full rounded-full ${BAR_COLORS[row.marketplace] ?? 'bg-accent'}`}
                  style={{ width: `${share}%`, minWidth: share > 0 ? '0.25rem' : 0 }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function priceRange(store: StoreRow): string {
  const low = formatPrice(store.minPrice);
  const high = formatPrice(store.maxPrice);
  return low === high ? low : `${low} – ${high}`;
}

function TopStores({ stores }: { stores: StoreRow[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Toko dengan produk terbanyak</CardTitle>
          <p className="mt-0.5 text-xs text-muted">Penjual yang paling sering muncul di hasil</p>
        </div>
        <Link
          href="/stores?sort=products&dir=desc"
          className="text-xs text-accent underline-offset-4 hover:underline"
        >
          Semua toko →
        </Link>
      </CardHeader>
      {stores.length === 0 ? (
        <CardContent className="text-sm text-muted">
          Produk sudah ada, tetapi belum ada satu pun yang tersambung ke toko.
        </CardContent>
      ) : null}
      <ul className="divide-y divide-line">
        {stores.map((store) => (
          <li key={store.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <Link
                href={`/stores/${store.id}`}
                className="block truncate text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                {formatStoreName(store.username, store.name)}
              </Link>
              {/* A one-product shop would otherwise read "Rp105.000 – Rp105.000".
                  Compared as rendered rather than as stored: NUMERIC keeps each
                  value's own scale, so equal money can arrive as '105000' and
                  '105000.0' and a `===` would print a range that is not there. */}
              <p className="text-xs text-muted">
                {store.minPrice === null ? 'harga belum terekam' : priceRange(store)}
              </p>
            </div>
            <Link
              href={`/products?storeId=${store.id}`}
              className="shrink-0 text-sm tabular-nums text-muted underline-offset-4 hover:text-foreground hover:underline"
            >
              {count.format(store.productCount)} produk
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Without this the page is prerendered at build time and every total freezes at
  // whatever the database held when `next build` ran. This page's whole job is to
  // answer "what does the database say now".
  await connection();

  const params = await searchParams;
  const shops = await getOwnShops();
  // `shop` is derived from this same `channel`, not from an independent lookup —
  // the only way to guarantee the scorecard below is never asked for one shop
  // while labelled with another's channel.
  const channel = channelFromParams(params, shops);
  const shop = channelShop(channel, shops);

  const [overview, scorecard, cheapest, priciest, topStores] = await Promise.all([
    getOverview(),
    channel && shop ? getOwnShopScorecard(channel, shop) : null,
    getProducts(productFilterSchema.parse({ sort: 'price', dir: 'asc', pageSize: 5 })),
    getProducts(productFilterSchema.parse({ sort: 'price', dir: 'desc', pageSize: 5 })),
    getStores(storeFilterSchema.parse({ sort: 'products', dir: 'desc', pageSize: 5 })),
  ]);

  if (overview.stores === 0 && overview.products === 0) {
    return (
      <EmptyState
        className="mx-auto max-w-2xl"
        title="Belum ada data"
        description={
          <>
            Database <code className="font-mono">ecom_scraper</code> masih kosong. Jalankan satu
            scrape lebih dulu, lalu muat ulang halaman ini.
          </>
        }
        action={
          <div className="space-y-3">
            <pre className="scrollbar-slim overflow-x-auto rounded-lg border border-line bg-surface-muted px-4 py-3 text-left font-mono text-xs text-foreground">
              <code>
                ecom-scraper run --mode keyword --keywords-file config/keywords.txt --pages 2
              </code>
            </pre>
            <p className="max-w-prose text-xs text-muted">
              Kalau marketplace menolak perintah itu, pencarian sedang dijaga login wall: jalankan{' '}
              <code className="font-mono">ecom-scraper serve</code> lalu scrape halamannya lewat
              extension Chrome.
            </p>
          </div>
        }
      />
    );
  }

  const scrapedAgo = freshness(overview.lastScrapedAt);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Ringkasan
            {shop ? (
              <span className="ml-2 text-base font-normal text-muted">
                {MARKETPLACE_LABELS[shop.marketplace]} · {shop.username}
              </span>
            ) : null}
          </h1>
          <p className="max-w-2xl text-sm text-muted">
            Semua yang sudah terekam dari{' '}
            {overview.marketplaces
              .map((row) => MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace)
              .join(' dan ')}
            . Perbandingan harga antar toko sudah bisa dibaca sekarang; pergerakan harga baru
            terbentuk setelah halaman yang sama di-scrape di hari lain.
          </p>
        </div>
        <p className="text-xs text-muted">
          Scrape terakhir{' '}
          <span className="font-medium text-foreground">
            {formatDateTime(overview.lastScrapedAt)}
          </span>
          {scrapedAgo ? ` · ${scrapedAgo}` : null}
        </p>
      </header>

      {scorecard ? (
        <OwnShopScorecard scorecard={scorecard} />
      ) : (
        <EmptyState
          title="Belum ada toko yang ditandai sebagai toko kita"
          description={
            <>
              Angka posisi harga di halaman ini relatif terhadap toko sendiri. Tandai sekali lewat
              terminal — satu perintah per marketplace:
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper own-shop shopee i_bricks
                <br />
                ecom-scraper own-shop tokopedia i-bricks
              </code>
            </>
          }
        />
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Pasar</h2>
        <OverviewCards overview={overview} />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ProductCard
          title="Produk termurah"
          caption="Harga terendah pada snapshot terakhir"
          href="/products?sort=price&dir=asc"
          products={cheapest.rows}
        />
        <ProductCard
          title="Produk termahal"
          caption="Harga tertinggi pada snapshot terakhir"
          href="/products?sort=price&dir=desc"
          products={priciest.rows}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <MarketplaceSplit overview={overview} />
        <TopStores stores={topStores.rows} />
      </div>
    </div>
  );
}
