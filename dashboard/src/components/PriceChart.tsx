'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts';

import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

import { ChartFrame } from '@/components/ChartFrame';
import { EmptyState } from '@/components/EmptyState';
import { Card, CardContent } from '@/components/ui';
import {
  formatDate,
  formatDateTime,
  formatPrice,
  formatPriceShort,
  formatRating,
  formatSold,
  priceDelta,
} from '@/lib/format';
import type { PricePoint } from '@/lib/schemas';

/**
 * Recharts v2's tooltip prop type, under the name the v3 API used.
 *
 * The chart components were written against v3, which had to be pinned back to
 * v2 because v3.10 renders an empty wrapper under React 19. v2 spells this
 * `TooltipProps<ValueType, NameType>`; aliasing it here keeps the change to the
 * import line instead of every tooltip signature.
 */
type TooltipContentProps = TooltipProps<ValueType, NameType>;


/**
 * Price over time for one product.
 *
 * `price_snapshots` is append-only and the scraper has run once, so the normal
 * case today is exactly one snapshot. One observation is not a trend and is not
 * drawn as one: no line through a single point, and no time axis whose two ends
 * are the same instant. That branch shows the observation it has and says what
 * would make a chart appear.
 */

/**
 * Prices travel from Postgres as NUMERIC strings so no float rounding creeps
 * in. Recharts places pixels and needs numbers, so the conversion is confined
 * to chart geometry — the tooltip formats the original string.
 */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 11 } as const;

// `format.ts` has no percent formatter and is not ours to extend. Same locale as
// the money beside it, so "6,0%" does not sit next to "Rp 159.000".
const percent = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

type ChartPoint = {
  t: number;
  price: number;
  source: PricePoint;
};

/** Evenly sampled ticks that always keep the first and last scrape. */
function pickTicks(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  const ticks = new Set<number>();
  for (let index = 0; index < max; index += 1) {
    ticks.add(values[Math.round(index * step)]);
  }
  return [...ticks];
}

function HistoryTooltip({ active, payload }: TooltipContentProps) {
  const datum = payload?.[0]?.payload as ChartPoint | undefined;
  if (!active || !datum) return null;
  const { source } = datum;

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold text-foreground">{formatDateTime(source.scrapedAt)}</p>
      <dl className="space-y-0.5">
        {[
          { label: 'Harga', value: formatPrice(source.price) },
          { label: 'Terjual', value: formatSold(source.sold) },
          { label: 'Rating', value: formatRating(source.ratingStar) },
        ].map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-6">
            <dt className="text-muted">{row.label}</dt>
            <dd className="font-medium tabular-nums text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export type PriceChartProps = {
  /** Snapshot history for one product, oldest first — `getPriceHistory()`. */
  points: PricePoint[];
};

export function PriceChart({ points }: PriceChartProps) {
  const data: ChartPoint[] = [];
  for (const point of points) {
    const price = toNumber(point.price);
    const t = point.scrapedAt === null ? Number.NaN : Date.parse(point.scrapedAt);
    if (price === null || Number.isNaN(t)) continue;
    data.push({ t, price, source: point });
  }
  data.sort((a, b) => a.t - b.t);

  if (data.length === 0) {
    return (
      <EmptyState
        title="Belum ada snapshot harga"
        description="Produk ini tercatat tanpa harga yang berhasil dibaca. Scrape ulang halamannya untuk mengambil harga pertama."
      />
    );
  }

  if (data.length === 1) {
    const only = data[0].source;

    return (
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-2xl leading-tight font-semibold tracking-tight tabular-nums text-foreground">
              {formatPrice(only.price)}
            </p>
            <p className="text-xs text-muted">{formatDateTime(only.scrapedAt)}</p>
          </div>

          {/* One real observation, and a dashed run-out standing in for the
              scrapes that have not happened. Nothing is plotted to the right of
              the dot because nothing has been measured there. */}
          <div>
            <div className="relative h-3">
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-line" />
              <span className="absolute top-1/2 left-[6%] size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-4 ring-surface" />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>{formatDate(only.scrapedAt)}</span>
              <span>belum ada scrape berikutnya</span>
            </div>
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-4 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">Terjual</dt>
              <dd className="font-medium tabular-nums text-foreground">{formatSold(only.sold)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Rating</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {formatRating(only.ratingStar)}
              </dd>
            </div>
          </dl>

          <p className="rounded-md bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-muted">
            Baru ada satu pengamatan, jadi belum ada tren yang bisa digambar. Riwayat harga
            terbentuk sendiri begitu halaman produk yang sama di-scrape lagi di hari lain — titik
            kedua langsung memunculkan grafiknya.
          </p>
        </CardContent>
      </Card>
    );
  }

  const prices = data.map((point) => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  // A price that never moved would otherwise sit flat on the axis floor with no
  // room above or below it.
  const pad = high === low ? Math.max(high * 0.05, 1000) : (high - low) * 0.15;
  const first = data[0].source;
  const last = data[data.length - 1].source;
  const change = priceDelta(first.price, last.price);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-2xl leading-tight font-semibold tracking-tight tabular-nums text-foreground">
          {formatPrice(last.price)}
        </p>
        {change === null ? null : (
          <p
            className={`text-sm font-medium tabular-nums ${
              change.absolute > 0
                ? 'text-negative'
                : change.absolute < 0
                  ? 'text-positive'
                  : 'text-muted'
            }`}
          >
            {change.absolute > 0 ? '+' : ''}
            {formatPrice(change.absolute)} ({percent.format(change.percent)}%) sejak{' '}
            {formatDate(first.scrapedAt)}
          </p>
        )}
      </div>

      {/* Recharts measures its parent, and a child with no height of its own
          resolves to zero — a blank box that reads as a rendering bug. */}
      <ChartFrame height={260}>
        {(box) => (
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              type="number"
              dataKey="t"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={pickTicks(
                data.map((point) => point.t),
                6,
              )}
              tickFormatter={(value: number) => formatDate(new Date(value).toISOString())}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
            />
            <YAxis
              type="number"
              domain={[Math.max(low - pad, 0), high + pad]}
              tickFormatter={formatPriceShort}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={76}
            />
            <Tooltip content={HistoryTooltip} cursor={{ stroke: 'var(--line)' }} />
            {/* The line draws itself in via requestAnimationFrame, which never
                fires in a background tab — the chart would sit blank until the
                tab is focused. A dashboard should read the moment it paints. */}
            <Line
              type="monotone"
              dataKey="price"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={{ r: 3, fill: 'var(--accent)', stroke: 'var(--accent)' }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        )}
      </ChartFrame>

      <p className="text-xs text-muted">
        {data.length} snapshot, {formatDate(first.scrapedAt)} – {formatDate(last.scrapedAt)}.
      </p>
    </div>
  );
}
