// `import type`, deliberately: rival-moves.ts imports `server-only` at its top,
// and a value import would pull that into this module's runtime graph. This file
// is pure and stays that way — the type is erased at compile time, so nothing is
// imported at all, and a client component can render what this returns.
import type { RivalMove } from '@/lib/notify/rival-moves';

/**
 * Repeats, folded into the decision behind them.
 *
 * `rivalMoves` deliberately returns one row per qualifying snapshot rather than
 * one per product — its own header says why, and the short version is that
 * collapsing in SQL buried real events. The cost of that choice is paid here: a
 * shop that repriced its whole catalogue in one go arrives as 33 rows that each
 * say the same thing, and printed in full they bury everything else on the page.
 * Folding is where the repetition is answered, and it is reversible in a way the
 * SQL was not — every folded entry still carries its members.
 *
 * Pure: no database, no clock, no network. Everything that varies arrives as an
 * argument.
 *
 * What stayed behind in `format.ts` is everything that sized a Telegram
 * message — `MAX_ENTRIES_PER_GROUP`, `MAX_MESSAGES`, `escapeHtml`, and every
 * `render*`. A page has no 4,096-character limit and no 20-messages-a-minute
 * ceiling, so a cap on how many entries it prints would be a rule with no reason
 * behind it.
 */

/** Below this, listings that moved by the same amount are a coincidence. */
export const FOLD_MIN_GROUP = 3;

export type FoldedGroup =
  | {
      kind: 'folded';
      username: string | null;
      marketplace: string;
      /** The move every member made, in rupiah, signed. */
      delta: number;
      members: RivalMove[];
    }
  | { kind: 'single'; move: RivalMove };

/**
 * The move in rupiah, signed.
 *
 * `Number()` on a NUMERIC string is the one place this feature parses money, and
 * it is safe here for the reason it would not be in the query: these are
 * whole-rupiah prices in the millions, far inside the exactly-representable
 * range, and the result is used to group and to order rather than to be stored
 * or compared for equality against Postgres.
 */
function delta(move: RivalMove): number {
  return Number(move.price) - Number(move.previousPrice);
}

/**
 * How far a price moved, as a fraction of where it started.
 *
 * Both branches of the ordering below run through it — a folded group is
 * weighed by the move it stands for, a lone row by its own — so a folded entry
 * cannot rank differently from the identical single row it would have been one
 * member short of.
 *
 * A previous price of zero is not an infinite rise, it is a listing whose old
 * price was never real. Dividing by it gives Infinity, which would put that row
 * at the head of the page ahead of every genuine reprice. It ranks as no
 * movement instead — last, where it is still readable but costs nothing that a
 * real move wanted.
 */
function magnitude(move: RivalMove): number {
  const from = Number(move.previousPrice);
  if (from === 0) return 0;
  return Math.abs(delta(move) / from);
}

/**
 * Collapse a store's simultaneous identical moves into one entry.
 *
 * A shop that repriced its whole catalogue made one decision, and printing it as
 * 33 rows that each say the same thing buries everything else. Keyed on store
 * **and signed delta**, so a rise never folds into a fall of the same size: they
 * are opposite decisions, and a group that mixed them could not state its own
 * delta without lying about half its members.
 *
 * A store id of null is keyed as the literal `'null'` rather than dropped. Those
 * are listings whose shop was never resolved; they can still be folded against
 * each other, and the alternative — one key per row — would only mean they never
 * fold at all.
 */
export function foldRivalMoves(moves: RivalMove[]): FoldedGroup[] {
  const groups = new Map<string, RivalMove[]>();
  for (const move of moves) {
    const key = `${move.storeId ?? 'null'}|${delta(move)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(move);
    else groups.set(key, [move]);
  }

  const folded: FoldedGroup[] = [];
  for (const members of groups.values()) {
    if (members.length >= FOLD_MIN_GROUP) {
      folded.push({
        kind: 'folded',
        username: members[0].username,
        marketplace: members[0].marketplace,
        delta: delta(members[0]),
        members,
      });
    } else {
      for (const move of members) folded.push({ kind: 'single', move });
    }
  }

  // Biggest proportional move first, whether folded or not: a listing that moved
  // 66,7% deserves to be read before one that moved 1,3%.
  const weight = (entry: FoldedGroup): number =>
    magnitude(entry.kind === 'folded' ? entry.members[0] : entry.move);

  return folded.sort((left, right) => weight(right) - weight(left));
}
