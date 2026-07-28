import Link from 'next/link';

import { Card, Stat } from '@/components/ui';
import { MARKETPLACE_LABELS } from '@/lib/format';
import type { Overview } from '@/lib/schemas';

/**
 * The headline totals.
 *
 * Every card is a link. A count with nowhere to go makes the reader hunt for the
 * screen that explains it, so each one carries the filter that produced it.
 */

// Counts, not money and not units sold — `format.ts` owns those. Same locale as
// the pager so a total reads identically wherever it appears.
const count = new Intl.NumberFormat('id-ID');

type StatCard = {
  label: string;
  value: string;
  hint: string;
  href: string;
};

/** "92 Shopee · 2 Tokopedia" — the split, written the way it reads out loud. */
function marketplaceHint(
  rows: Overview['marketplaces'],
  pick: (row: Overview['marketplaces'][number]) => number,
): string {
  const parts = rows
    .filter((row) => pick(row) > 0)
    .map(
      (row) =>
        `${count.format(pick(row))} ${MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace}`,
    );
  return parts.length ? parts.join(' · ') : 'belum ada data';
}

function buildCards(overview: Overview): StatCard[] {
  const perProduct = overview.products > 0 ? overview.snapshots / overview.products : 0;

  return [
    {
      label: 'Toko',
      value: count.format(overview.stores),
      hint: marketplaceHint(overview.marketplaces, (row) => row.stores),
      href: '/stores',
    },
    {
      label: 'Produk',
      value: count.format(overview.products),
      hint: marketplaceHint(overview.marketplaces, (row) => row.products),
      href: '/products',
    },
    {
      label: 'Snapshot harga',
      value: count.format(overview.snapshots),
      // One snapshot per product means there is nothing to plot yet. Saying so
      // here is cheaper than letting the reader find it out at an empty chart.
      hint:
        perProduct > 0 && perProduct < 2
          ? 'baru 1 per produk · riwayat belum terbentuk'
          : `rata-rata ${perProduct.toFixed(1)} per produk`,
      href: '/products?sort=scrapedAt&dir=desc',
    },
    {
      label: 'Kata kunci',
      value: count.format(overview.keywords),
      hint: 'dipakai sebagai kategori produk',
      href: '/keywords',
    },
  ];
}

export function OverviewCards({ overview }: { overview: Overview }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {buildCards(overview).map((card) => (
        <Link key={card.label} href={card.href} className="group">
          <Card className="relative h-full p-4 transition-colors group-hover:border-accent/40 group-hover:bg-surface-muted">
            <Stat label={card.label} value={card.value} hint={card.hint} />
            <span
              aria-hidden
              className="absolute top-4 right-4 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
            >
              →
            </span>
          </Card>
        </Link>
      ))}
    </div>
  );
}
