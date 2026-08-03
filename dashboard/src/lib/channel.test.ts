import { describe, expect, test } from 'vitest';

import { CHANNEL_PARAM, channelFromParams, channelShop, resolveChannel, withChannel } from '@/lib/channel';
import type { OwnShop } from '@/lib/schemas';

/**
 * Which of our shops a request is about.
 *
 * Every figure on three screens is relative to one shop of ours, so this is the
 * function that decides what those numbers mean. It never throws: a hand-typed
 * or stale URL has to open the page anyway, on the shop that is still there.
 */

const shopee: OwnShop = { id: 25, marketplace: 'shopee', username: 'i_bricks', name: null, products: 1516 };
const tokopedia: OwnShop = { id: 164, marketplace: 'tokopedia', username: 'i-bricks', name: null, products: 1452 };

// getOwnShops orders by product count, so the list arrives in no useful order
// for this decision — the default has to sort for itself.
const both = [tokopedia, shopee];

describe('resolveChannel', () => {
  test('honours the channel named in the URL', () => {
    expect(resolveChannel('tokopedia', both)).toBe('tokopedia');
  });

  test('falls back to the first marketplace alphabetically when the URL says nothing', () => {
    expect(resolveChannel(undefined, both)).toBe('shopee');
    expect(resolveChannel(null, both)).toBe('shopee');
    expect(resolveChannel('', both)).toBe('shopee');
  });

  test('falls back rather than failing on a value that is not a marketplace', () => {
    expect(resolveChannel('lazada', both)).toBe('shopee');
  });

  test('falls back when the named channel has no own shop any more', () => {
    // A bookmark outliving `own-shop` being unset must not render another
    // channel's numbers under the old channel's name.
    expect(resolveChannel('tokopedia', [shopee])).toBe('shopee');
  });

  test('is null when no shop is marked ours', () => {
    expect(resolveChannel('shopee', [])).toBeNull();
  });
});

describe('channelShop', () => {
  test('returns the shop the channel belongs to', () => {
    expect(channelShop('tokopedia', both)?.username).toBe('i-bricks');
  });

  test('is null for no channel', () => {
    expect(channelShop(null, both)).toBeNull();
  });
});

describe('withChannel', () => {
  test('adds the parameter to a bare href', () => {
    expect(withChannel('/pricing', 'tokopedia')).toBe('/pricing?kanal=tokopedia');
  });

  test('keeps the query a link already carries', () => {
    expect(withChannel('/pricing?stance=over', 'shopee')).toBe('/pricing?stance=over&kanal=shopee');
  });

  test('replaces a channel already present rather than repeating it', () => {
    expect(withChannel('/pricing?kanal=shopee', 'tokopedia')).toBe('/pricing?kanal=tokopedia');
  });

  test('leaves the href alone when there is no channel', () => {
    expect(withChannel('/pricing', null)).toBe('/pricing');
  });

  test('names the parameter the rest of the app names', () => {
    expect(CHANNEL_PARAM).toBe('kanal');
  });
});

describe('channelFromParams', () => {
  test('takes the first value when the query key repeats', () => {
    expect(channelFromParams({ kanal: ['tokopedia', 'shopee'] }, both)).toBe('tokopedia');
  });

  test('behaves like resolveChannel on a single value', () => {
    expect(channelFromParams({ kanal: 'tokopedia' }, both)).toBe('tokopedia');
    expect(channelFromParams({}, both)).toBe('shopee');
  });
});
