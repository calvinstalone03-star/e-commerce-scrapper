import type { HTMLAttributes } from 'react';

import { cn } from './cn';

export type BadgeVariant = 'default' | 'shopee' | 'tokopedia' | 'muted';

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'border-accent/25 bg-accent/10 text-accent',
  shopee: 'border-shopee/25 bg-shopee/10 text-shopee',
  tokopedia: 'border-tokopedia/25 bg-tokopedia/10 text-tokopedia',
  muted: 'border-line bg-surface-muted text-muted',
};

export function Badge({
  className,
  variant = 'default',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
