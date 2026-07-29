import { Skeleton } from '@/components/ui';

/**
 * The shell every route below falls back to while its server render runs.
 *
 * Two jobs, and the second is the one that matters. It paints something the
 * instant a link is clicked — every page here queries Postgres at request time,
 * so without a fallback the browser sits on the fully-interactive previous page
 * and the click looks ignored. And because `<Link>` prefetches a dynamic route
 * only as far as its nearest loading boundary, having none meant these routes
 * were not prefetched at all; this file is what gives hover-prefetch something
 * to fetch.
 *
 * The shapes are deliberately generic — a header, a row of stat cards, a table.
 * Every page in this app is some arrangement of those, and a fallback that
 * guesses the exact layout wrong jumps more than one that stays approximate.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Memuat halaman…</span>

      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>

      <Skeleton className="h-96 w-full" />
    </div>
  );
}
