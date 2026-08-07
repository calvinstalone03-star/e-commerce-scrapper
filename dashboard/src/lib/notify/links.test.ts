import { describe, expect, test } from 'vitest';

import { priceChangeLink } from '@/lib/notify/links';
import type { RivalMove } from '@/lib/notify/rival-moves';

/**
 * Where a row on the notifications page points.
 *
 * `/pricing/[id]` only accepts our own products — queries.ts:769 joins
 * `AND s.is_own`, and a rival's id is a 404. Every row this feature renders is a
 * rival by construction (`rivalMoves` selects `WHERE NOT s.is_own`), so getting
 * this wrong sends every link on the page to a not-found.
 */

const move = (over: Partial<RivalMove> = {}): RivalMove => ({
  snapshotId: '22089',
  productId: 10017,
  name: 'Lego Creator 10272 Old Trafford',
  setCode: '10272',
  marketplace: 'tokopedia',
  storeId: 167,
  username: 'kenjiro13',
  price: '15000000',
  previousPrice: '12000000',
  scrapedAt: new Date('2026-08-03T02:54:00Z'),
  previousScrapedAt: new Date('2026-08-01T02:54:00Z'),
  ourPrice: '14000000',
  undercutsUs: false,
  ...over,
});

describe('priceChangeLink', () => {
  test('sends a rival with a set number to our position on that set', () => {
    expect(priceChangeLink(move())).toBe('/pricing?kanal=tokopedia&q=10272');
  });

  test('sends a rival without a set number to the product list', () => {
    expect(priceChangeLink(move({ setCode: null, name: 'Rak Display Akrilik' }))).toBe(
      '/products?q=Rak+Display+Akrilik',
    );
  });

  test('falls back to the product list when a rival has neither set number nor name', () => {
    expect(priceChangeLink(move({ setCode: null, name: null }))).toBe('/products');
  });

  /**
   * The link has to survive the schema at the other end.
   *
   * `productFilterSchema.q` is `.max(200).catch(undefined)`, and the `catch` is
   * what makes this quiet: an over-long `q` is not rejected, it is dropped, and
   * the reader arrives at the unfiltered 17,451-row list instead of the one
   * listing the notification was about.
   */
  test('keeps the name short enough that the products filter does not discard it', () => {
    const name = `Rak Display Akrilik Custom ${'Panjang Sekali '.repeat(30)}`;
    expect(name.length).toBeGreaterThan(200);

    const link = priceChangeLink(move({ setCode: null, name }));
    const q = new URL(link, 'https://dash.example').searchParams.get('q');

    expect(q).not.toBeNull();
    expect(q!.length).toBeLessThanOrEqual(200);
    // A prefix, not a mangled name: `/products` matches by substring, so this
    // still finds the listing.
    expect(name.startsWith(q!)).toBe(true);
    expect(q!.length).toBeGreaterThan(100);
  });

  test('does not cut an emoji in half on the way', () => {
    // The 180th UTF-16 unit lands inside the surrogate pair.
    const name = `${'a'.repeat(179)}😀${'b'.repeat(60)}`;
    const q = new URL(priceChangeLink(move({ setCode: null, name })), 'https://dash.example')
      .searchParams.get('q');

    expect(q).toBe('a'.repeat(179));
    expect(q).not.toContain('�');
  });

  test('leaves an ordinary name exactly as it is', () => {
    expect(priceChangeLink(move({ setCode: null, name: 'Rak Display Akrilik' }))).toBe(
      '/products?q=Rak+Display+Akrilik',
    );
  });

  test('returns a path, never an absolute URL', () => {
    // The Telegram digest needed `https://…` because a message is read outside
    // the app. Every one of these is now an in-app <Link>, where an absolute URL
    // would leave the client router and reload the whole page.
    for (const link of [
      priceChangeLink(move()),
      priceChangeLink(move({ setCode: null })),
      priceChangeLink(move({ setCode: null, name: null })),
    ]) {
      expect(link.startsWith('/')).toBe(true);
    }
  });
});
