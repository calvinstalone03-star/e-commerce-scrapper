import type { NextRequest } from 'next/server';

import { getKeywords } from '@/lib/queries';
import { marketplaceSchema } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=300';

/**
 * An unknown marketplace is treated as "no filter" rather than as an error, so
 * this route degrades the same way the product and store filters do. Returning
 * 400 here would mean a link to `?marketplace=lazada` breaks the page instead of
 * showing every keyword.
 */
const marketplaceParamSchema = marketplaceSchema.optional().catch(undefined);

export async function GET(request: NextRequest) {
  try {
    const marketplace = marketplaceParamSchema.parse(
      request.nextUrl.searchParams.get('marketplace') ?? undefined,
    );

    // Not paginated: keyword capture was added late, so this list is tiny and a
    // page envelope would only add a shape the client has to unwrap for nothing.
    const keywords = await getKeywords(marketplace);

    return Response.json(keywords, {
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          'Tidak bisa memuat kata kunci. Pastikan Postgres sedang berjalan, lalu coba lagi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
