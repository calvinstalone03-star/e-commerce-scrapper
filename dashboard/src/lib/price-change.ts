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
 * So every screen that reports a price change compares against *the newest
 * snapshot at least some hours older*. The product table's movement badge takes
 * that floor from here; `/notifications` applies the same rule against a wider
 * floor of its own — `DEFAULT_WINDOW.gapHours` in `notify/rival-moves.ts`, 24, a
 * literal rather than a reading of this setting, because that window is also
 * what the read marker advances over and moving it from the environment would
 * move what "already read" means.
 *
 * Its own module because the badge is assembled in two places that must agree:
 * `queries.ts` measures it in SQL (`make_interval(hours => …)`), and
 * `ProductTable.tsx` prints the caption that tells the reader what was measured
 * ("dibanding snapshot ≥N jam sebelumnya"), taking N through
 * `products/page.tsx`. A second copy of the number is how a badge would come to
 * describe itself wrongly. Being a plain module with no database and no
 * `server-only` import is also what lets `product-movement.test.ts` cover the
 * parsing directly.
 */

/**
 * Hours a comparison snapshot must predate the current one by.
 *
 * Twelve, so a comparison spans at least half a day. `NOTIFY_MIN_GAP_HOURS=0`
 * turns the rule off and compares against the immediately preceding snapshot,
 * which is documented as a way to see the artefacts for yourself.
 *
 * The variable keeps the `NOTIFY_` prefix of the notifier that first needed it,
 * which is now deleted. Renaming it would mean editing the environment of a
 * running deployment to buy nothing, so the name stays and this note explains
 * it.
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
  // check fires when every property of a target type is optional, and it
  // compares only the properties *declared* on `ProcessEnv`, ignoring its index
  // signature — so the narrow, more descriptive shape would refuse
  // `process.env` at every call site and force a cast there instead. An index
  // signature has no such problem, and a test may still pass a plain object
  // literal.
  env: Record<string, string | undefined> = process.env,
): number {
  const text = env.NOTIFY_MIN_GAP_HOURS?.trim();
  if (!text) return DEFAULT_MIN_GAP_HOURS;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIN_GAP_HOURS;
}
