'use client';

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Scatter,
  ScatterChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipProps,
} from 'recharts';

import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

import { ChartFrame } from '@/components/ChartFrame';
import { MARKETPLACE_LABELS, formatPrice, formatPriceShort, formatSold } from '@/lib/format';
import type { GapVolumePoint, PriceBand, RivalPressure } from '@/lib/schemas';

/**
 * The analytics screen's charts.
 *
 * Colour here is the validated blue/amber pair, not the green/red the tables
 * use for gap figures. Those work as text, where the word and the sign carry
 * the meaning — as chart fills they do not: run through the palette validator,
 * green against red separates by ΔE 4.2 under deuteranopia, which is to say not
 * at all. Blue against amber separates by 30, and every chart here also labels
 * its marks directly, so nothing depends on colour alone.
 */

type TooltipContentProps = TooltipProps<ValueType, NameType>;

const percent = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat('id-ID');

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 12 } as const;

// ---------------------------------------------------------------------------
// Who is pressing our prices
// ---------------------------------------------------------------------------

/**
 * Competitors ranked by how much of our catalogue they undercut.
 *
 * The count is what ranks them, not the depth: a shop that beats us on 229
 * products by 10% sets our floor far more than one that beats us on three by
 * 60%. The depth rides along as a label, because it is the second question
 * anyone asks.
 */
export function RivalPressureChart({ rivals }: { rivals: RivalPressure[] }) {
  const data = rivals.slice(0, 10);
  if (data.length === 0) return null;

  const height = Math.max(140, data.length * 38 + 40);

  return (
    <ChartFrame height={height}>
      {(box) => (
        <BarChart
          width={box.width}
          height={box.height}
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 132, bottom: 4, left: 8 }}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="username"
            width={148}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
          />
          <Tooltip cursor={{ fill: 'var(--surface-muted)' }} content={<RivalTooltip />} />
          <Bar dataKey="beats" fill="var(--chart-rival)" radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
            {/* The number alone: Recharts wraps a label to the width of the
                bar it belongs to, so "8 produk" broke onto two lines on every
                short bar. The card title already says these are products. */}
            <LabelList
              dataKey="beats"
              position="right"
              offset={8}
              fill="var(--foreground)"
              fontSize={12}
              formatter={(value: number) => count.format(value)}
            />
          </Bar>
        </BarChart>
      )}
    </ChartFrame>
  );
}

function RivalTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const rival = payload[0].payload as RivalPressure;
  return (
    <TooltipBox title={`${rival.username} · ${MARKETPLACE_LABELS[rival.marketplace] ?? rival.marketplace}`}>
      <div>{count.format(rival.beats)} produk kita dijual lebih murah</div>
      {rival.averageGap !== null ? (
        <div>rata-rata {percent.format(Math.abs(rival.averageGap))}% di bawah kita</div>
      ) : null}
      <div className="text-muted">{count.format(rival.meets)} produk sama, harga tidak lebih murah</div>
    </TooltipBox>
  );
}

// ---------------------------------------------------------------------------
// Where the money is
// ---------------------------------------------------------------------------

/**
 * Rupiah left on the table, by price bracket.
 *
 * This is the chart that argues with the worklist. Sorted by percentage, the
 * cheap end of the catalogue dominates — hundreds of products 30% over. Sorted
 * by money, a few dozen expensive ones carry most of the exposure, and they are
 * where an afternoon of repricing actually pays.
 */
export function PriceBandChart({ bands }: { bands: PriceBand[] }) {
  const data = bands.map((band) => ({ ...band, stake: Number(band.atStake ?? 0) }));
  if (data.length === 0) return null;

  return (
    <ChartFrame height={Math.max(140, data.length * 44 + 40)}>
      {(box) => (
        <BarChart
          width={box.width}
          height={box.height}
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 120, bottom: 4, left: 8 }}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="band"
            width={132}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
          />
          <Tooltip cursor={{ fill: 'var(--surface-muted)' }} content={<BandTooltip />} />
          <Bar dataKey="stake" fill="var(--chart-ours)" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
            <LabelList
              dataKey="stake"
              position="right"
              offset={8}
              fill="var(--foreground)"
              fontSize={12}
              formatter={(value: number) => formatPriceShort(value)}
            />
          </Bar>
        </BarChart>
      )}
    </ChartFrame>
  );
}

function BandTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const band = payload[0].payload as PriceBand & { stake: number };
  return (
    <TooltipBox title={band.band}>
      <div>{formatPrice(band.stake)} selisih terhadap lawan termurah</div>
      <div className="text-muted">
        {count.format(band.overpriced)} dari {count.format(band.products)} produk kemahalan
      </div>
    </TooltipBox>
  );
}

// ---------------------------------------------------------------------------
// Where the catalogue sits
// ---------------------------------------------------------------------------

