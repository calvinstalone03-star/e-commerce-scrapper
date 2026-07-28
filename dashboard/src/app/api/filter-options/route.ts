import { getFilterOptions } from '@/lib/queries';

/**
 * Distinct values for the filter controls.
 *
 * No search params, but still dynamic: the options are derived from table
 * contents that change on every scrape, and prerendering them at build time
 * would both bake in a stale dropdown and make `next build` require a running
 * Postgres.
 */
export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=300';

export async function GET() {
  try {
    const options = await getFilterOptions();

    return Response.json(options, {
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          'Tidak bisa memuat pilihan filter. Pastikan Postgres sedang berjalan, lalu coba lagi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
