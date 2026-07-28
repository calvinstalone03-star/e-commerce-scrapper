'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts';

import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

import { ChartFrame } from '@/components/ChartFrame';
import { EmptyState } from '@/components/EmptyState';
import { formatPrice, formatPriceShort } from '@/lib/format';

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
 * The cross-shop comparison charts.
 *
 * Client components because a chart without a tooltip is a picture — the
 * hovering is the feature. Everything they receive is already resolved on the
 * server: plain, serialisable props, no query and no store-name logic on this
 * side of the boundary.
 *
 * Colours are the palette's own custom properties rather than hex. `--accent`
 * and friends already flip with the colour scheme in `globals.css`, so one
 * `fill` reads correctly in both themes and a redesign lands here for free.
 */

/**
 * Prices travel from Postgres as NUMERIC strings so no float rounding creeps
 * in. Recharts places pixels and needs numbers, so the conversion is confined
 * to chart geometry — every value rendered as text goes back to the original
 * string and through `format.ts`.
 */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 11 } as const;

function tooltipDatum<T>(payload: TooltipContentProps['payload']): T | undefined {
  return payload?.[0]?.payload as T | undefined;
}

function TooltipShell({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="max-w-64 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 leading-snug font-semibold text-foreground">{title}</p>
      <dl className="space-y-0.5">{children}</dl>
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function truncateTick(value: string): string {
  return value.length > 22 ? `${value.slice(0, 21)}…` : value;
}

// ---------------------------------------------------------------------------
// Average price per shop
// ---------------------------------------------------------------------------

export type ComparisonDatum = {
  storeId: number | null;
  /** Already resolved through `formatStoreName` on the server. */
  label: string;
  products: number;
  minPrice: string | null;
  maxPrice: string | null;
  avgPrice: string | null;
};

type BarDatum = {
  key: string;
  avg: number;
  /** `ErrorBar` reads offsets relative to the bar value: [avg − min, max − avg]. */
  spread: [number, number];
  source: ComparisonDatum;
};

function ComparisonTooltip({ active, payload }: TooltipContentProps) {
  const datum = tooltipDatum<BarDatum>(payload);
  if (!active || !datum) return null;
  const { source } = datum;

  return (
    <TooltipShell title={source.label}>
      <TooltipRow label="Rata-rata" value={formatPrice(source.avgPrice)} />
      <TooltipRow label="Terendah" value={formatPrice(source.minPrice)} />
      <TooltipRow label="Tertinggi" value={formatPrice(source.maxPrice)} />
      <TooltipRow label="Produk" value={String(source.products)} />
    </TooltipShell>
  );
}

/** Cheapest first — the order the query already returns. */
export function ComparisonChart({ rows }: { rows: ComparisonDatum[] }) {
  // Two shops can share a display name, and a category axis silently merges
  // duplicate values — which would hide a competitor rather than show one.
  const used = new Map<string, number>();
  const data: BarDatum[] = [];

  for (const row of rows) {
    const avg = toNumber(row.avgPrice);
    if (avg === null) continue;

    const seen = used.get(row.label) ?? 0;
    used.set(row.label, seen + 1);

    const min = toNumber(row.minPrice) ?? avg;
    const max = toNumber(row.maxPrice) ?? avg;

    data.push({
      key: seen === 0 ? row.label : `${row.label} (${row.storeId ?? seen + 1})`,
      avg,
      spread: [Math.max(avg - min, 0), Math.max(max - avg, 0)],
      source: row,
    });
  }

  if (data.length === 0) {
    return (
      <EmptyState
        title="Belum ada harga untuk dibandingkan"
        description="Tidak ada toko dengan harga tercatat pada kata kunci ini. Jalankan scrape pencarian untuk mengisinya."
      />
    );
  }

  // A shop with one product has no internal range, and whiskers of length zero
  // would imply a measurement that was never taken.
  const hasSpread = data.some((datum) => datum.spread[0] > 0 || datum.spread[1] > 0);
  // Cheapest and dearest only mean something once there is something to be
  // cheaper than.
  const ranked = data.length > 1;
  const height = Math.min(Math.max(data.length * 34 + 56, 176), 720);

  return (
    <div className="space-y-2">
      {/* Recharts measures its parent, and a flex or grid child with no height
          of its own resolves to zero — which renders as a blank box that looks
          like a bug. The wrapper is what fixes that. */}
      <ChartFrame height={height}>
        {(box) => (
          <BarChart
            width={box.width}
            height={box.height}
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 28, bottom: 4, left: 4 }}
            barCategoryGap="22%"
          >
            <CartesianGrid horizontal={false} stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              tickFormatter={formatPriceShort}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
            />
            <YAxis
              type="category"
              dataKey="key"
              width={150}
              tickFormatter={truncateTick}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={ComparisonTooltip} cursor={{ fill: 'var(--surface-muted)' }} />
            {/* Bars grow from zero width via requestAnimationFrame, and a
                rectangle of zero width renders as nothing at all — so a chart
                loaded in a background tab, where rAF never fires, stays blank.
                A dashboard should also be readable the instant it paints, and
                the entry animation ignores prefers-reduced-motion. */}
            <Bar
              dataKey="avg"
              name="Rata-rata"
              radius={[0, 4, 4, 0]}
              maxBarSize={26}
              isAnimationActive={false}
            >
              {data.map((datum, index) => (
                <Cell
                  key={datum.key}
                  fill={
                    !ranked
                      ? 'var(--accent)'
                      : index === 0
                        ? 'var(--positive)'
                        : index === data.length - 1
                          ? 'var(--negative)'
                          : 'var(--accent)'
                  }
                />
              ))}
              {hasSpread ? (
                <ErrorBar
                  dataKey="spread"
                  stroke="var(--muted)"
                  strokeWidth={1.5}
                  width={5}
                />
              ) : null}
            </Bar>
          </BarChart>
        )}
      </ChartFrame>

      <p className="text-xs leading-relaxed text-muted">
        Batang adalah harga rata-rata tiap toko, diurutkan dari termurah.
        {hasSpread
          ? ' Garis di ujung batang membentang dari harga terendah ke tertinggi di toko yang sama.'
          : ' Setiap toko baru punya satu harga tercatat, jadi belum ada rentang untuk digambar.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distribution of individual product prices
// ---------------------------------------------------------------------------

export type DistributionPoint = {
  id: number;
  name: string;
  /** Already resolved through `formatStoreName` on the server. */
  store: string;
  price: string;
};

type StripDatum = {
  price: number;
  lane: number;
  source: DistributionPoint;
};

function DistributionTooltip({ active, payload }: TooltipContentProps) {
  const datum = tooltipDatum<StripDatum>(payload);
  if (!active || !datum) return null;
  const { source } = datum;

  return (
    <TooltipShell title={source.name}>
      <TooltipRow label="Harga" value={formatPrice(source.price)} />
      <TooltipRow label="Toko" value={source.store} />
    </TooltipShell>
  );
}

/**
 * Every individual product price for one keyword, on a single axis.
 *
 * A strip plot rather than a histogram: with a handful of products a histogram
 * is one bar tall and reads as a rendering failure, while every dot here is a
 * real product whether there are three of them or three hundred. Overlapping
 * dots darken, which carries the density a histogram would have shown.
 */
export function PriceDistributionChart({
  points,
  truncated = false,
}: {
  points: DistributionPoint[];
  /**
   * True when `points` is a capped slice of the keyword rather than all of it.
   *
   * The caller asks for products sorted by price ascending and the filter
   * schema caps a page at 200, so a keyword with more than that arrives as its
   * 200 *cheapest* products. The mean of those is not the mean of the keyword,
   * and a dashed line labelled "rata-rata" is the number a reader takes away —
   * so when the set is capped the label says which set it is the average of.
   */
  truncated?: boolean;
}) {
  const data: StripDatum[] = [];
  for (const point of points) {
    const price = toNumber(point.price);
    if (price === null) continue;
    data.push({ price, lane: 0.5, source: point });
  }

  if (data.length === 0) {
    return (
      <EmptyState
        title="Belum ada harga produk"
        description="Produk pada kata kunci ini belum punya snapshot harga yang bisa dipetakan."
      />
    );
  }

  const prices = data.map((datum) => datum.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  // One price collapses the domain to a point, and an axis with no extent draws
  // as a single tick pinned to the left edge. Pad around it instead.
  const pad = high === low ? Math.max(high * 0.2, 1000) : (high - low) * 0.08;
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;

  return (
    <div className="space-y-2">
      <ChartFrame height={168}>
        {(box) => (
          <ScatterChart width={box.width} height={box.height} margin={{ top: 28, right: 28, bottom: 4, left: 4 }}>
            <CartesianGrid horizontal={false} stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="price"
              domain={[Math.max(low - pad, 0), high + pad]}
              tickFormatter={formatPriceShort}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
            />
            <YAxis type="number" dataKey="lane" domain={[0, 1]} hide />
            <Tooltip
              content={DistributionTooltip}
              cursor={{ stroke: 'var(--line)', strokeDasharray: '3 3' }}
            />
            {data.length > 1 ? (
              <ReferenceLine
                x={mean}
                stroke="var(--muted)"
                strokeDasharray="4 4"
                label={{
                  value: truncated ? `rata-rata ${data.length} termurah` : 'rata-rata',
                  position: 'top',
                  fill: 'var(--muted)',
                  fontSize: 11,
                }}
              />
            ) : null}
            <Scatter
              data={data}
              fill="var(--accent)"
              fillOpacity={0.7}
            />
          </ScatterChart>
        )}
      </ChartFrame>

      <p className="text-xs leading-relaxed text-muted">
        {data.length === 1
          ? 'Satu produk tercatat untuk kata kunci ini, jadi sebarannya masih satu titik.'
          : `${data.length} produk, satu titik masing-masing. Titik yang menumpuk berarti beberapa produk berharga sama.`}
        {truncated && data.length > 1
          ? ' Kata kunci ini punya lebih banyak produk daripada yang muat dalam satu halaman, jadi yang dipetakan adalah yang termurah — garis putus-putus adalah rata-rata dari titik-titik ini saja, bukan rata-rata seluruh kata kunci.'
          : null}
      </p>
    </div>
  );
}
