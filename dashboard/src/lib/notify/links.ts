import { CHANNEL_PARAM } from '@/lib/channel';
// `import type`, deliberately: rival-moves.ts imports `server-only` at its top,
// and a value import would pull that into this module's runtime graph. This file
// is pure and stays that way — the type is erased at compile time, so nothing is
// imported at all.
import type { RivalMove } from '@/lib/notify/rival-moves';

/**
 * Where a row on the notifications page points.
 *
 * There is no uniform answer, because `/pricing/[id]` is scoped to our own
 * shops: `getPricePositionDetail` joins `AND s.is_own` (queries.ts:769) and a
 * rival's id 404s at `pricing/[id]/page.tsx:61`. Every row this feature renders
 * is a rival by construction — `rivalMoves` selects `WHERE NOT s.is_own` — so
 * the rival paths are not the fallback, they are the whole of it.
 *
 * For a rival the useful destination is not their listing but ours: when a
 * competitor moves, the question is where that leaves us. `/pricing` searches
 * `set_code` by prefix (queries.ts:409), so a set number lands on exactly that
 * comparison.
 *
 * **A path, never an absolute URL.** Every link this builds is followed by an
 * in-app `<Link>`, where an absolute URL would leave the client router and
 * reload the page. The Telegram digest this was ported from needed the
 * opposite — `https://…`, because a message is read outside the app — and it
 * carried a base URL, an environment-variable fallback chain and a join helper
 * to produce one. Those were deleted with it, so there is no absolute form of
 * this function left to reach for by mistake.
 *
 * No `server-only` and no database access — pure string work, so the choices
 * here are testable without a Postgres.
 */

/**
 * What a link needs from a move, and nothing else.
 *
 * Derived from `RivalMove` rather than restated, so a rename on the query side
 * breaks this file rather than silently making it read a field that no longer
 * exists. Narrowed to three fields because that is genuinely all a destination
 * depends on: the price, the marker id and our own price decide what a row
 * *says*, never where it goes.
 */
type Linkable = Pick<RivalMove, 'setCode' | 'marketplace' | 'name'>;

export function priceChangeLink(move: Linkable): string {
  // A rival with a set number: our position on that set.
  if (move.setCode) {
    const params = new URLSearchParams({ [CHANNEL_PARAM]: move.marketplace, q: move.setCode });
    return `/pricing?${params.toString()}`;
  }

  // Accessories, bundles and knock-offs carry no set number, and `/pricing` has
  // nothing to match them on. `/products` searches names and spans both
  // marketplaces.
  if (move.name) {
    return `/products?${new URLSearchParams({ q: searchableName(move.name) }).toString()}`;
  }

  return '/products';
}

/**
 * The longest name `/products?q=` will actually accept.
 *
 * `productFilterSchema.q` is `.max(200).catch(undefined)` (schemas.ts:269), and
 * that `catch` is the problem: a longer name does not fail the request, it
 * discards the filter and lands the reader on the unfiltered list — 17,451 rows
 * for a link whose whole job was to name one of them. Marketplace listing titles
 * run long enough for this to be ordinary rather than exotic.
 *
 * 180 rather than 200 leaves room for the trim the schema applies before it
 * measures, and a prefix is a perfectly good search: `/products` matches names
 * by substring, so the first 180 characters still find the listing.
 */
const MAX_QUERY_NAME = 180;

function searchableName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= MAX_QUERY_NAME) return trimmed;

  const cut = trimmed.slice(0, MAX_QUERY_NAME);
  // Slicing counts UTF-16 units, so a cut can land between the halves of an
  // emoji and leave a lone surrogate, which percent-encodes as U+FFFD and
  // matches nothing. Drop the orphan instead.
  const last = cut.charCodeAt(cut.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return whole.trimEnd();
}
