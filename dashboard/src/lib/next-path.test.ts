import { describe, expect, test } from 'vitest';

import { safeNextPath } from '@/lib/next-path';

/**
 * Where the login is allowed to send you afterwards.
 *
 * This value arrives from a URL, so it is attacker-controlled in the only sense
 * that matters: a link in a message. Anything that can leave this origin is an
 * open redirect wearing a convenience feature's clothes.
 */

describe('safeNextPath', () => {
  test('keeps an ordinary in-app path', () => {
    expect(safeNextPath('/pricing/3')).toBe('/pricing/3');
  });

  test('keeps the query string, which is where the channel lives', () => {
    expect(safeNextPath('/pricing?kanal=shopee&q=42218')).toBe('/pricing?kanal=shopee&q=42218');
  });

  test('refuses a protocol-relative path', () => {
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
  });

  // The URL spec strips ASCII tab, CR and LF from anywhere in its input
  // before it ever looks at `//` — so a naive `startsWith('//')` sees
  // `/<tab>//evil.example` as an ordinary relative path, while every browser
  // sees it as protocol-relative the moment the tab is gone.
  test('refuses a protocol-relative path hidden by a control character the URL spec strips', () => {
    expect(safeNextPath('/\t//evil.example')).toBe('/');
    expect(safeNextPath('/\n//evil.example')).toBe('/');
    expect(safeNextPath('/\r//evil.example')).toBe('/');
  });

  test('refuses the same trick with the control character before the leading slash', () => {
    expect(safeNextPath('\t//evil.example')).toBe('/');
  });

  // Doubling the control character does not, by itself, discriminate a
  // stripping regex that lost its `/g` flag: with only that line broken this
  // still comes back `/`, because the same-origin check below independently
  // re-parses whatever survives through the real `URL` constructor, which
  // strips tab/CR/LF itself regardless of what our own regex left behind —
  // verified by breaking each check alone and confirming the other still
  // catches it. Under the correct implementation, this case is actually
  // decided by the `//` check above (full stripping collapses it to
  // `///evil.example` before the same-origin check ever runs); it only goes
  // red when both checks are broken at once, which is what it proves instead:
  // the same-origin check is not dead code, it is an independent layer.
  test('refuses a doubled control character, and stays same-origin when resolved', () => {
    const base = 'https://dashboard.example';
    expect(safeNextPath('/\t\t//evil.example')).toBe('/');
    expect(new URL(safeNextPath('/\t\t//evil.example'), base).origin).toBe(base);
    expect(safeNextPath('/\n\n//evil.example')).toBe('/');
    expect(new URL(safeNextPath('/\n\n//evil.example'), base).origin).toBe(base);
    expect(safeNextPath('/\r\r//evil.example')).toBe('/');
    expect(new URL(safeNextPath('/\r\r//evil.example'), base).origin).toBe(base);
  });

  test('refuses an absolute URL', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('http://evil.example')).toBe('/');
  });

  test('refuses anything that does not start at the root', () => {
    expect(safeNextPath('pricing/3')).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });

  test('refuses the login page itself, which would be a loop', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?changed=1')).toBe('/');
  });

  test('takes the first value when the parameter is repeated', () => {
    expect(safeNextPath(['/pricing/3', '//evil.example'])).toBe('/pricing/3');
  });

  test('refuses a value that decodes into an escape', () => {
    expect(safeNextPath('/%2f%2fevil.example')).toBe('/');
  });
});
