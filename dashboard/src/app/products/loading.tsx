import { Skeleton } from '@/components/ui';

/**
 * Overrides the root fallback with this route's actual shape — a filter card
 * over a table — because /products is the page users return to most and a
 * fallback that matches what lands does not jump when it does. The two heights
 * are the same ones `products/page.tsx` already uses for its Suspense
 * boundaries.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Memuat produk…</span>

      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
