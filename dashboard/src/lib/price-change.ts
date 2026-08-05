/**
 * What a price is compared against, and how old that comparison has to be.
 *
 * Not "the snapshot before this one". In this database adjacent captures
 * disagree about price without anything having been repriced: 37 of 38 pairs
 * taken 1.5-3.5 hours apart differ, against 3 of 1,335 taken a day apart, and
 * `sold` is byte-identical across the near pairs — which no genuinely repriced
 * listing would be. A marker driven by the immediate predecessor would light up
 * most of the table with artefacts and mean nothing.
 *
 * So both the notifier and the product list compare against *the newest
 * snapshot at least this many hours older*, and they read the same setting to
 * decide how many. That is the whole reason this lives in its own module rather
 * than in `notify/run.ts`: `lib/queries.ts` cannot import from there without a
 * cycle (`notify/positions.ts` already imports `queries.ts`), and a second copy
 * of the number is how the badge in the table and the message on the phone would
 * come to disagree about what counts as a price change.
 */

/**
 * Hours a comparison snapshot must predate the current one by.
 *
 * Twelve, so a comparison spans at least half a day. `NOTIFY_MIN_GAP_HOURS=0`
 * turns the rule off and compares against the immediately preceding snapshot,
 * which is documented as a way to see the artefacts for yourself.
 */
export const DEFAULT_MIN_GAP_HOURS = 12;

/**
 * Read the gap out of the environment.
 *
 * Fractions and anything unparseable fall back to the default rather than
 * rounding: `make_interval(hours => 1.5)` would be accepted by Postgres, but a
 * setting that silently means something other than what was typed is worse than
 * one that visibly ignores it. Zero is a real value and passes through.
 *
 * @param env Environment to read. Defaults to `process.env`.
 * @returns A whole, non-negative number of hours.
 */
export function resolveMinGapHours(
  // `Record`, not `{ NOTIFY_MIN_GAP_HOURS?: string }`: TypeScript's weak-type
  // check refuses to assign `process.env` to an all-optional type it shares no
  // declared property with — the same trap `NotifyEnv` documents in
  // `notify/run.ts`. An index signature has no such problem, and `NotifyEnv`
  // (a type alias, so it gains an implicit index signature) still passes here.
  env: Record<string, string | undefined> = process.env,
): number {
  const text = env.NOTIFY_MIN_GAP_HOURS?.trim();
  if (!text) return DEFAULT_MIN_GAP_HOURS;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIN_GAP_HOURS;
}
