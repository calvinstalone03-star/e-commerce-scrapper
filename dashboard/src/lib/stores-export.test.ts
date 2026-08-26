import { describe, expect, test } from 'vitest';

import { formatStoresFile, STORES_FILE_NAME } from '@/lib/stores-export';

/**
 * The exported file is read back by a Python parser that this repo also owns
 * (`scraper/shops.py`), and the two are only kept honest by agreeing on a
 * format. These cases are that agreement written down on this side: the same
 * rules — `marketplace/slug`, `#` comments, blank lines ignored — as
 * `tests/test_shops.py` asserts on the other.
 */

const exportedAt = new Date('2026-08-18T09:30:00+07:00');

describe('formatStoresFile', () => {
  test('writes one marketplace/slug line per shop', () => {
    const text = formatStoresFile(
      [
        { marketplace: 'shopee', username: 'erigostore' },
        { marketplace: 'tokopedia', username: 'eiger-official' },
      ],
      { exportedAt },
    );

    const lines = text.split('\n').filter((line) => line && !line.startsWith('#'));
    expect(lines).toEqual(['shopee/erigostore', 'tokopedia/eiger-official']);
  });

  test('every non-shop line is a comment the parser ignores', () => {
    const text = formatStoresFile([{ marketplace: 'shopee', username: 'erigostore' }], {
      exportedAt,
    });

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      expect(line.startsWith('#') || line === 'shopee/erigostore').toBe(true);
    }
  });

  test('the header says where the file goes', () => {
    // The download lands in ~/Downloads and does nothing there. The one
    // instruction that makes it useful travels inside the file.
    const text = formatStoresFile([{ marketplace: 'shopee', username: 'erigostore' }], {
      exportedAt,
    });

    expect(text).toContain('config/stores.txt');
  });

  test('a shop with no username is dropped', () => {
    // `stores.username` is NOT NULL, but a keyword scrape stores `shop-<id>`
    // placeholders whose slug is not a storefront the extension can navigate to.
    const text = formatStoresFile(
      [
        { marketplace: 'shopee', username: '' },
        { marketplace: 'shopee', username: '   ' },
        { marketplace: 'shopee', username: 'erigostore' },
      ],
      { exportedAt },
    );

    expect(text.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
      'shopee/erigostore',
    ]);
  });

  test('a placeholder shop-<id> username is dropped', () => {
    // Written by keyword scrapes when the grid states no seller. It is an id,
    // not a slug: navigating to /shop-490338801 is a 404.
    const text = formatStoresFile(
      [
        { marketplace: 'shopee', username: 'shop-490338801' },
        { marketplace: 'shopee', username: 'erigostore' },
      ],
      { exportedAt },
    );

    expect(text.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
      'shopee/erigostore',
    ]);
  });

  test('repeats collapse, and the same slug on two marketplaces does not', () => {
    const text = formatStoresFile(
      [
        { marketplace: 'shopee', username: 'erigostore' },
        { marketplace: 'shopee', username: 'ERIGOSTORE' },
        { marketplace: 'tokopedia', username: 'erigostore' },
      ],
      { exportedAt },
    );

    expect(text.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
      'shopee/erigostore',
      'tokopedia/erigostore',
    ]);
  });

  test('an empty database still produces a usable file', () => {
    // Downloading nothing at all reads as a broken button. A file of comments
    // says what to do instead.
    const text = formatStoresFile([], { exportedAt });

    expect(text).toContain('#');
    expect(text.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([]);
  });

  test('the file ends with a newline', () => {
    // The Python loader strips blank lines, so this is about text editors and
    // `cat`, not about parsing.
    expect(
      formatStoresFile([{ marketplace: 'shopee', username: 'erigostore' }], { exportedAt }),
    ).toMatch(/\n$/);
  });

  test('the download is named stores.txt', () => {
    expect(STORES_FILE_NAME).toBe('stores.txt');
  });
});
