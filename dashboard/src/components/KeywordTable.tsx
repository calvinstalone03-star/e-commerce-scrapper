import Link from 'next/link';

import { Badge, TBody, TD, TH, THead, TR, Table } from '@/components/ui';
import { MARKETPLACE_LABELS, formatPrice } from '@/lib/format';
import { toSearchParams, type KeywordRow } from '@/lib/schemas';

/**
 * The keyword list.
 *
 * A Server Component: nothing here reacts to input, so shipping a table to the
 * browser would buy nothing. Row actions are links, which also means they open
 * in a new tab and survive without JavaScript.
 */

const count = new Intl.NumberFormat('id-ID');

/**
 * Prices travel as NUMERIC strings so no float rounding creeps in. A bar needs
 * pixels, so the conversion happens here and only ever feeds geometry — every
 * number the reader actually sees still goes through `format.ts`.
 */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

type Scale = { min: number; max: number; span: number };

/** One axis shared by every row, so two bars are comparable at a glance. */
function priceScale(rows: KeywordRow[]): Scale | null {
  const lows = rows.map((row) => toNumber(row.minPrice)).filter((value) => value !== null);
  const highs = rows.map((row) => toNumber(row.maxPrice)).filter((value) => value !== null);
  if (lows.length === 0 || highs.length === 0) return null;
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  return { min, max, span: max - min };
}

function PriceRangeBar({ row, scale }: { row: KeywordRow; scale: Scale }) {
  const min = toNumber(row.minPrice);
  const max = toNumber(row.maxPrice);
  const avg = toNumber(row.avgPrice);

  if (min === null || max === null) {
    return <span className="text-muted">–</span>;
  }

  // Two degenerate cases, both real today. A keyword whose products all cost the
  // same has a zero-width span, and a scale whose ends meet has no width at all
  // to place it on — drawing either as a full-width bar would invent a spread
  // that was never measured, so both collapse to a marker instead.
  const position = (value: number) =>
    scale.span === 0 ? 50 : ((value - scale.min) / scale.span) * 100;
  const flat = max === min;

  return (
    <div className="w-44">
      <div className="relative h-1.5 rounded-full bg-surface-muted" aria-hidden>
        {flat ? (
          <span
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
            style={{ left: `${position(min)}%` }}
          />
        ) : (
          <>
            <span
              className="absolute inset-y-0 rounded-full bg-accent"
              style={{
                left: `${position(min)}%`,
                width: `${Math.max(position(max) - position(min), 2)}%`,
              }}
            />
            {avg === null ? null : (
              <span
                className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
                style={{ left: `${position(avg)}%` }}
              />
            )}
          </>
        )}
      </div>

      <p className="mt-1.5 text-xs tabular-nums text-muted">
        {flat
          ? `${formatPrice(row.minPrice)} · harga tunggal`
          : `${formatPrice(row.minPrice)} – ${formatPrice(row.maxPrice)}`}
      </p>
    </div>
  );
}

export function KeywordTable({ rows }: { rows: KeywordRow[] }) {
  const scale = priceScale(rows);

  return (
    <div className="space-y-3">
      {/* Default height cap, not `none`: the wrapper is the scroll container the
          sticky header resolves against, and an uncapped one never scrolls, so
          the header would ride off with the page on a long keyword list. */}
      <Table>
        <caption className="sr-only">
          Kata kunci pencarian dengan jumlah produk, jumlah toko dan rentang harganya
        </caption>
        <THead>
          <TR>
            <TH>Kata kunci</TH>
            <TH>Marketplace</TH>
            <TH numeric>Produk</TH>
            <TH numeric>Toko</TH>
            <TH>Rentang harga</TH>
            <TH numeric>Rata-rata</TH>
            <TH numeric>Aksi</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            const comparePath = `/compare?${toSearchParams({ keyword: row.keyword })}`;
            const productsPath = `/products?${toSearchParams({ keyword: row.keyword })}`;

            return (
              <TR key={`${row.marketplace}:${row.keyword}`}>
                <TD>
                  <Link
                    href={comparePath}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {row.keyword}
                  </Link>
                </TD>
                <TD>
                  <Badge variant={row.marketplace}>
                    {MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace}
                  </Badge>
                </TD>
                <TD numeric>{count.format(row.products)}</TD>
                <TD numeric>{count.format(row.stores)}</TD>
                <TD>
                  {scale ? (
                    <PriceRangeBar row={row} scale={scale} />
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </TD>
                <TD numeric className="font-medium">
                  {formatPrice(row.avgPrice)}
                </TD>
                <TD numeric>
                  <div className="flex justify-end gap-3 whitespace-nowrap">
                    <Link
                      href={comparePath}
                      className="text-accent underline-offset-4 hover:underline"
                    >
                      Bandingkan
                    </Link>
                    <Link
                      href={productsPath}
                      className="text-muted underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Produk
                    </Link>
                  </div>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      {scale ? (
        <p className="text-xs leading-relaxed text-muted">
          {scale.span === 0
            ? `Semua kata kunci berada di harga yang sama (${formatPrice(scale.min)}), jadi penandanya diletakkan di tengah skala.`
            : `Bar memakai satu skala bersama, ${formatPrice(scale.min)} – ${formatPrice(scale.max)}, yaitu harga terendah dan tertinggi di seluruh kata kunci. Garis tegak menandai rata-rata.`}
        </p>
      ) : null}
    </div>
  );
}
