import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { cache } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { ProductImage } from '@/components/ProductImage';
import { Badge, Card, Stat } from '@/components/ui';
import {
  MARKETPLACE_LABELS,
  formatDate,
  formatPrice,
  formatRating,
  formatSold,
  formatStoreName,
  isPlaceholderStore,
} from '@/lib/format';
import { getProducts, getStore } from '@/lib/queries';
import { productFilterSchema, type ProductRow } from '@/lib/schemas';

/** Shared by the page and its metadata, so one visit is one query. */
const loadStore = cache(getStore);

const INLINE_LIMIT = 24;
const count = new Intl.NumberFormat('id-ID');

function parseStoreId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const id = parseStoreId((await params).id);
  const store = id === null ? null : await loadStore(id);
  if (!store) return { title: 'Toko tidak ditemukan' };

  const name = formatStoreName(store.username, store.name);
  return {
    title: name,
    description: `${count.format(store.productCount)} produk terekam dari ${name} di ${
      MARKETPLACE_LABELS[store.marketplace] ?? store.marketplace
    }.`,
  };
}

function ProductTile({ product }: { product: ProductRow }) {
  const name = product.name ?? 'Tanpa nama';
  return (
    <li>
      <Card className="flex h-full items-start gap-3 p-3">
        <ProductImage src={product.image} alt={product.name} size={64} />
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
          <p className="mt-1 text-sm font-medium tabular-nums text-foreground">
            {formatPrice(product.price)}
          </p>
          <p className="text-xs text-muted">
            {formatSold(product.sold)} terjual
            {product.ratingStar !== null ? ` · ★ ${formatRating(product.ratingStar)}` : null}
          </p>
          {product.keywords.length > 0 ? (
            <p className="mt-1.5 flex flex-wrap gap-1">
              {product.keywords.map((keyword) => (
                <Link key={keyword} href={`/products?keyword=${encodeURIComponent(keyword)}`}>
                  <Badge variant="muted">{keyword}</Badge>
                </Link>
              ))}
            </p>
          ) : null}
        </div>
      </Card>
    </li>
  );
}

export default async function StoreDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Nothing else on this page is a request-time API, so without this Next would
  // render it once and serve that copy forever — a shop's price range would stop
  // moving the moment the route was first hit.
  await connection();

  const id = parseStoreId((await params).id);
  if (id === null) notFound();

  const store = await loadStore(id);
  if (!store) notFound();

  const { rows: products } = await getProducts(
    productFilterSchema.parse({ storeId: id, sort: 'sold', dir: 'desc', pageSize: INLINE_LIMIT }),
  );

  const allProductsHref = `/products?storeId=${store.id}`;
  const name = formatStoreName(store.username, store.name);
  const noHistoryYet = products.length > 0 && products.every((row) => row.snapshotCount <= 1);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/stores"
          className="text-xs text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          ← Semua toko
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{name}</h1>
          <Badge variant={store.marketplace}>
            {MARKETPLACE_LABELS[store.marketplace] ?? store.marketplace}
          </Badge>
        </div>

        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            Shop ID <span className="font-mono text-foreground">{store.shopId}</span>
          </span>
          {!isPlaceholderStore(store.username) ? (
            <span>
              Username <span className="font-mono text-foreground">{store.username}</span>
            </span>
          ) : null}
          <span>Lokasi {store.location ?? 'tidak terekam'}</span>
        </p>

        {isPlaceholderStore(store.username) ? (
          // The username column holds `shop-<id>` here. Saying why is better than
          // showing a generated label and letting it read as a broken value.
          <p className="mt-2 max-w-2xl text-xs text-muted">
            Nama toko ini tidak pernah ditampilkan di kartu hasil pencarian, jadi yang tersimpan
            hanya id numeriknya. Buka salah satu produk di bawah untuk melihat nama aslinya di
            marketplace.
          </p>
        ) : null}
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat
          label="Produk"
          value={
            store.productCount > 0 ? (
              <Link href={allProductsHref} className="underline-offset-4 hover:underline">
                {count.format(store.productCount)}
              </Link>
            ) : (
              '0'
            )
          }
          hint={
            store.productCount === 0
              ? 'belum ada produk tercatat'
              : products.length < store.productCount
                ? `${count.format(products.length)} teratas ada di bawah`
                : 'semuanya ada di bawah'
          }
        />
        {/* Min and max get a box each rather than one "Rp2.500 – Rp4.999.000"
            cell: at this type size the combined string wraps out of its column. */}
        <Stat
          label="Termurah"
          value={formatPrice(store.minPrice)}
          hint="snapshot terakhir tiap produk"
        />
        <Stat
          label="Termahal"
          value={formatPrice(store.maxPrice)}
          hint={
            store.avgPrice !== null ? `rata-rata ${formatPrice(store.avgPrice)}` : 'belum ada harga'
          }
        />
        <Stat
          label="Total terjual"
          value={formatSold(store.totalSold)}
          hint={`terakhir dilihat ${formatDate(store.lastSeen)}`}
        />
      </Card>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Produk toko ini
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Diurutkan dari yang paling banyak terjual
            </p>
          </div>
          <Link
            href={allProductsHref}
            className="text-xs text-accent underline-offset-4 hover:underline"
          >
            Lihat semua produk toko ini →
          </Link>
        </div>

        {noHistoryYet ? (
          <p className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-muted">
            Setiap produk di sini baru punya satu snapshot, jadi belum ada pergerakan harga untuk
            dibandingkan. Scrape toko ini lagi di hari lain untuk mulai membentuk riwayat.
          </p>
        ) : null}

        {products.length === 0 ? (
          <EmptyState
            title="Belum ada produk"
            description={
              <>
                Toko ini terekam sebagai penjual, tetapi belum ada satu pun produknya yang
                tersimpan. Jalankan{' '}
                <code className="font-mono">ecom-scraper run --mode store</code> untuk mengisi
                daftarnya.
              </>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => (
              <ProductTile key={product.id} product={product} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
