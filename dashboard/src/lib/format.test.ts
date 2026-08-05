import { describe, expect, test } from 'vitest';

import { formatStoreName, isPlaceholderStore, storeUrl } from '@/lib/format';

/**
 * The storefront link, which is one concatenation and one refusal.
 *
 * The refusal is the part worth testing: `shop-<id>` is what the scraper stores
 * when a Shopee search card carried an id and no slug, and pasting that into a
 * URL produces a 404 that looks exactly like a working link until it is clicked.
 */

describe('storeUrl', () => {
  test('sends a Shopee slug to its storefront', () => {
    expect(storeUrl('shopee', 'brickzproject')).toBe('https://shopee.co.id/brickzproject');
  });

  test('sends a Tokopedia slug to its own host', () => {
    expect(storeUrl('tokopedia', 'menta-hobbies')).toBe(
      'https://www.tokopedia.com/menta-hobbies',
    );
  });

  test('refuses a placeholder, which would be a confident 404', () => {
    expect(isPlaceholderStore('shop-1259259013')).toBe(true);
    expect(storeUrl('shopee', 'shop-1259259013')).toBeNull();
  });

  test.each([null, '', '   '])('refuses %o as a slug', (username) => {
    expect(storeUrl('shopee', username)).toBeNull();
  });

  test('refuses a marketplace it has no host for', () => {
    expect(storeUrl('lazada', 'sometoko')).toBeNull();
  });

  test('encodes a handle that is not URL-safe', () => {
    // Handles arrive from a marketplace payload, not from this codebase.
    expect(storeUrl('shopee', 'toko mainan/anak')).toBe(
      'https://shopee.co.id/toko%20mainan%2Fanak',
    );
  });

  test('trims a slug that arrived padded', () => {
    expect(storeUrl('shopee', '  kaveshop  ')).toBe('https://shopee.co.id/kaveshop');
  });

  test('links the slug, not the display name the table shows', () => {
    // formatStoreName prefers the display name; the URL cannot.
    expect(formatStoreName('kaveshop', 'Toko Kave.Shop Online')).toBe('Toko Kave.Shop Online');
    expect(storeUrl('shopee', 'kaveshop')).toBe('https://shopee.co.id/kaveshop');
  });
});
