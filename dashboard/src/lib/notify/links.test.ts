import { describe, expect, test } from 'vitest';

import type { NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import {
  absolute,
  newProductLink,
  newStoreLink,
  priceChangeLink,
  resolveBaseUrl,
} from '@/lib/notify/links';

/**
 * Where a notification points.
 *
 * `/pricing/[id]` only accepts our own products — queries.ts:769 joins
 * `AND s.is_own`, and a rival's id is a 404. Every price change in the data so
 * far belongs to a rival, so this is not a detail: getting it wrong sends every
 * useful notification to a not-found page.
 */

const change = (over: Partial<PriceChange> = {}): PriceChange => ({
  productId: 10017,
  name: 'Lego Creator 10272 Old Trafford',
  setCode: '10272',
  marketplace: 'tokopedia',
  url: 'https://tokopedia.com/x/y',
  storeId: 167,
  username: 'kenjiro13',
  isOwn: false,
  previousPrice: '12000000',
  price: '15000000',
  scrapedAt: new Date('2026-08-03T02:54:00Z'),
  ...over,
});

describe('resolveBaseUrl', () => {
  test('prefers an explicit override', () => {
    expect(
      resolveBaseUrl({ NOTIFY_BASE_URL: 'https://dash.example', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }),
    ).toBe('https://dash.example');
  });

  test('falls back to the production domain Vercel publishes, with a scheme', () => {
    expect(resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' })).toBe('https://x.vercel.app');
  });

  test('trims a trailing slash so joining never doubles it', () => {
    expect(resolveBaseUrl({ NOTIFY_BASE_URL: 'https://dash.example/' })).toBe('https://dash.example');
  });

  test('refuses to guess when neither is set', () => {
    expect(() => resolveBaseUrl({})).toThrow(/NOTIFY_BASE_URL/);
  });
});

describe('priceChangeLink', () => {
  test('sends our own product to its price-position detail', () => {
    expect(priceChangeLink(change({ isOwn: true, productId: 42 }))).toBe('/pricing/42');
  });

  test('sends a rival with a set number to our position on that set', () => {
    expect(priceChangeLink(change())).toBe('/pricing?kanal=tokopedia&q=10272');
  });

  test('sends a rival without a set number to the product list', () => {
    expect(priceChangeLink(change({ setCode: null, name: 'Rak Display Akrilik' }))).toBe(
      '/products?q=Rak+Display+Akrilik',
    );
  });

  test('falls back to the product list when a rival has neither set number nor name', () => {
    expect(priceChangeLink(change({ setCode: null, name: null }))).toBe('/products');
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

    const link = priceChangeLink(change({ setCode: null, name }));
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
    const q = new URL(priceChangeLink(change({ setCode: null, name })), 'https://dash.example')
      .searchParams.get('q');

    expect(q).toBe('a'.repeat(179));
    expect(q).not.toContain('�');
  });

  test('leaves an ordinary name exactly as it is', () => {
    expect(priceChangeLink(change({ setCode: null, name: 'Rak Display Akrilik' }))).toBe(
      '/products?q=Rak+Display+Akrilik',
    );
  });
});

describe('newStoreLink', () => {
  test('points at the store page by our primary key', () => {
    const store: NewStore = {
      storeId: 249,
      marketplace: 'shopee',
      username: 'toko-baru',
      name: null,
      products: 1600,
    };
    expect(newStoreLink(store)).toBe('/stores/249');
  });
});

describe('newProductLink', () => {
  test('points at the product list filtered to its store', () => {
    const product: NewProduct = {
      productId: 13657,
      name: 'Lego Art 31209 The Amazing Spider-Man',
      setCode: '31209',
      marketplace: 'tokopedia',
      url: null,
      storeId: 167,
      username: 'kenjiro13',
    };
    expect(newProductLink(product)).toBe('/products?storeId=167');
  });
});

describe('absolute', () => {
  test('joins a base and a path without doubling the slash', () => {
    expect(absolute('https://dash.example', '/pricing/42')).toBe('https://dash.example/pricing/42');
  });

  test('keeps the query string intact', () => {
    expect(absolute('https://dash.example', '/pricing?kanal=shopee&q=42218')).toBe(
      'https://dash.example/pricing?kanal=shopee&q=42218',
    );
  });
});
