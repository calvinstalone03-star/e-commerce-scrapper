import { describe, expect, test } from 'vitest';

import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import {
  MAX_ENTRIES_PER_GROUP,
  MAX_MESSAGES,
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

  /**
   * A fixture wide enough that the packing has real work to do.
   *
   * Three things it has to get right at once, or the tests below prove nothing.
   * Prices vary per entry, because a fixed delta folds every change from one
   * store into a single four-line entry. Stores vary too, for the same reason.
   * And the names are padded: since the entry cap, twelve ordinary entries fit
   * in one message, so only a wide entry still crosses a message boundary — the
   * boundary being the whole point of both tests.
   */
  const wideChanges = (count: number): PriceChange[] =>
    Array.from({ length: count }, (_, index) => {
      const falling = index % 2 === 1;
      return change({
        productId: index + 1,
        storeId: index + 1,
        setCode: String(10000 + index),
        name: `LEGO Very Long Product Name Number ${index} With Padding To Make It Wide${' Seri Koleksi Terbatas'.repeat(12)}`,
        previousPrice: falling ? String(900000 + index * 3000) : String(100000 + index * 1000),
        price: falling ? String(100000 + index * 1000) : String(200000 + index * 3000),
      });
    });

  test('keeps every message inside the Telegram limit', () => {
    const messages = renderDigest(
      { ...empty, priceChanges: wideChanges(400) },
      { baseUrl: BASE_URL, now: NOW },
    );

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  test('never splits inside a line', () => {
    const messages = renderDigest(
      { ...empty, priceChanges: wideChanges(400) },
      { baseUrl: BASE_URL, now: NOW },
    );

    // Confirms the fixture actually forces a split — otherwise the loop below
    // checks nothing and the test proves nothing.
    expect(messages.length).toBeGreaterThan(1);

    for (const message of messages) {
      // A split mid-tag would leave an unbalanced <a>. Count them instead of
      // eyeballing: every opened anchor must close in the same message.
      const opened = (message.match(/<a /g) ?? []).length;
      const closed = (message.match(/<\/a>/g) ?? []).length;
      expect(opened).toBe(closed);
    }
  });

  test('hard-truncates a single overlong line without leaving an unbalanced tag', () => {
    // A name long enough that its rendered line clears TELEGRAM_MAX_CHARS by
    // only a handful of characters: the cut lands inside the trailing
    // `<a href="...">lihat</a>` itself rather than before it, which is the
    // one case a naive character-offset slice cannot get right for free.
    const product: NewProduct = {
      productId: 1,
      name: 'x'.repeat(4020),
      setCode: null,
      marketplace: 'shopee',
      url: null,
      storeId: 1,
      username: 'toko',
    };

    const messages = renderDigest(
      { ...empty, newProducts: [product] },
      { baseUrl: BASE_URL, now: NOW },
    );

    // Confirms the fixture actually reaches the hard-truncation branch —
    // otherwise the assertions below would pass vacuously.
    expect(messages.some((message) => message.includes('…'))).toBe(true);

    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
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

  /**
   * The digest's size cap, which is also the behaviour the design promised and
   * nobody implemented (spec lines 368-371).
   *
   * Uncapped, these 400 changes render as 22 messages and 1,600 new products as
   * 63 — against a Telegram limit of roughly 20 messages a minute to one chat.
   * The 429s that follow are slept off inside `sql.begin`, holding `FOR UPDATE`
   * on the watermark, so the run that most needs to finish is the one least
   * able to.
   */
  describe('the size cap', () => {
    const distinct = (count: number): PriceChange[] =>
      Array.from({ length: count }, (_, index) =>
        change({
          productId: index + 1,
          storeId: index + 1,
          setCode: String(10000 + index),
          previousPrice: String(100000 + index * 1000),
          price: String(200000 + index * 3000),
        }),
      );

    test('prints at most MAX_ENTRIES_PER_GROUP entries in a group', () => {
      const messages = renderDigest(
        { ...empty, priceChanges: distinct(400) },
        { baseUrl: BASE_URL, now: NOW },
      );
      const bullets = messages.join('\n').match(/^ {2}• /gm) ?? [];
      expect(bullets).toHaveLength(MAX_ENTRIES_PER_GROUP);
    });

    test('names how many it left out, so shown plus remainder is the heading', () => {
      const messages = renderDigest(
        { ...empty, priceChanges: distinct(400) },
        { baseUrl: BASE_URL, now: NOW },
      );
      const body = messages.join('\n');

      expect(body).toContain('Naik harga — 400');
      // 400 total, twelve printed. The remainder is what the reader is not
      // being shown, not a count of anything else.
      expect(body).toContain(`… ${(400 - MAX_ENTRIES_PER_GROUP).toLocaleString('id-ID')} lainnya`);
    });

    test('counts folded listings, not printed entries, in the remainder', () => {
      // One shop, one delta, thirteen listings: they fold into a single entry
      // that stands for all thirteen. Nothing is dropped, so there is no
      // remainder line at all — the naive "entries minus cap" would be wrong in
      // the other direction and print one.
      const folded = Array.from({ length: 13 }, (_, index) =>
        change({ productId: index + 1, storeId: 7, setCode: String(20000 + index) }),
      );
      const messages = renderDigest(
        { ...empty, priceChanges: folded },
        { baseUrl: BASE_URL, now: NOW },
      );

      expect(messages.join('\n')).toContain('serempak di 13 listing');
      expect(messages.join('\n')).not.toContain('lainnya');
    });

    test('truncates the 1,600-listing case the ingest split makes reachable', () => {
      const products: NewProduct[] = Array.from({ length: 1600 }, (_, index) => ({
        productId: index + 1,
        name: `Lego Art 31209 The Amazing Spider-Man ${index}`,
        setCode: '31209',
        marketplace: 'tokopedia',
        url: null,
        storeId: 167,
        username: 'kenjiro13',
      }));

      const messages = renderDigest({ ...empty, newProducts: products }, { baseUrl: BASE_URL, now: NOW });

      expect(messages[0]).toContain('Produk baru di toko lama — 1.600');
      expect(messages.join('\n')).toContain('… 1.588 lainnya');
      expect(messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    });

    /**
     * The entry cap bounds realistic events; it cannot bound a single listing
     * name of 1,200 characters, because it counts entries and not bytes. This
     * is the backstop, and the notice is how the reader knows there was more.
     */
    test('never sends more than MAX_MESSAGES, whatever one entry costs', () => {
      const events: Events = {
        ...empty,
        priceChanges: distinct(40).map((entry) => ({ ...entry, name: 'B'.repeat(1200) })),
        newProducts: Array.from({ length: 40 }, (_, index) => ({
          productId: index + 1,
          name: 'C'.repeat(1200),
          setCode: null,
          marketplace: 'tokopedia' as const,
          url: null,
          storeId: 167,
          username: 'kenjiro13',
        })),
      };

      const messages = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

      // Confirms the fixture actually reaches the cap; without this the two
      // assertions below would pass on any digest at all.
      expect(messages).toHaveLength(MAX_MESSAGES);
      expect(messages[MAX_MESSAGES - 1]).toContain('sisanya dipotong');
      for (const message of messages) {
        expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
        // Dropping whole lines to fit the notice must not orphan an anchor.
        expect((message.match(/<a /g) ?? []).length).toBe((message.match(/<\/a>/g) ?? []).length);
      }
    });
  });

  test('escapes a shop username exactly once, without the caller helping', () => {
    // `shopLabel` escapes itself now. If a caller still wrapped it, this would
    // read `&amp;amp;` — a double-escape is a cosmetic bug, but the missing
    // escape it replaces is a 400 that stops the watermark forever.
    const events: Events = {
      ...empty,
      priceChanges: [change({ username: 'toko & <b>promo</b>' })],
    };
    const [message] = renderDigest(events, { baseUrl: BASE_URL, now: NOW });

    expect(message).toContain('toko &amp; &lt;b&gt;promo&lt;/b&gt; · Shopee');
    expect(message).not.toContain('&amp;amp;');
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
