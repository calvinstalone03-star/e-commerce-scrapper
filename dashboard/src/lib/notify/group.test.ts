import { describe, expect, test } from 'vitest';

import { foldRivalMoves } from '@/lib/notify/group';
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
