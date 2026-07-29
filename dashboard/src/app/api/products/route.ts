import type { NextRequest } from 'next/server';

import { getProducts } from '@/lib/queries';
import { productFilterSchema } from '@/lib/schemas';

/**
 * The product table's data source.
 *
 * `force-dynamic` because the response depends entirely on the query string and
 * on live Postgres state. It also guarantees `next build` never opens a database
 * connection, which matters here: Postgres is not always running during
 * development, and a build that tries to prerender this would fail for a reason
 * that has nothing to do with the code being built.
 */
export const dynamic = 'force-dynamic';

/**
 * Snapshots only change when the user runs a scrape, so a stale list is not a
 * wrong list — it is the same list. Serving it from cache turns repeated sort and
 * filter toggles into instant paints, and `stale-while-revalidate` keeps the
 * refresh off the critical path. `private` because this is a single-user
 * dashboard reading a local database; no shared cache should ever hold it.
 */
const CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=300';

export async function GET(request: NextRequest) {
  try {
    // Cannot throw. Every field in the schema carries `.catch()`, so a stale
    // bookmarked filter — a store that no longer exists, a sort key that was
    // renamed — degrades to that field's default and still renders a page.
    const filter = productFilterSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );

    const { rows, total } = await getProducts(filter);

    // Echoing page/pageSize from the parsed filter rather than the raw query
    // string means the client is told the page it actually got, not the one it
    // asked for, after `.catch()` has clamped anything out of range.
    return Response.json(
      { rows, total, page: filter.page, pageSize: filter.pageSize },
      { headers: { 'Cache-Control': CACHE_CONTROL } },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          'Tidak bisa memuat produk. Pastikan Postgres sedang berjalan, lalu coba lagi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
