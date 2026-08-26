import { withSession } from '@/lib/api-session';
import { getStoresForExport } from '@/lib/queries';
import { formatStoresFile, STORES_FILE_NAME } from '@/lib/stores-export';

/**
 * Download the shops in the database as a `config/stores.txt` draft.
 *
 * The half-manual half of a half-manual list: the database proposes, the file
 * decides. Nothing here writes to `config/stores.txt` — the dashboard is
 * deployed and the file lives in someone's checkout, and a sweep that grew
 * itself every time a scrape met a new seller is exactly what the file exists to
 * prevent.
 *
 * `text/plain` with a filename, not JSON: what the user needs is a file on disk
 * with that name, and every step between the click and that file is a step that
 * can go wrong.
 */

/** See `api/stores/route.ts` — the query reads a live database. */
export const dynamic = 'force-dynamic';

export const GET = withSession(async () => {
  try {
    const rows = await getStoresForExport();
    const body = formatStoresFile(rows, { exportedAt: new Date() });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${STORES_FILE_NAME}"`,
        // A draft of a mutable table. Handing back a cached copy would quietly
        // export shops that were current an hour ago.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          'Tidak bisa menyusun daftar toko. Pastikan Postgres sedang berjalan, lalu coba lagi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
});
