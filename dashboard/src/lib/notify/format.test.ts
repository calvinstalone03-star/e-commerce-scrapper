import { describe, expect, test } from 'vitest';

import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import {
  MAX_ENTRIES_PER_GROUP,
  MAX_MESSAGES,
  TELEGRAM_MAX_CHARS,
  escapeHtml,
  foldPriceChanges,
  renderDigest,
  renderProductMessage,
  renderStaleWarning,
  splitByOwnSets,
} from '@/lib/notify/format';
import type { SetPosition } from '@/lib/notify/positions';

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

  test('ranks a change from a zero price last, not at the head of the digest', () => {
    // Same defect the per-product split guards against, in the digest's own
    // ordering: previousPrice 0 makes the weight a division by zero, which is
    // Infinity, so a listing whose old price was never real would sort above
    // every genuine reprice and take one of the twelve printed slots.
    const fromZero = change({ productId: 1, previousPrice: '0', price: '150000' });
    const ordinary = change({ productId: 2, previousPrice: '100000', price: '101000' });

    const folded = foldPriceChanges([fromZero, ordinary]);

    expect(folded.map((entry) => (entry.kind === 'single' ? entry.change.productId : 0))).toEqual([
      2, 1,
    ]);
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

const position = (over: Partial<SetPosition> = {}): SetPosition => ({
  setCode: '42218',
  ourPrice: '165000',
  ourShop: 'i_bricks',
  cheapestRival: '150100',
  rivalCount: 4,
  extreme: false,
  ...over,
});

describe('splitByOwnSets', () => {
  test('sends a change on a set we sell to the per-product stream', () => {
    const mine = change({ setCode: '42218' });
    const split = splitByOwnSets([mine], new Set(['42218']));
    expect(split.perProduct).toEqual([mine]);
    expect(split.rest).toEqual([]);
  });

  test('leaves a change on a set we do not sell in the digest', () => {
    const theirs = change({ setCode: '10321' });
    const split = splitByOwnSets([theirs], new Set(['42218']));
    expect(split.perProduct).toEqual([]);
    expect(split.rest).toEqual([theirs]);
  });

  test('puts a change with no set code in the digest, never per-product', () => {
    // An accessory or a knock-off carries no set number, so there is no set for
    // it to belong to and no position to state — the whole premise of the
    // per-product message is missing.
    const nameless = change({ setCode: null });
    const split = splitByOwnSets([nameless], new Set(['42218']));
    expect(split.perProduct).toEqual([]);
    expect(split.rest).toEqual([nameless]);
  });

  test('orders the per-product stream by percentage, largest first', () => {
    // The cap in run.ts bites from the bottom, so this ordering decides which
    // changes survive it: the biggest proportional move demands a decision
    // most.
    const small = change({ productId: 1, setCode: '1', previousPrice: '100000', price: '103000' });
    const big = change({ productId: 2, setCode: '2', previousPrice: '100000', price: '160000' });
    const middling = change({ productId: 3, setCode: '3', previousPrice: '100000', price: '120000' });

    const split = splitByOwnSets([small, big, middling], new Set(['1', '2', '3']));

    expect(split.perProduct.map((entry) => entry.productId)).toEqual([2, 3, 1]);
  });

  test('ranks a fall by its size, not its sign', () => {
    const rise = change({ productId: 1, setCode: '1', previousPrice: '100000', price: '110000' });
    const fall = change({ productId: 2, setCode: '2', previousPrice: '100000', price: '50000' });

    const split = splitByOwnSets([rise, fall], new Set(['1', '2']));

    expect(split.perProduct.map((entry) => entry.productId)).toEqual([2, 1]);
  });

  test('ranks a change from a zero price last rather than first', () => {
    // previousPrice 0 makes the percentage a division by zero, which is
    // Infinity — it would top the order and spend a capped per-product slot on
    // a listing whose old price was never real. It is not a reprice worth
    // ranking, so it sorts as no movement at all.
    const fromZero = change({ productId: 1, setCode: '1', previousPrice: '0', price: '150000' });
    const ordinary = change({ productId: 2, setCode: '2', previousPrice: '100000', price: '101000' });

    const split = splitByOwnSets([fromZero, ordinary], new Set(['1', '2']));

    expect(split.perProduct.map((entry) => entry.productId)).toEqual([2, 1]);
  });
});

describe('renderProductMessage', () => {
  test('renders the spec message for a fall, with our position under it', () => {
    const message = renderProductMessage(
      change({
        name: 'LEGO Technic 42218 John Deere 1470H',
        username: 'lego.indonesia',
        previousPrice: '186850',
        price: '150100',
      }),
      position(),
      { baseUrl: BASE_URL },
    );

    expect(message).toContain('📉');
    expect(message).toContain('LEGO Technic 42218 John Deere 1470H');
    expect(message).toContain('lego.indonesia · Shopee');
    expect(message).toContain('−19,7%');
    expect(message).toContain('i_bricks');
    expect(message).toContain('dari 4 toko');
    expect(message).toContain('posisi kita di 42218');
  });

  test('marks a rise with the rising arrow', () => {
    const message = renderProductMessage(
      change({ previousPrice: '150100', price: '186850' }),
      position(),
      { baseUrl: BASE_URL },
    );
    expect(message).toContain('📈');
    expect(message).toContain('+24,5%');
  });

  test('says TERMAHAL, and by how much, when we are the dearer side', () => {
    const message = renderProductMessage(
      change(),
      position({ ourPrice: '165000', cheapestRival: '150100' }),
      { baseUrl: BASE_URL },
    );
    expect(message).toContain('TERMAHAL');
    expect(message).not.toContain('TERMURAH');
    expect(message).toContain('14.900');
  });

  test('says TERMURAH when our price is at or below the cheapest rival', () => {
    const message = renderProductMessage(
      change(),
      position({ ourPrice: '140000', cheapestRival: '150100' }),
      { baseUrl: BASE_URL },
    );
    expect(message).toContain('TERMURAH');
    expect(message).not.toContain('TERMAHAL');
  });

  test('counts a tie as TERMURAH, not TERMAHAL', () => {
    const message = renderProductMessage(
      change(),
      position({ ourPrice: '150100', cheapestRival: '150100' }),
      { baseUrl: BASE_URL },
    );
    expect(message).toContain('TERMURAH');
  });

  test('collapses the position block when we have no price on the set', () => {
    const message = renderProductMessage(change(), position({ ourPrice: null, ourShop: null }), {
      baseUrl: BASE_URL,
    });
    expect(message).toContain('belum berharga');
    expect(message).not.toContain('TERMAHAL');
    expect(message).not.toContain('TERMURAH');
    // Still a message: the rival did move, and that is a fact worth sending.
    expect(message).toContain('posisi kita di 42218');
  });

  test('treats a set missing from the map the same as having no price', () => {
    const message = renderProductMessage(change(), undefined, { baseUrl: BASE_URL });
    expect(message).toContain('belum berharga');
    expect(message).not.toContain('TERMAHAL');
  });

  test('replaces the position block with the incomparable notice when extreme', () => {
    // Set 8827: a sealed box of sixty against a single loose minifigure. The
    // pairing is real and the arithmetic is right, but "kita lebih mahal Rp 8,1
    // juta" is nonsense that costs the reader their trust in the other 71.
    const message = renderProductMessage(
      change({ setCode: '8827' }),
      position({ setCode: '8827', ourPrice: '8500000', cheapestRival: '397000', extreme: true }),
      { baseUrl: BASE_URL },
    );

    expect(message).toContain('tidak sebanding');
    expect(message).not.toContain('TERMAHAL');
    expect(message).not.toContain('TERMURAH');
    expect(message).not.toContain('Termurah');
    expect(message).toContain('periksa di dashboard');
  });

  test('states the position when the only priced listing is ours', () => {
    const message = renderProductMessage(
      change(),
      position({ cheapestRival: null, rivalCount: 0 }),
      { baseUrl: BASE_URL },
    );
    expect(message).toContain('165.000');
    expect(message).not.toContain('TERMAHAL');
    expect(message).not.toContain('TERMURAH');
  });

  test('escapes a listing name that would otherwise break the parse', () => {
    const message = renderProductMessage(
      change({ name: 'Batman & Robin <set> 76224' }),
      position(),
      { baseUrl: BASE_URL },
    );
    expect(message).toContain('Batman &amp; Robin &lt;set&gt; 76224');
    expect(message).not.toContain('<set>');
  });

  test('escapes a shop username too', () => {
    const message = renderProductMessage(change({ username: 'toko<&>x' }), position(), {
      baseUrl: BASE_URL,
    });
    expect(message).toContain('toko&lt;&amp;&gt;x');
  });

  test('makes the link absolute', () => {
    const message = renderProductMessage(change(), position(), { baseUrl: BASE_URL });
    expect(message).toContain(`href="${BASE_URL}/pricing?`);
  });

  test('fits one Telegram message even when the name is absurd', () => {
    // There is no splitting here — a per-product message is one message by
    // definition — so an overlong name has to be cut rather than spilled.
    const message = renderProductMessage(change({ name: 'L'.repeat(20_000) }), position(), {
      baseUrl: BASE_URL,
    });

    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(message).toContain('posisi kita di 42218');
  });

  test('fits one message when every character of the name escapes to five', () => {
    const message = renderProductMessage(change({ name: '&'.repeat(20_000) }), position(), {
      baseUrl: BASE_URL,
    });

    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(message).toContain('posisi kita di 42218');
  });

  test('leaves no half-escaped entity where an overlong name was cut', () => {
    const message = renderProductMessage(change({ name: '&'.repeat(20_000) }), position(), {
      baseUrl: BASE_URL,
    });

    // A cut through `&amp;` leaves `&am`, which Telegram rejects for the whole
    // message. Every `&` that survives must still be a complete entity.
    expect(message.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
  });

  test('handles a listing with no name at all', () => {
    const message = renderProductMessage(change({ name: null }), position(), {
      baseUrl: BASE_URL,
    });
    expect(message).toContain('tanpa nama');
  });
});
