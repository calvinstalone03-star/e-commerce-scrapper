import type { NextRequest } from 'next/server';

import { withSession } from '@/lib/api-session';
import { getStores } from '@/lib/queries';
import { storeFilterSchema } from '@/lib/schemas';

/** See `api/products/route.ts` — same reasoning: query-string dependent, and it
 *  keeps the production build from needing a live database. */
export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=300';

/** Behind the login — see `lib/api-session.ts`. */
export const GET = withSession(async (request: NextRequest) => {
  try {
    // `.catch()` per field, so an unknown sort or a negative page renders the
    // default view instead of returning 400 to a bookmarked URL.
    const filter = storeFilterSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );

    const { rows, total } = await getStores(filter);

    return Response.json(
      { rows, total, page: filter.page, pageSize: filter.pageSize },
      { headers: { 'Cache-Control': CACHE_CONTROL } },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          'Tidak bisa memuat toko. Pastikan Postgres sedang berjalan, lalu coba lagi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
});
