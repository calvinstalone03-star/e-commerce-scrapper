import { describe, expect, test } from 'vitest';

import { foldByConsequence, foldRivalMoves, groupUndercutsUs } from '@/lib/notify/group';
import type { RivalMove } from '@/lib/notify/rival-moves';

/**
 * Folding, ported from the digest's own tests.
 *
 * Pure string and number work over rows the caller already has, so no database:
 * what can go wrong here is a key that folds two decisions into one, or an
 * ordering that puts a listing whose old price was never real above every real
 * reprice.
 */

const move = (over: Partial<RivalMove> = {}): RivalMove => ({
  snapshotId: '22089',
  productId: 1,
  name: 'LEGO Technic 42218 John Deere',
  setCode: '42218',
  marketplace: 'shopee',
  storeId: 1,
  username: 'lego.indonesia',
  price: '211850',
  previousPrice: '186850',
  scrapedAt: new Date('2026-08-03T02:54:00Z'),
  previousScrapedAt: new Date('2026-08-01T02:54:00Z'),
  ourPrice: '200000',
  undercutsUs: false,
  ...over,
});

describe('foldRivalMoves', () => {
  test('folds three or more identical deltas from one store', () => {
    const moves = [1, 2, 3].map((id) => move({ productId: id }));
    const folded = foldRivalMoves(moves);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: 'folded', delta: 25000, username: 'lego.indonesia' });
    // The whole point of folding is reversibility — the page renders
    // `members.length` and expands the group from it, so every member has to
    // survive the fold, not just the first.
    const entry = folded[0];
    if (entry.kind !== 'folded') throw new Error('expected a folded entry');
    expect(entry.members.map((m) => m.productId)).toEqual([1, 2, 3]);
  });

  test('leaves two identical deltas alone — a coincidence is not a pattern', () => {
    const moves = [1, 2].map((id) => move({ productId: id }));
    const folded = foldRivalMoves(moves);
    expect(folded).toHaveLength(2);
    expect(folded.every((entry) => entry.kind === 'single')).toBe(true);
  });

  test('does not fold across stores even when the delta matches', () => {
    const moves = [
      move({ productId: 1, storeId: 1, username: 'a' }),
      move({ productId: 2, storeId: 1, username: 'a' }),
      move({ productId: 3, storeId: 2, username: 'b' }),
    ];
    const folded = foldRivalMoves(moves);
    expect(folded.filter((entry) => entry.kind === 'folded')).toHaveLength(0);
  });

  test('does not fold a rise into a fall of the same magnitude', () => {
    const moves = [
      move({ productId: 1, previousPrice: '100000', price: '125000' }),
      move({ productId: 2, previousPrice: '100000', price: '125000' }),
      move({ productId: 3, previousPrice: '125000', price: '100000' }),
    ];
    const folded = foldRivalMoves(moves);
    expect(folded.filter((entry) => entry.kind === 'folded')).toHaveLength(0);
  });

  test('orders by the size of the move relative to where it started', () => {
    // Not by the rupiah figure, which is why the middling one here carries the
    // largest delta of the three by far: 200.000 off a 1.000.000 listing is a
    // smaller decision than 60.000 off a 100.000 one, and ordering by the money
    // would put it first.
    const small = move({ productId: 1, previousPrice: '100000', price: '103000' });
    const big = move({ productId: 2, previousPrice: '100000', price: '160000' });
    const middling = move({ productId: 3, previousPrice: '1000000', price: '1200000' });

    const folded = foldRivalMoves([small, big, middling]);

    expect(folded.map((entry) => (entry.kind === 'single' ? entry.move.productId : 0))).toEqual([
      2, 3, 1,
    ]);
  });

  test('ranks a fall by its size, not its sign', () => {
    const rise = move({ productId: 1, previousPrice: '100000', price: '110000' });
    const fall = move({ productId: 2, previousPrice: '100000', price: '50000' });

    const folded = foldRivalMoves([rise, fall]);

    expect(folded.map((entry) => (entry.kind === 'single' ? entry.move.productId : 0))).toEqual([
      2, 1,
    ]);
  });

  test('ranks a move from a zero price last, not at the head of the list', () => {
    // previousPrice 0 makes the weight a division by zero, which is Infinity, so
    // a listing whose old price was never real would sort above every genuine
    // reprice and take the top of the page.
    const fromZero = move({ productId: 1, previousPrice: '0', price: '150000' });
    const ordinary = move({ productId: 2, previousPrice: '100000', price: '101000' });

    const folded = foldRivalMoves([fromZero, ordinary]);

    expect(folded.map((entry) => (entry.kind === 'single' ? entry.move.productId : 0))).toEqual([
      2, 1,
    ]);
  });

  test('a folded group is ranked by the move it stands for', () => {
    // The folded entry's weight has to come from its members, not from a
    // default: three listings that moved 60% must outrank a single one that
    // moved 3%, or folding would bury exactly the decision it exists to
    // surface.
    const loud = [1, 2, 3].map((id) =>
      move({ productId: id, storeId: 9, previousPrice: '100000', price: '160000' }),
    );
    const quiet = move({ productId: 4, storeId: 1, previousPrice: '100000', price: '103000' });

    const folded = foldRivalMoves([quiet, ...loud]);

    expect(folded).toHaveLength(2);
    expect(folded[0].kind).toBe('folded');
  });
});