/**
 * How much of the catalogue is cheapest, in between, or dearest.
 *
 * One stacked bar rather than a pie: the parts are being compared to each other
 * and to the whole, which a length does well and an angle does badly. Products
 * with no comparator sit outside it — they are not a position, they are a
 * scraping gap, and folding them in would quietly make the picture look better
 * than it is.
 */
export function PositionMixChart({
  position,
}: {
  position: { cheapest: number; middle: number; dearest: number; unmatched: number };
}) {
  const total = position.cheapest + position.middle + position.dearest;
  if (total === 0) return null;

  const segments = [
    { key: 'cheapest', label: 'Termurah', value: position.cheapest, fill: 'var(--chart-ours)' },
    { key: 'middle', label: 'Di tengah', value: position.middle, fill: 'var(--muted)' },
    { key: 'dearest', label: 'Termahal', value: position.dearest, fill: 'var(--chart-rival)' },
  ];

  return (
    <div className="space-y-3">
      {/* Drawn as plain elements rather than a chart library: it is three
          proportions of one line, and the 2px gaps between segments are what a
          stacked bar needs to stay readable. */}
      <div className="flex h-8 w-full gap-0.5 overflow-hidden rounded-md">
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <div
              key={segment.key}
              style={{ width: `${(segment.value / total) * 100}%`, background: segment.fill }}
              className="flex items-center justify-center text-xs font-medium text-white"
              title={`${segment.label}: ${count.format(segment.value)}`}
            >
              {segment.value / total > 0.08 ? count.format(segment.value) : ''}
            </div>
          ))}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ background: segment.fill }} />
            {segment.label}
            <span className="tabular-nums text-foreground">
              {count.format(segment.value)}
            </span>
            <span className="tabular-nums">
              ({percent.format((segment.value / total) * 100)}%)
            </span>
          </span>
        ))}
        <span>
          + {count.format(position.unmatched)} produk belum punya pembanding
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Does the price move the volume
// ---------------------------------------------------------------------------

/**
 * Every priced product: how far off the cheapest rival, against how much it has
 * sold.
 *
 * The vertical line at zero is the whole reading. If price drives volume here,
 * the points to the right of it — where we are dearer — sit lower than those to
 * the left. If they do not, the catalogue is competing on something else, and
 * that is worth knowing before cutting a single price.
 *
 * Sold counts are a lifetime total from the marketplace, not a rate, so this is
 * suggestive rather than conclusive. It is also only the products Shopee bothers
 * to publish a sold count for.
 */
export function GapVolumeChart({ points }: { points: GapVolumePoint[] }) {
  if (points.length === 0) return null;

  // Log-ish compression: a handful of products with 10.000 sold would otherwise
  // flatten every other point onto the axis.
  const data = points.map((point) => ({
    ...point,
    y: Math.log10(Math.max(1, point.sold)),
  }));

  return (
    <ChartFrame height={320}>
      {(box) => (
        <ScatterChart
          width={box.width}
          height={box.height}
          margin={{ top: 8, right: 16, bottom: 28, left: 8 }}
        >
          <XAxis
            type="number"
            dataKey="gapPercent"
            name="selisih"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
            tickFormatter={(value: number) => `${value > 0 ? '+' : ''}${value}%`}
            label={{
              value: 'selisih terhadap lawan termurah',
              position: 'insideBottom',
              offset: -18,
              fill: 'var(--muted)',
              fontSize: 12,
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => formatSold(Math.round(10 ** value))}
            width={56}
          />
          <ZAxis range={[36, 36]} />
          <ReferenceLine x={0} stroke="var(--muted)" strokeDasharray="4 4" />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<GapVolumeTooltip />} />
          <Scatter data={data} isAnimationActive={false}>
            {data.map((point) => (
              <Cell
                key={point.id}
                // Two fills, and the axis already says which side is which —
                // the colour is reinforcement, not the message.
                fill={point.gapPercent > 0 ? 'var(--chart-rival)' : 'var(--chart-ours)'}
                fillOpacity={0.75}
              />
            ))}
          </Scatter>
        </ScatterChart>
      )}
    </ChartFrame>
  );
}

function GapVolumeTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as GapVolumePoint;
  return (
    <TooltipBox title={point.name ?? 'Produk tanpa nama'}>
      <div>
        {point.gapPercent > 0 ? 'lebih mahal ' : 'lebih murah '}
        {percent.format(Math.abs(point.gapPercent))}% dari lawan termurah
      </div>
      <div className="text-muted">
        {formatPrice(point.price)} · {formatSold(point.sold)} terjual
      </div>
    </TooltipBox>
  );
}

function TooltipBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-xs rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 space-y-0.5 text-foreground">{children}</div>
    </div>
  );
}
