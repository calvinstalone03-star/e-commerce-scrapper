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