describe('foldByConsequence', () => {
  /**
   * The ordering key `foldRivalMoves` throws away, put back.
   *
   * `rivalMoves` orders by `undercutsUs DESC NULLS LAST` first and magnitude
   * second. Folding re-sorts by magnitude alone, so a fold applied to the query
   * output silently demotes the one class of row this page exists for.
   */

  const ids = (entries: ReturnType<typeof foldByConsequence>): number[] =>
    entries.flatMap((entry) =>
      entry.kind === 'folded' ? entry.members.map((m) => m.productId) : [entry.move.productId],
    );

  test('a small undercutting move outranks a large one that does not', () => {
    // The regression in one case. Plain `foldRivalMoves` puts the 50% move
    // first; the rival who just went under our price is what needs reading.
    const dearer = move({ productId: 1, previousPrice: '1000000', price: '500000' });
    const under = move({ productId: 2, previousPrice: '100000', price: '94000', undercutsUs: true });

    expect(ids(foldByConsequence([dearer, under]))).toEqual([2, 1]);
    // And this is what it is fixing.
    expect(ids(foldRivalMoves([dearer, under]))).toEqual([1, 2]);
  });

  test('an unknown own price sorts after a known safe one — NULLS LAST', () => {
    // We have no price for the set, so we do not know we are being undercut. An
    // unknown is not evidence that we are not, but it is not evidence that we
    // are either, so it ranks below a move we know did not go under us.
    const unknown = move({ productId: 1, previousPrice: '100000', price: '20000', ourPrice: null, undercutsUs: null });
    const known = move({ productId: 2, previousPrice: '100000', price: '94000', undercutsUs: false });

    expect(ids(foldByConsequence([unknown, known]))).toEqual([2, 1]);
  });

  test('magnitude still orders within a partition', () => {
    const small = move({ productId: 1, previousPrice: '100000', price: '97000', undercutsUs: true });
    const large = move({ productId: 2, previousPrice: '100000', price: '60000', undercutsUs: true });

    expect(ids(foldByConsequence([small, large]))).toEqual([2, 1]);
  });

  test('a straddling reprice splits, so no group lies about its members', () => {
    // One store, one rupiah cut, applied across a catalogue: three of those
    // listings went under our price and three did not, because they are
    // different sets. Folded as one entry the group cannot state its own
    // undercut status without being wrong about half of it, and the three rows
    // that matter are buried inside thirty that do not.
    const under = [1, 2, 3].map((id) =>
      move({ productId: id, storeId: 7, previousPrice: '100000', price: '90000', undercutsUs: true }),
    );
    const over = [4, 5, 6].map((id) =>
      move({ productId: id, storeId: 7, previousPrice: '100000', price: '90000', undercutsUs: false }),
    );

    const folded = foldByConsequence([...over, ...under]);

    expect(folded).toHaveLength(2);
    expect(folded.map(groupUndercutsUs)).toEqual([true, false]);
    expect(ids(folded)).toEqual([1, 2, 3, 4, 5, 6]);

    // Plain folding keys on store and delta alone, so it makes one group of six
    // whose undercut status is unanswerable.
    expect(foldRivalMoves([...over, ...under])).toHaveLength(1);
  });

  test('a split below the fold threshold prints its rows individually', () => {
    // Two undercutting rows out of five is a coincidence at group level and a
    // worklist at row level. Printing them one at a time is what this page is
    // for.
    const under = [1, 2].map((id) =>
      move({ productId: id, storeId: 7, previousPrice: '100000', price: '90000', undercutsUs: true }),
    );
    const over = [3, 4, 5].map((id) =>
      move({ productId: id, storeId: 7, previousPrice: '100000', price: '90000', undercutsUs: false }),
    );

    const folded = foldByConsequence([...over, ...under]);

    expect(folded.map((entry) => entry.kind)).toEqual(['single', 'single', 'folded']);
    expect(ids(folded)).toEqual([1, 2, 3, 4, 5]);
  });

  test('groupUndercutsUs answers for a folded group and for a lone row alike', () => {
    const under = [1, 2, 3].map((id) =>
      move({ productId: id, storeId: 7, previousPrice: '100000', price: '90000', undercutsUs: true }),
    );
    const [group] = foldByConsequence(under);
    expect(group.kind).toBe('folded');
    expect(groupUndercutsUs(group)).toBe(true);

    const [lone] = foldByConsequence([move({ productId: 9, undercutsUs: null })]);
    expect(lone.kind).toBe('single');
    expect(groupUndercutsUs(lone)).toBeNull();
  });
});
