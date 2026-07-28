'use client';

import { cn } from './cn';
import { Select } from './Input';

const count = new Intl.NumberFormat('id-ID');

const BUTTON =
  'inline-flex h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium ' +
  'transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-surface';

type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to render a fixed page size with no control. */
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  className?: string;
};

/**
 * Page controls, driven entirely by props.
 *
 * Callback-based rather than link-based because the list views keep their filter
 * state in the URL on the client: a page link would have to re-encode every
 * active filter, and the one place that knows all of them is the caller holding
 * the filter object.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(page, 1), totalPages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 text-sm text-muted',
        className,
      )}
    >
      <p aria-live="polite">
        {total === 0 ? (
          'Tidak ada baris'
        ) : (
          <>
            <span className="font-medium text-foreground tabular-nums">
              {count.format(from)}–{count.format(to)}
            </span>{' '}
            dari <span className="tabular-nums">{count.format(total)}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange ? (
          <label className="flex items-center gap-2 whitespace-nowrap">
            <span>Baris</span>
            <Select
              className="h-9 w-auto"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        <nav aria-label="Navigasi halaman" className="flex items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            onClick={() => onPageChange(current - 1)}
            disabled={current <= 1}
          >
            Sebelumnya
          </button>
          <span className="whitespace-nowrap tabular-nums">
            {count.format(current)} / {count.format(totalPages)}
          </span>
          <button
            type="button"
            className={BUTTON}
            onClick={() => onPageChange(current + 1)}
            disabled={current >= totalPages}
          >
            Berikutnya
          </button>
        </nav>
      </div>
    </div>
  );
}
