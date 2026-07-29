'use client';

import { Bar, BarChart, Cell, LabelList, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';

import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

import { ChartFrame } from '@/components/ChartFrame';
import { MARKETPLACE_LABELS, formatPrice, formatPriceShort, formatSold } from '@/lib/format';

/**
 * Every seller of one product, cheapest first, ours marked.
 *
 * A horizontal bar chart because the question is magnitude compared across a
 * handful of named things, and the names are shop slugs — long, unpredictable,
 * and unreadable rotated under a vertical axis. Sorted by price rather than by
 * name so the ranking is the shape of the chart itself: our bar's place in the
 * stack *is* our position, with no counting.
 *
 * Two colours, and never colour alone: our row is also labelled "toko kita",
 * the legend names both, and every bar carries its price as text. That is what
 * keeps the chart readable in greyscale, under colour blindness, and in the
 * screenshot someone pastes into a chat.
 */

type TooltipContentProps = TooltipProps<ValueType, NameType>;

export type SellerDatum = {
  id: number;
  label: string;
  marketplace: string;
  price: number;
  sold: number | null;
  ours: boolean;
};

/** Fits the bars without letting three sellers stretch to fill a screen. */
const ROW_HEIGHT = 42;
const CHART_PADDING = 44;

//: Room for the seller labels. One shop listing a dozen variants of a set makes
//: these long — "Produk Brickz Project · Mercedes AMG" — and Recharts wraps a
//: tick that does not fit, so too narrow an axis silently turns into three lines
//: of text colliding with the row above.
const LABEL_WIDTH = 176;

export function RivalPriceChart({ sellers }: { sellers: SellerDatum[] }) {
  if (sellers.length === 0) return null;

  const height = Math.max(120, sellers.length * ROW_HEIGHT + CHART_PADDING);
  // Room at the right for the price printed past the bar end; without it the
  // dearest seller's label is clipped by the plot edge.
  const max = Math.max(...sellers.map((seller) => seller.price));

  return (
    <div className="space-y-3">
      <Legend />
      <ChartFrame height={height}>
        {(box) => (
          <BarChart
            width={box.width}
            height={box.height}
            data={sellers}
            layout="vertical"
            margin={{ top: 4, right: 96, bottom: 4, left: 8 }}
            barCategoryGap={6}
          >
            <XAxis type="number" domain={[0, max * 1.02]} hide />
            <YAxis
              type="category"
              dataKey="label"
              width={LABEL_WIDTH}
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
            />
            <Tooltip cursor={{ fill: 'var(--surface-muted)' }} content={<SellerTooltip />} />
            {/* Capped rather than left to fill the row: a bar thick enough to
                read as a block competes with the number printed beside it, and
                three sellers would otherwise draw three slabs. */}
            <Bar dataKey="price" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
              {sellers.map((seller) => (
                <Cell
                  key={seller.id}
                  fill={seller.ours ? 'var(--chart-ours)' : 'var(--chart-rival)'}
                />
              ))}
              {/* The number beside the bar, not inside it: inside, a short bar
                  has nowhere to put it and the label lands on the surface in
                  the fill's colour, which is the one place text must never
                  wear a series colour. */}
              <LabelList
                dataKey="price"
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
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-sm bg-chart-ours" />
        Toko kita
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-sm bg-chart-rival" />
        Kompetitor
      </span>
      <span>diurut dari termurah</span>
    </div>
  );
}

function SellerTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const seller = payload[0].payload as SellerDatum;

  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-foreground">
        {seller.label}
        {seller.ours ? ' · toko kita' : ''}
      </div>
      <div className="mt-1 text-muted">
        {MARKETPLACE_LABELS[seller.marketplace] ?? seller.marketplace}
      </div>
      <div className="mt-1 tabular-nums text-foreground">{formatPrice(seller.price)}</div>
      {seller.sold !== null ? (
        // Volume is what turns a lower price from a fact into a problem: nobody
        // needs to react to an undercut that is not selling.
        <div className="text-muted">{formatSold(seller.sold)} terjual</div>
      ) : null}
    </div>
  );
}
