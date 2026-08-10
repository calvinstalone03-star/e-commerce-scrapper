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
 * Folding is all this does. The Telegram digest this was ported from also
 * capped how many entries a group printed and how many messages a run could
 * send, and escaped every string it emitted into HTML; none of that came with
 * it. A page has no 4,096-character limit and no 20-messages-a-minute ceiling,
 * so a cap on how many entries it prints would be a rule with no reason behind
 * it, and React escapes what it renders.
 */

/** Below this, listings that moved by the same amount are a coincidence. */
export const FOLD_MOVE_MIN_GROUP = 3;

// Named `FoldedMoveGroup`, not `FoldedGroup`, and `foldRivalMoves`, not
// `foldPriceChanges`: `format.ts` exported both of those names with an
// incompatible shape (`change`, not `move`) for as long as the two features
// coexisted, and two same-named exports with different types in one directory
// is a trap a bare type import falls into silently — the type is what shows up
// in component props, not the function that produced it. `format.ts` is gone,
// so the collision is too; the distinct names stay because they are the more
// accurate ones for what this file returns.
export type FoldedMoveGroup =
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
export function foldRivalMoves(moves: RivalMove[]): FoldedMoveGroup[] {
  const groups = new Map<string, RivalMove[]>();
  for (const move of moves) {
    const key = `${move.storeId ?? 'null'}|${delta(move)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(move);
    else groups.set(key, [move]);
  }

  const folded: FoldedMoveGroup[] = [];
  for (const members of groups.values()) {
    if (members.length >= FOLD_MOVE_MIN_GROUP) {
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
  const weight = (entry: FoldedMoveGroup): number =>
    magnitude(entry.kind === 'folded' ? entry.members[0] : entry.move);

  return folded.sort((left, right) => weight(right) - weight(left));
}

/** The undercut state a group stands for; `null` where we have no price. */
export function groupUndercutsUs(entry: FoldedMoveGroup): boolean | null {
  return entry.kind === 'folded' ? entry.members[0].undercutsUs : entry.move.undercutsUs;
}

/**
 * Fold, without throwing away the reason the rows were in that order.
 *
 * `rivalMoves` orders by `undercutsUs DESC NULLS LAST` **first** and magnitude
 * second, because a rival dropping below our price is the event that demands a
 * decision and a big move on a set we are still comfortably winning is not.
 * `foldRivalMoves` re-sorts by magnitude alone, and a fold applied to the query's
 * output therefore discards that primary key: a 40% cut on a listing we already
 * undercut by half would out-rank a 6% cut that just went under us. The row that
 * needed reading today would be somewhere down the page.
 *
 * The fix is to fold **within** the undercut partition rather than to re-sort
 * afterwards, and the difference between those two is not cosmetic.
 *
 * Re-sorting afterwards leaves groups that straddle the partition — a store's
 * catalogue-wide reprice folds into one entry whose members include both the
 * three listings that went under us and the thirty that did not. Such a group
 * has no honest position in an undercut-first ordering, and it has no honest
 * headline either: whatever it says about undercutting is false for most of its
 * members, and the reader has to expand thirty rows to find the three. Keyed on
 * store and delta, that straddle is ordinary rather than exotic — the same
 * rupiah cut across a catalogue lands on different sides of our price depending
 * only on which set each listing is.
 *
 * Partitioning first makes every group homogeneous, so `groupUndercutsUs` can
 * read the answer off any member, and each partition keeps `foldRivalMoves`'s
 * magnitude order untouched. The cost is that a straddling reprice is reported
 * as two or three entries instead of one — which is the correct number, because
 * "went under us" and "did not" are two different pieces of news about the same
 * decision. Where a split leaves fewer than `FOLD_MOVE_MIN_GROUP` members, those
 * rows print individually, which is also right: a handful of undercutting rows
 * is exactly what this page exists to show one at a time.
 */
export function foldByConsequence(moves: RivalMove[]): FoldedMoveGroup[] {
  return foldPartitioned(moves);
}

/**
 * Fold, then order newest capture first.
 *
 * The page's question changed once a daily sweep started refilling the
 * database: with stores walked one after another over an afternoon, "which of
 * these numbers is current?" comes before "which matters most?", and a
 * consequence-ordered page answers the second while hiding the first — an
 * undercut priced from a week-old capture outranks the reprice the sweep found
 * ten minutes ago, and nothing on the page says which is which except a
 * timestamp the reader has to hunt for.
 *
 * Partitioning by undercut state still happens, so this keeps what that was
 * for: every folded group stays homogeneous, `groupUndercutsUs` can read the
 * answer off any member, and no group headline claims something false about
 * half its rows. Only the ordering of the finished groups changes — by their
 * newest member's capture, then by magnitude where two groups were captured in
 * the same instant.
 *
 * The undercut signal is not lost, it moves: it is a badge on every row rather
 * than a position on the page.
 */
export function foldByRecency(moves: RivalMove[]): FoldedMoveGroup[] {
  const captured = (entry: FoldedMoveGroup): number => {
    const members = entry.kind === 'folded' ? entry.members : [entry.move];
    // The newest capture in the group: a fold stands for the moment its news
    // was last confirmed, not the moment the oldest member was taken.
    return Math.max(...members.map((move) => new Date(move.scrapedAt).getTime()));
  };
  const weight = (entry: FoldedMoveGroup): number =>
    magnitude(entry.kind === 'folded' ? entry.members[0] : entry.move);

  return foldPartitioned(moves).sort(
    (left, right) => captured(right) - captured(left) || weight(right) - weight(left),
  );
}

/** Fold within each undercut partition, so no group straddles one. */
function foldPartitioned(moves: RivalMove[]): FoldedMoveGroup[] {
  // `true`, then `false`, then `null` — the same `DESC NULLS LAST` the query
  // orders by. An unknown is not evidence that we are safe, so it goes last
  // rather than being treated as a `false`.
  const partitions: Array<boolean | null> = [true, false, null];

  return partitions.flatMap((undercuts) =>
    foldRivalMoves(moves.filter((move) => move.undercutsUs === undercuts)),
  );
}
