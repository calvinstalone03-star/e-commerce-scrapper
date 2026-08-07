import { withSession } from '@/lib/api-session';
import { DEFAULT_WINDOW, rivalMovesCeiling } from '@/lib/notify/rival-moves';
import { advanceSeen, readSeen } from '@/lib/notify/seen';

/**
 * "I have looked at the notifications page."
 *
 * The whole route is one decision — what id the marker moves to — and the
 * decision is made **here**, not by the caller. The body is ignored entirely.
 *
 * That is the defect being designed out rather than a preference. The obvious
 * design has the page post the largest id it rendered, so that a row arriving
 * mid-read is not marked read. Measured against the hosted database: 56
 * qualifying events, a top-20 cap, and all 36 rows that did not make the page
 * had ids **below** the largest one shown — not most of them, all of them.
 * Re-ordering newest-first gives the same maximum, so this is not a quirk of
 * ordering by magnitude: the feed is ordered by consequence, never by id, so
 * "what was shown" is not a prefix of id order and any cap over any such
 * ordering strands rows. The marker only moves forward and there is no per-item
 * state, so a stranded row needs hand-written SQL to come back.
 *
 * `rivalMovesCeiling` answers over the complete window — no limit, no offset, no
 * user filter — and that is only safe because the page renders the complete
 * window too. Nothing is hidden behind the marker for it to skip; the marker
 * decides styling, never membership.
 *
 * **POST, and no GET.** Next answers 405 for a method a route module does not
 * export, which is the enforcement. A GET here would fire on a link prefetch and
 * on React's double render in development — the badge would clear itself before
 * anyone had read anything, and there would be no record that it had.
 */

export const dynamic = 'force-dynamic';

/** A mutation and a per-session answer. Neither may be replayed from a cache. */
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export const POST = withSession(async () => {
  try {
    const ceiling = await rivalMovesCeiling(DEFAULT_WINDOW);

    // `null` is "nothing in the window qualifies", which is not the same as
    // zero. Leaving the marker alone is the only correct move: writing 0 would
    // rewind it and re-announce the whole history on the next load.
    //
    // `readSeen` is the clamped value rather than the stored one, deliberately.
    // The client uses this answer to clear its badge, and after a destructive
    // mirror the stored marker can sit above `max(price_snapshots.id)` — handing
    // that number back would be handing back an id no row can ever reach.
    const lastSeenSnapshotId =
      ceiling === null ? (await readSeen()).id : await advanceSeen(ceiling);

    return Response.json({ lastSeenSnapshotId }, { headers: NO_STORE });
  } catch (error) {
    // The one error worth distinguishing is a missing `notify_seen` row, which
    // `seen.ts` raises by name: it means migration 006 never reached this
    // database, so the marker cannot be advanced and the badge would otherwise
    // come back on the next load with nothing anywhere to explain it. 503 rather
    // than 500 — the request is fine, the database is not ready for it.
    return Response.json(
      {
        error: 'Tidak bisa menandai notifikasi terbaca. Pastikan database bisa dihubungi.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: NO_STORE },
    );
  }
});
