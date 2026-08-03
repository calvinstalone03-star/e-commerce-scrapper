import { describe, expect, test } from 'vitest';

import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import {
  TELEGRAM_MAX_CHARS,
  escapeHtml,
  foldPriceChanges,
  renderDigest,
  renderStaleWarning,
} from '@/lib/notify/format';

/**
 * The message itself.
 *
 * Almost every bug that survives to production hides here rather than in the
 * SQL: an unescaped `&` in a listing title makes Telegram reject the whole
 * message with a 400, and a split that lands mid-line makes a digest
 * unreadable without failing anything.
 */

const BASE_URL = 'https://dash.example';
const NOW = new Date('2026-08-03T02:54:00Z');

const change = (over: Partial<PriceChange> = {}): PriceChange => ({
  productId: 1,
  name: 'LEGO Technic 42218 John Deere',
  setCode: '42218',
  marketplace: 'shopee',
  url: null,
  storeId: 1,
  username: 'lego.indonesia',
  isOwn: false,
  previousPrice: '186850',
  price: '211850',
  scrapedAt: NOW,
  ...over,
});

const empty: Events = { priceChanges: [], newStores: [], newProducts: [] };

describe('escapeHtml', () => {
  test('escapes exactly the three characters Telegram HTML reserves', () => {
    expect(escapeHtml('Batman & Robin <set> "x"')).toBe('Batman &amp; Robin &lt;set&gt; "x"');
  });
});

describe('foldPriceChanges', () => {
  test('folds three or more identical deltas from one store', () => {
    const changes = [1, 2, 3].map((id) => change({ productId: id }));
    const folded = foldPriceChanges(changes);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: 'folded', delta: 25000, username: 'lego.indonesia' });
  });

  test('leaves two identical deltas alone — a coincidence is not a pattern', () => {
    const changes = [1, 2].map((id) => change({ productId: id }));
    const folded = foldPriceChanges(changes);
    expect(folded).toHaveLength(2);
    expect(folded.every((entry) => entry.kind === 'single')).toBe(true);
  });

  test('does not fold across stores even when the delta matches', () => {
    const changes = [
      change({ productId: 1, storeId: 1, username: 'a' }),
      change({ productId: 2, storeId: 1, username: 'a' }),
      change({ productId: 3, storeId: 2, username: 'b' }),
    ];
    const folded = foldPriceChanges(changes);
    expect(folded.filter((entry) => entry.kind === 'folded')).toHaveLength(0);
  });

  test('does not fold a rise into a fall of the same magnitude', () => {
    const changes = [
      change({ productId: 1, previousPrice: '100000', price: '125000' }),
      change({ productId: 2, previousPrice: '100000', price: '125000' }),
      change({ productId: 3, previousPrice: '125000', price: '100000' }),
    ];
    const folded = foldPriceChanges(changes);
    expect(folded.filter((entry) => entry.kind === 'folded')).toHaveLength(0);
  });
});

describe('renderDigest', () => {
  test('says nothing at all when nothing happened', () => {
    expect(renderDigest(empty, { baseUrl: BASE_URL, now: NOW })).toEqual([]);
  });

  test('separates rises from falls and counts each', () => {
    const events: Events = {
      ...empty,
      priceChanges: [
        change({ productId: 1, previousPrice: '100000', price: '125000' }),
        change({ productId: 2, previousPrice: '532100', price: '495200', setCode: '77242' }),
      ],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('Naik harga — 1');
    expect(message).toContain('Turun harga — 1');
  });

  test('orders a group by percentage, largest first', () => {
    const events: Events = {
      ...empty,
      priceChanges: [
        change({ productId: 1, previousPrice: '1000000', price: '1010000', setCode: '11111' }),
        change({ productId: 2, previousPrice: '100000', price: '200000', setCode: '22222' }),
      ],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });
    expect(message.indexOf('22222')).toBeLessThan(message.indexOf('11111'));
  });

  test('escapes a listing name that would otherwise break the parse', () => {
    const events: Events = {
      ...empty,
      priceChanges: [change({ name: 'Batman & Robin <rare>' })],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('Batman &amp; Robin &lt;rare&gt;');
    expect(message).not.toContain('Batman & Robin <rare>');
  });

  test('makes every link absolute', () => {
    const events: Events = { ...empty, priceChanges: [change()] };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });
    expect(message).toContain('https://dash.example/pricing?kanal=shopee&amp;q=42218');
  });

  test('reports a new store once, with its listing count', () => {
    const store: NewStore = {
      storeId: 249,
      marketplace: 'shopee',
      username: 'toko-baru',
      name: null,
      products: 1600,
    };
    const [message] = renderDigest({ ...empty, newStores: [store] }, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('Toko baru — 1');
    expect(message).toContain('1.600');
  });

  test('reports new products in a known store', () => {
    const product: NewProduct = {
      productId: 13657,
      name: 'Lego Art 31209 The Amazing Spider-Man',
      setCode: '31209',
      marketplace: 'tokopedia',
      url: null,
      storeId: 167,
      username: 'kenjiro13',
    };
    const [message] = renderDigest(
      { ...empty, newProducts: [product] },
      { baseUrl: BASE_URL, now: NOW },
    );

    expect(message).toContain('Produk baru di toko lama — 1');
    expect(message).toContain('Lego Art 31209');
  });

  test('keeps every message inside the Telegram limit', () => {
    const events: Events = {
      ...empty,
      priceChanges: Array.from({ length: 400 }, (_, index) =>
        change({
          productId: index + 1,
          setCode: String(10000 + index),
          name: `LEGO Very Long Product Name Number ${index} With Padding To Make It Wide`,
          previousPrice: String(100000 + index * 1000),
          price: String(200000 + index * 3000),
        }),
      ),
    };

    const messages = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  test('never splits inside a line', () => {
    const events: Events = {
      ...empty,
      priceChanges: Array.from({ length: 400 }, (_, index) =>
        change({
          productId: index + 1,
          setCode: String(10000 + index),
          name: `LEGO Very Long Product Name Number ${index} With Padding To Make It Wide`,
        }),
      ),
    };

    for (const message of renderDigest(events, { baseUrl: BASE_URL, now: NOW })) {
      // A split mid-tag would leave an unbalanced <a>. Count them instead of
      // eyeballing: every opened anchor must close in the same message.
      const opened = (message.match(/<a /g) ?? []).length;
      const closed = (message.match(/<\/a>/g) ?? []).length;
      expect(opened).toBe(closed);
    }
  });

  test('states the true total in the heading even when the body is truncated', () => {
    const events: Events = {
      ...empty,
      priceChanges: Array.from({ length: 400 }, (_, index) =>
        change({ productId: index + 1, setCode: String(10000 + index) }),
      ),
    };
    const messages = renderDigest(events, { baseUrl: BASE_URL, now: NOW });
    expect(messages[0]).toContain('Naik harga — 400');
  });
});

describe('renderStaleWarning', () => {
  test('names how long the data has been still and what to check', () => {
    const message = renderStaleWarning({
      latest: new Date('2026-07-29T14:14:00Z'),
      hours: 128,
    });
    expect(message).toContain('128 jam');
    expect(message).toContain('DATABASE_URL');
  });

  test('handles a database with no snapshots at all', () => {
    const message = renderStaleWarning({ latest: null, hours: 0 });
    expect(message).toContain('belum ada snapshot');
  });
});
