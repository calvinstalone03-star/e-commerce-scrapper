import { z } from 'zod';

import { withSession } from '@/lib/api-session';
import { getPriceHistory } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=300';

/**
 * `products.id` is a Postgres `int4`. Bounding the segment here turns a hand-typed
 * or overflowing URL into a 400 that names the problem, instead of letting
 * Postgres raise an out-of-range error that would surface as a misleading 503.
 * Coercion also rejects `1.5`, `-1`, `abc` and `1e999`.
 */
const productIdSchema = z.coerce.number().int().positive().max(2_147_483_647);

/** Behind the login — see `lib/api-session.ts`. */
export const GET = withSession(
  async (_request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const { id } = await params;

      const parsed = productIdSchema.safeParse(id);
      if (!parsed.success) {
        return Response.json({ error: `ID produk tidak valid: "${id}".` }, { status: 400 });
      }

      // Usually a single point today — every product has exactly one snapshot until
      // the same page is scraped on a second day. That is the client's empty state
      // to explain, not an error: an empty or one-element array is a valid answer,
      // so this deliberately does not 404 on a short history.
      const history = await getPriceHistory(parsed.data);

      return Response.json(history, {
        headers: { 'Cache-Control': CACHE_CONTROL },
      });
    } catch (error) {
      return Response.json(
        {
          error:
            'Tidak bisa memuat riwayat harga. Pastikan Postgres sedang berjalan, lalu coba lagi.',
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }
  },
);
