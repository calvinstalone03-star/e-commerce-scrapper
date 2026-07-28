import type { HTMLAttributes } from 'react';

import { cn } from './cn';

/**
 * Loading placeholder. Carries no size of its own — the caller sets one that
 * matches the element being replaced, so the layout does not jump when real
 * content lands.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-surface-muted', className)}
      {...props}
    />
  );
}
