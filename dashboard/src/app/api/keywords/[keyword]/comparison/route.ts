import { getKeywordComparison } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=300';

/** Matches the 200-char ceiling `productFilterSchema.keyword` already enforces. */
const MAX_KEYWORD_LENGTH = 200;

/**
 * Next.js percent-decodes dynamic segments before handing them over, so
 * `/api/keywords/mainan%20anak/comparison` already arrives as `mainan anak`.
 * This second pass only rescues a double-encoded value from a client that ran
 * `encodeURIComponent` twice.
 *
 * The try/catch is the point: `decodeURIComponent` throws a URIError on a lone
 * `%` that is not an escape sequence, and marketplace keywords like `diskon 50%`
 * are entirely plausible. A failed decode keeps the value Next.js gave us, which
 * was already correct.
 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ keyword: string }> },
) {
  try {
    const { keyword: rawKeyword } = await params;
    const keyword = decodeSegment(rawKeyword).trim();

    if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH) {
      return Response.json(
        { error: `Kata kunci tidak valid: "${rawKeyword}".` },
        { status: 400 },
      );
    }

    // A keyword nobody has scraped yet yields an empty array rather than a 404 —
    // "no competitor data for this term" is a result the comparison view can
    // render, and only two keywords exist so far, so it is the common case.
    const comparison = await getKeywordComparison(keyword);

    return Response.json(comparison, {
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          'Tidak bisa memuat perbandingan harga. Pastikan Postgres sedang berjalan, lalu coba lagi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
