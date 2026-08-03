import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { PriceChart } from '@/components/PriceChart';
import { ProductImage } from '@/components/ProductImage';
import { RivalPriceChart, type SellerDatum } from '@/components/RivalPriceChart';
import { Badge, Card, CardContent, CardHeader, CardTitle, Stat, TBody, TD, TH, THead, TR, Table } from '@/components/ui';
import { CHANNEL_PARAM, withChannel } from '@/lib/channel';
import {
  MARKETPLACE_LABELS,
  formatDateTime,
  formatPrice,
  formatRating,
  formatSold,
  formatStoreName,
} from '@/lib/format';
import { getPriceHistory, getPricePositionDetail } from '@/lib/queries';

/**
 * One of our products against every rival tied to it.
 *
 * The worklist answers "which price do I need to look at"; this answers "and
 * what am I actually up against" — who undercuts us, by how much, and whether
 * they are shifting stock at that price, which is what makes a lower number
 * worth reacting to rather than ignoring.
 */

export const dynamic = 'force-dynamic';

const percent = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getPricePositionDetail(Number(id));
  return {
    title: detail?.product.name ?? 'Posisi harga',
    description: 'Harga kita dibanding penjual lain untuk produk yang sama.',
  };
}

export default async function PricingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId < 1) notFound();

  const detail = await getPricePositionDetail(productId);
  if (!detail) notFound();

  // `getPricePositionDetail` already resolved this product's channel to build
  // its `mine` CTE (`ourListings` filters on `s.marketplace = channel`), so
  // `product.marketplace` *is* that channel by construction — a second
  // `channelOfOwnProduct` call here would only re-pay for a value already in
  // hand.
  const channel = detail.product.marketplace;
  const asked = (await searchParams)[CHANNEL_PARAM];

  // The id already names a shop, so a link that arrives with the other channel
  // (or none) is corrected rather than shown under the wrong heading. Not
  // inside a try/catch: redirect() throws to signal Next, and a surrounding
  // catch would swallow that throw and turn this into a normal render.
  // withChannel() always sets a single query value, so the corrected URL's
  // `asked` can only equal `channel` on the next request — one hop, not a loop.
  if (asked !== channel) {
    redirect(withChannel(`/pricing/${productId}`, channel));
  }

  const { product, rivals } = detail;
  const history = await getPriceHistory(productId);

  // One row per seller, ours among them rather than beside them — the chart's
  // whole job is showing where we sit in that list, which needs us *in* it.
  // Sorted cheapest first so the bar order is the ranking.
  const sellers: SellerDatum[] = [];
  if (product.price !== null) {
    sellers.push({
      id: product.id,
      label: 'Toko kita',
      marketplace: product.marketplace,
      price: Number(product.price),
      sold: null,
      ours: true,
    });
  }
  // One shop routinely lists the same set several times — a collectible series
  // is one number across a dozen characters — so the shop name alone would
  // label nine bars identically and identify none of them. Only the repeats pay
  // for the longer label.
  const perStore = new Map<string, number>();
  for (const rival of rivals) {
    const store = formatStoreName(rival.storeUsername, rival.storeName);
    perStore.set(store, (perStore.get(store) ?? 0) + 1);
  }

  for (const rival of rivals) {
    if (rival.price === null) continue;
    const store = formatStoreName(rival.storeUsername, rival.storeName);
    sellers.push({
      id: rival.id,
      label: (perStore.get(store) ?? 0) > 1 ? `${store} · ${variantOf(rival.name)}` : store,
      marketplace: rival.marketplace,
      price: Number(rival.price),
      sold: rival.sold,
      ours: false,
    });
  }
  sellers.sort((a, b) => a.price - b.price);

  return (
    <div className="space-y-6">
      <div className="text-sm">
        <Link href={withChannel('/pricing', channel)} className="text-muted underline-offset-4 hover:underline">
          ← Semua posisi harga
        </Link>
      </div>

      <header className="flex flex-wrap items-start gap-4">
        {product.image ? (
          <ProductImage src={product.image} alt={product.name} size={80} className="rounded-md" />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {product.name ?? 'Produk tanpa nama'}
          </h1>
          <div className="flex flex-wrap items-center gap-1.5">
            {product.setCode ? (
              <Badge variant="default">set {product.setCode}</Badge>
            ) : (
              <Badge variant="muted">tanpa nomor set</Badge>
            )}
            <Badge variant={product.marketplace === 'shopee' ? 'shopee' : 'tokopedia'}>
              {MARKETPLACE_LABELS[product.marketplace] ?? product.marketplace}
            </Badge>
            {product.url ? (
              <a
                href={product.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm text-accent underline-offset-4 hover:underline"
              >
                Buka di marketplace
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Harga kita" value={formatPrice(product.price)} hint={formatDateTime(product.scrapedAt)} />
          <Stat
            label="Termurah lawan"
            value={rivals.length === 0 ? '–' : formatPrice(product.cheapestPrice)}
            hint={
              rivals.length === 0
                ? 'belum ada pembanding'
                : `${formatStoreName(product.cheapestStore, null)} · ${
                    MARKETPLACE_LABELS[product.cheapestMarketplace ?? ''] ?? product.cheapestMarketplace
                  }`
            }
          />
          <Stat
            label="Posisi"
            value={product.position === null ? '–' : `${product.position}/${rivals.length + 1}`}
            hint={product.position === 1 ? 'tidak ada yang lebih murah' : 'dari termurah'}
          />
          <Stat
            label="Selisih"
            value={
              product.gapPercent === null ? (
                '–'
              ) : (
                <span className={product.gapPercent > 0 ? 'text-negative' : 'text-positive'}>
                  {product.gapPercent > 0 ? '+' : '−'}
                  {percent.format(Math.abs(product.gapPercent))}%
                </span>
              )
            }
            hint="terhadap lawan termurah"
          />
        </CardContent>
      </Card>

      {/*
        Read from product.extreme rather than recomputed from gapPercent here:
        the server already decided this, symmetrically, the same value the
        worklist badge and its extreme:'hide' filter use. Re-deriving it from
        the signed, rival-denominated gapPercent was a second, silently
        different copy of the rule — it missed the gap entirely whenever the
        rival was the dearer side, no matter how large.
      */}
      {product.extreme ? (
        <p className="rounded-md border border-line bg-surface-muted px-3 py-2.5 text-sm leading-relaxed text-muted">
          Selisihnya sangat besar. LEGO memakai satu nomor set untuk seluruh seri
          minifigure, jadi blind bag satuan, varian keychain, dan satu set penuh sama-sama
          bernomor {product.setCode ?? '—'} dan wajar berbeda harga berkali lipat. Bandingkan
          gambar dan nama di bawah sebelum memakai angka ini.
        </p>
      ) : null}

      {product.matchKind === 'name' ? (
        // Said outright rather than buried in a legend: every number above rests
        // on this pairing, and a reader who does not know it was a guess cannot
        // judge whether to trust them.
        <p className="rounded-md border border-line bg-surface-muted px-3 py-2.5 text-sm leading-relaxed text-muted">
          Produk ini tidak punya nomor set, jadi lawannya dicocokkan dari kemiripan nama. Periksa
          sendiri apakah barangnya memang sama sebelum mengubah harga.
        </p>
      ) : null}

      {sellers.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Harga tiap penjual</CardTitle>
            <span className="text-xs text-muted">
              {sellers.length} penjual · snapshot terbaru
            </span>
          </CardHeader>
          <CardContent>
            {/* The ranking as a shape: our bar's place in the stack is our
                position, with nothing to count. */}
            <RivalPriceChart sellers={sellers} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Penjual lain</CardTitle>
          <span className="text-xs text-muted">
            {rivals.length === 0 ? 'belum ada' : `${rivals.length} produk · diurut termurah`}
          </span>
        </CardHeader>
        <CardContent>
          {rivals.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">
              Belum ada produk toko lain dengan {product.setCode ? `nomor set ${product.setCode}` : 'nama yang cukup mirip'}{' '}
              di database. Scrape katalog toko kompetitor, lalu halaman ini terisi sendiri.
            </p>
          ) : (
            <Table maxHeight="none">
              <THead>
                <TR>
                  <TH>Toko</TH>
                  <TH>Produk</TH>
                  <TH className="text-right">Harga</TH>
                  <TH className="text-right">Selisih</TH>
                  <TH className="text-right">Terjual</TH>
                  <TH className="text-right">Rating</TH>
                </TR>
              </THead>
              <TBody>
                {rivals.map((rival) => {
                  const gap = gapAgainst(product.price, rival.price);
                  return (
                    <TR key={rival.id}>
                      <TD>
                        <div className="font-medium text-foreground">
                          {formatStoreName(rival.storeUsername, rival.storeName)}
                        </div>
                        <Badge
                          variant={rival.marketplace === 'shopee' ? 'shopee' : 'tokopedia'}
                          className="mt-1"
                        >
                          {MARKETPLACE_LABELS[rival.marketplace] ?? rival.marketplace}
                        </Badge>
                      </TD>
                      <TD>
                        <div className="flex items-start gap-2.5">
                          {/* The picture is the check: a pairing that is plainly
                              the wrong box is obvious here and invisible in a
                              row of numbers. */}
                          <ProductImage
                            src={rival.image}
                            alt={rival.name}
                            size={40}
                            className="mt-0.5 shrink-0 rounded"
                          />
                          <div className="min-w-0">
                            {rival.url ? (
                              <a
                                href={rival.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="underline-offset-4 hover:underline"
                              >
                                {rival.name ?? 'Produk tanpa nama'}
                              </a>
                            ) : (
                              (rival.name ?? 'Produk tanpa nama')
                            )}
                            {rival.matchKind === 'name' ? (
                              <Badge variant="muted" className="ml-2">
                                ~ mirip {rival.similarity !== null ? rival.similarity : ''}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      </TD>
                      <TD className="text-right tabular-nums">{formatPrice(rival.price)}</TD>
                      <TD className="text-right tabular-nums">
                        {gap === null ? (
                          <span className="text-muted">–</span>
                        ) : (
                          // Framed from their side: "this seller is 12% under
                          // us" is the sentence somebody acts on.
                          <span className={gap < 0 ? 'text-negative' : 'text-positive'}>
                            {gap > 0 ? '+' : '−'}
                            {percent.format(Math.abs(gap))}%
                          </span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">{formatSold(rival.sold)}</TD>
                      <TD className="text-right tabular-nums">{formatRating(rival.ratingStar)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {history.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Riwayat harga kita</CardTitle>
            <span className="text-xs text-muted">{history.length} snapshot</span>
          </CardHeader>
          <CardContent>
            <PriceChart points={history} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * The part of a title that tells two listings of one set apart.
 *
 * Sellers put the distinguishing bit last — "… Race Cars - Kick Sauber",
 * "… Race Cars - Alpine" — so the tail after the final dash is what a person
 * would read to tell them apart. Without a dash there is nothing structured to
 * take, and the tail of the title is still more distinguishing than its head,
 * which is the shared set name.
 */
function variantOf(name: string | null): string {
  const text = (name ?? '').trim();
  if (!text) return 'varian lain';
  const parts = text.split(/\s+[-–—]\s+/);
  const tail = parts.length > 1 ? parts[parts.length - 1] : text.slice(-20);
  return tail.length > 24 ? `${tail.slice(0, 23)}…` : tail;
}

/**
 * A rival's price against ours, in percent, from the rival's point of view:
 * negative means they undercut us.
 */
function gapAgainst(ours: string | null, theirs: string | null): number | null {
  if (ours === null || theirs === null) return null;
  const mine = Number(ours);
  const rival = Number(theirs);
  if (!Number.isFinite(mine) || !Number.isFinite(rival) || mine === 0) return null;
  return Math.round(((rival - mine) / mine) * 1000) / 10;
}
