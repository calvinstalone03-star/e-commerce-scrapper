import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/EmptyState';
import { KeywordTable } from '@/components/KeywordTable';
import { Card, CardContent, Stat } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { getKeywords, getOverview } from '@/lib/queries';

/**
 * The keyword view: one row per search term the scraper has run.
 *
 * Keyword *is* the category here. `products.category` comes back NULL for every
 * row the marketplaces return, so the term a product was found under is the only
 * grouping that exists — and the entry point to the comparison screen.
 */

// Read Postgres on every request. Prerendered at build time this page would
// keep serving the counts that were true when the container was built, which on
// a scraper dashboard is worse than a few milliseconds of latency.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Keyword',
  description: 'Istilah pencarian yang sudah di-scrape, beserta sebaran harganya.',
};

const count = new Intl.NumberFormat('id-ID');

export default async function KeywordsPage() {
  const [keywords, overview] = await Promise.all([getKeywords(), getOverview()]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Keyword</h1>
        <p className="max-w-2xl text-sm text-muted">
          Setiap baris adalah satu istilah pencarian yang pernah di-scrape. Marketplace tidak
          mengembalikan kategori sama sekali, jadi kata kunci inilah kategorinya — sekaligus titik
          awal untuk membandingkan harga antar toko.
        </p>
      </header>

      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-3">
          <Stat
            label="Kata kunci"
            value={count.format(overview.keywords)}
            hint="istilah pencarian yang terekam"
          />
          <Stat
            label="Produk di database"
            value={count.format(overview.products)}
            hint="sebagian besar tanpa kata kunci"
          />
          <Stat
            label="Scrape terakhir"
            value={formatDateTime(overview.lastScrapedAt)}
            hint="snapshot harga paling baru"
          />
        </CardContent>
      </Card>

      {keywords.length === 0 ? (
        <EmptyState
          title="Belum ada kata kunci"
          description={
            <>
              Kata kunci hanya terisi saat scraper dijalankan dalam mode pencarian. Produk yang
              diambil langsung dari halaman toko tidak membawa istilah pencarian, jadi tabel ini
              tetap kosong sampai ada scrape pencarian pertama.
            </>
          }
        />
      ) : (
        <>
          <KeywordTable rows={keywords} />

          {/* The gap is permanent for old rows, so silence here would read as a
              broken join rather than as history. */}
          <Card>
            <CardContent className="space-y-1">
              <h2 className="text-sm font-semibold text-foreground">
                Kenapa hanya {count.format(overview.keywords)} kata kunci dari{' '}
                {count.format(overview.products)} produk?
              </h2>
              <p className="max-w-3xl text-sm leading-relaxed text-muted">
                Perekaman kata kunci baru ditambahkan setelah sebagian besar produk selesai
                di-scrape. Baris lama tidak menyimpan istilah pencarian asalnya dan tidak bisa
                diisi surut, jadi angka di tabel ini hanya mencakup produk yang masuk setelah
                perubahan itu. Jalankan scrape pencarian lagi untuk menambah cakupannya.
              </p>
            </CardContent>
          </Card>

          <p className="text-sm text-muted">
            Klik kata kunci untuk membandingkan harga antar toko, atau{' '}
            <Link href="/products" className="text-accent underline-offset-4 hover:underline">
              telusuri semua produk
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
