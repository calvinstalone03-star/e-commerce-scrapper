import type { Metadata } from 'next';
import Link from 'next/link';

import {
  GapVolumeChart,
  PositionMixChart,
  PriceBandChart,
  RivalPressureChart,
} from '@/components/AnalyticsCharts';
import { EmptyState } from '@/components/EmptyState';
import { Card, CardContent, CardHeader, CardTitle, Stat } from '@/components/ui';
import { channelFromParams, channelShop, withChannel } from '@/lib/channel';
import { MARKETPLACE_LABELS, formatPrice } from '@/lib/format';
import { getOwnShops, getPricingAnalytics } from '@/lib/queries';
import type { OwnShop } from '@/lib/schemas';

/**
 * The four questions worth asking before changing a price.
 *
 * Deliberately not a dashboard of everything measurable: each chart here exists
 * because it changes what you would do next. Who actually sets your floor, where
 * the money is rather than where the percentages are, how much of the catalogue
 * is exposed, and whether price is moving volume at all.
 *
 * Every figure is one moment. There is no trend line because there is no trend
 * yet — a time series needs the same product scraped on different days, and
 * saying so is better than drawing a flat line and calling it stability.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Analitik',
  description: 'Siapa yang menekan harga kita, dan di mana uangnya.',
};

const count = new Intl.NumberFormat('id-ID');

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shops = await getOwnShops();
  // `shop` is derived from this same `channel`, not from an independent lookup —
  // the only way to guarantee the heading below never names one shop while the
  // figures underneath answer for the other.
  const channel = channelFromParams(params, shops);
  const shop = channelShop(channel, shops);

  if (!channel || !shop) {
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState
          title="Belum ada toko yang ditandai sebagai toko kita"
          description={
            <>
              Semua angka di halaman ini relatif terhadap toko sendiri, jadi tandai dulu toko mana
              yang milikmu:
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper own-shop shopee i_bricks
                <br />
                ecom-scraper own-shop tokopedia i-bricks
              </code>
            </>
          }
        />
      </div>
    );
  }

  const analytics = await getPricingAnalytics(channel);
  const { position, rivals, bands, gapVolume } = analytics;

  const compared = position.cheapest + position.middle + position.dearest;
  const totalAtStake = bands.reduce((sum, band) => sum + Number(band.atStake ?? 0), 0);
  const biggestBand = [...bands].sort(
    (a, b) => Number(b.atStake ?? 0) - Number(a.atStake ?? 0),
  )[0];
  const topRival = rivals[0];

  if (compared === 0) {
    return (
      <div className="space-y-6">
        <Header shop={shop} />
        <EmptyState
          title="Belum ada produk yang bisa dibandingkan"
          description="Scrape katalog beberapa toko kompetitor dulu — perbandingannya terjadi di database setelah itu, dan halaman ini terisi sendiri."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header shop={shop} />

      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Selisih yang dipertaruhkan"
            value={<span className="text-negative">{formatPrice(totalAtStake)}</span>}
            hint="total kita di atas lawan termurah"
          />
          <Stat
            label="Paling menekan"
            value={topRival ? topRival.username : '–'}
            hint={
              topRival
                ? `menang di ${count.format(topRival.beats)} produk kita`
                : 'belum ada yang menjual lebih murah'
            }
          />
          <Stat
            label="Rentang paling mahal"
            value={biggestBand ? biggestBand.band : '–'}
            hint={
              biggestBand
                ? `${formatPrice(biggestBand.atStake)} dari ${count.format(biggestBand.overpriced)} produk`
                : '–'
            }
          />
          <Stat
            label="Dibandingkan"
            value={count.format(compared)}
            hint={`${count.format(position.unmatched)} belum punya pembanding`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Siapa yang menekan harga kita</CardTitle>
          <span className="text-xs text-muted">10 teratas · diurut jumlah produk</span>
        </CardHeader>
        <CardContent className="space-y-3">
          <RivalPressureChart rivals={rivals} />
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            Diurut dari banyaknya produk, bukan dalamnya potongan. Toko yang mengalahkan kita di 200
            produk dengan selisih 10% menentukan lantai harga jauh lebih banyak daripada yang
            mengalahkan di tiga produk dengan selisih 60%.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Di mana uangnya</CardTitle>
          <span className="text-xs text-muted">selisih rupiah per rentang harga</span>
        </CardHeader>
        <CardContent className="space-y-3">
          <PriceBandChart bands={bands} />
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            Grafik ini sering berbeda pendapat dengan daftar kerja. Diurut persen, produk murah yang
            menguasai halaman pertama; diurut rupiah, segelintir produk mahal yang menanggung
            sebagian besar selisihnya — dan di sanalah satu sore mengubah harga benar-benar terbayar.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Posisi katalog</CardTitle>
          <span className="text-xs text-muted">{count.format(compared)} produk punya pembanding</span>
        </CardHeader>
        <CardContent>
          <PositionMixChart position={position} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Selisih harga lawan volume terjual</CardTitle>
          <span className="text-xs text-muted">
            {count.format(gapVolume.length)} produk yang punya angka terjual
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          <GapVolumeChart points={gapVolume} />
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            Kalau harga menggerakkan penjualan di katalogmu, titik-titik di kanan garis nol — tempat
            kita lebih mahal — akan duduk lebih rendah daripada yang di kiri. Kalau sebarannya rata,
            pembelimu memutuskan atas dasar lain, dan memotong harga belum tentu menambah penjualan.
            Angka terjual adalah total sepanjang umur listing, bukan laju, jadi ini petunjuk — bukan
            bukti.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted">
        Semua angka di atas adalah potret satu waktu, dari snapshot terbaru tiap produk. Tren harga
        baru bisa digambar setelah produk yang sama di-scrape di hari yang berbeda.{' '}
        <Link href={withChannel('/pricing', channel)} className="text-accent underline-offset-4 hover:underline">
          Buka daftar kerja
        </Link>{' '}
        untuk menindaklanjuti per produk.
      </p>
    </div>
  );
}

function Header({ shop }: { shop?: OwnShop | null }) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Analitik
        {shop ? (
          <span className="ml-2 text-base font-normal text-muted">
            {MARKETPLACE_LABELS[shop.marketplace]} · {shop.username}
          </span>
        ) : null}
      </h1>
      <p className="max-w-2xl text-sm text-muted">
        Empat pertanyaan yang menentukan keputusan harga: siapa yang menekan kita, di mana uangnya,
        seberapa besar katalog yang terekspos, dan apakah harga benar-benar menggerakkan penjualan.
      </p>
    </header>
  );
}
