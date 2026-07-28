import type {
  HTMLAttributes,
  Ref,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

import { cn } from './cn';

type TableProps = TableHTMLAttributes<HTMLTableElement> & {
  /**
   * Height of the scrollport. `'none'` lets the table grow with the page.
   *
   * A prop rather than a class because `position: sticky` on the header resolves
   * against the nearest scroll container: with no height cap the container never
   * scrolls vertically and the sticky header is inert. Capping it is what makes
   * the header actually stick on a 50-row page.
   */
  maxHeight?: string | number;
  /** Classes for the scroll container rather than the `<table>` itself. */
  containerClassName?: string;
  /**
   * The scrollport, not the `<table>`. A caller that pages the rows needs to
   * reset scroll on page change, and the element that scrolls is this wrapper —
   * a ref on the table itself would point at something that never scrolls.
   */
  containerRef?: Ref<HTMLDivElement>;
};

/**
 * Table plus its scroll container.
 *
 * `overflow-auto` on the wrapper is the point: a wide table scrolls inside
 * itself instead of pushing the whole document sideways, which on a dashboard
 * would move the nav and every other card off-screen too.
 *
 * `border-separate` rather than the usual collapsed borders — collapsed borders
 * belong to the table, not the cell, so they scroll out from under a sticky
 * header and leave it with no bottom edge.
 */
export function Table({
  className,
  maxHeight = '70vh',
  containerClassName,
  containerRef,
  ...props
}: TableProps) {
  return (
    <div
      ref={containerRef}
      className={cn(
        'scrollbar-slim relative w-full overflow-auto overscroll-x-contain rounded-lg border border-line bg-surface',
        containerClassName,
      )}
      style={{ maxHeight }}
    >
      <table
        className={cn('w-full border-separate border-spacing-0 text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('sticky top-0 z-10', className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        '[&_tr:hover]:bg-surface-muted [&_tr:last-child_td]:border-b-0',
        className,
      )}
      {...props}
    />
  );
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors', className)} {...props} />;
}

type CellProps = {
  /** Right-aligns and locks digit width so a price column reads as a column. */
  numeric?: boolean;
};

export function TH({
  className,
  numeric,
  scope = 'col',
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      scope={scope}
      className={cn(
        'border-b border-line bg-surface-muted px-3 py-2.5 text-left align-middle text-xs font-medium whitespace-nowrap text-muted',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <td
      className={cn(
        'border-b border-line px-3 py-2.5 align-middle',
        numeric && 'text-right tabular-nums',
        className,
      )}
      {...props}
    />
  );
}
