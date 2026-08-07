import 'server-only';

import { sql } from '@/lib/db';

/**
 * How far the reader has got.
 *
 * The only stored state the notifications feature has. It does not filter the
 * list — `rivalMoves` renders its whole window regardless — it decides which of
 * those rows are styled new and what the bell counts. That distinction is the
 * reason this file is small: a marker that filtered would have to be right about
 * every row, and a marker that only styles has to be right about one number.
 *
 * **Ids, not timestamps.** `scraped_at` arrives out of order in this database
 * (`migrations/006_notify_seen.sql` says why), so a clock-based marker would
 * file a genuinely new row as already read. `price_snapshots.id` is bigserial,
 * which gives a total order nothing can disagree with.
 *
 * **Bigint, so a string, all the way through.** 9,007,199,254,740,991 is a long
 * way off, but the reason to keep these strings is not the ceiling — it is that
 * `Number()` here and `bigint` in Postgres would be two representations of one
 * value, and the comparison that matters happens in SQL. Nothing in this file
 * parses one.
 */

/**
 * What a missing row means, and why it is not a zero.
 *
 * `migrations/006_notify_seen.sql` seeds exactly one row, and `scraper/db.py`
 * applies that migration. So an empty table is not a database that has never
 * been read — it is a database the migration never reached, which is almost
 * always the wrong `DATABASE_URL`. Answering 0 would be indistinguishable from
 * a fresh install and would announce the entire history as unread.
 */
const MISSING_ROW =
  'notify_seen has no row. Apply migrations/006_notify_seen.sql to this database ' +
  '(`ecom-scraper initdb`).';

/**
 * Where the reader has got, clamped to what the database can actually show.
 *
 * The clamp is not defensive tidiness, it is the state after `scraper/sync.py`
 * mirrors into this database: `mirror` TRUNCATEs the target and copies ids
 * verbatim, so the target's `max(price_snapshots.id)` can land *below* a marker
 * left over from its own, now discarded, id space. `reseed_seen` corrects that
 * in the same run, but only when it runs — a target mirrored by an older build,
 * or a restore from a dump taken between the two statements, arrives here with a
 * marker pointing past the end of the table. Read literally that marks every row
 * as already seen and renders an empty list with nothing to explain it.
 *
 * `LEAST` against `max(id)` says the same thing the marker was trying to say —
 * "everything here is old news" — without the failure mode. An empty
 * `price_snapshots` gives 0, which is right for the same reason: there is
 * nothing above it to be unread.
 *
 * Read-only, deliberately. The stored marker is left where it is rather than
 * corrected in place, because this runs on every page load and a read that
 * writes is a read that can deadlock with the POST that advances it.
 */
export async function readSeen(): Promise<string> {
  const [row] = await sql<{ last_seen_snapshot_id: string }[]>`
    SELECT LEAST(
             s.last_seen_snapshot_id,
             COALESCE((SELECT max(id) FROM price_snapshots), 0)
           ) AS last_seen_snapshot_id
      FROM notify_seen s
     WHERE s.id = 1`;

  if (!row) throw new Error(MISSING_ROW);
  return String(row.last_seen_snapshot_id);
}

/**
 * Move the marker forward, and answer with where it now stands.
 *
 * `GREATEST`, not assignment: two tabs posting at once, or a stale request
 * arriving late, must never move the marker backwards and re-mark rows unread.
 * The whole guarantee is in that one function — it makes the write idempotent
 * and order-independent, so no lock and no read-modify-write is needed around
 * it.
 *
 * It returns the resulting marker rather than the id it was handed, because
 * those differ in exactly the case the `GREATEST` exists for, and the caller
 * writes this value into its response.
 */
export async function advanceSeen(to: string): Promise<string> {
  const [row] = await sql<{ last_seen_snapshot_id: string }[]>`
    UPDATE notify_seen
       SET last_seen_snapshot_id = GREATEST(last_seen_snapshot_id, ${to}::bigint),
           updated_at = now()
     WHERE id = 1
 RETURNING last_seen_snapshot_id`;

  // An UPDATE matching nothing is not an error to Postgres, so this is the only
  // thing standing between a missing row and a silent no-op that answers 200.
  if (!row) throw new Error(MISSING_ROW);
  return String(row.last_seen_snapshot_id);
}
