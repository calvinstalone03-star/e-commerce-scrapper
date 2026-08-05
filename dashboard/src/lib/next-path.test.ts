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

  // Doubling the control character no longer discriminates the control-
  // character rule from the `//` rule — since the raw value is what gets
  // returned, a control character anywhere is a rejection on its own and does
  // not have to be shown to collapse into `//` first. What the second assertion
  // in each pair still proves is the property that actually matters, and proves
  // it without depending on which internal check fired: whatever comes back,
  // resolved against a real origin, is still that origin.
  test('refuses a doubled control character, and stays same-origin when resolved', () => {
    const base = 'https://dashboard.example';
    expect(safeNextPath('/\t\t//evil.example')).toBe('/');
    expect(new URL(safeNextPath('/\t\t//evil.example'), base).origin).toBe(base);
    expect(safeNextPath('/\n\n//evil.example')).toBe('/');
    expect(new URL(safeNextPath('/\n\n//evil.example'), base).origin).toBe(base);
    expect(safeNextPath('/\r\r//evil.example')).toBe('/');
    expect(new URL(safeNextPath('/\r\r//evil.example'), base).origin).toBe(base);
  });

  // The percent-encoded forms, which is where the decoded pass earns its keep:
  // nothing in the raw string looks like a control character at all.
  test('refuses a control character that only appears once the value is decoded', () => {
    expect(safeNextPath('/%09//evil.example')).toBe('/');
    expect(safeNextPath('/%0a//evil.example')).toBe('/');
    expect(safeNextPath('/%0d//evil.example')).toBe('/');
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

/**
 * The destination does not survive one call to `safeNextPath` — it survives
 * three, on three different hops, and that is where it used to be destroyed.
 *
 * `layout.tsx` validates the path `proxy.ts` published and encodes it into
 * `?next=`; `login/page.tsx` reads it back (Next has decoded the query
 * parameter by then) and hands it to the form; `signIn` reads it a third time
 * off the POST. While `safeNextPath` returned the decoded form, every hop
 * decoded once more than it encoded, so the escapes were eaten one per hop.
 *
 * This is not a hypothetical shape. The notifier's link for a rival listing
 * with no set number is `/products?q=<listing name>`, and 29 listings in the
 * database carry `&`, `#` or `%` — the exact notification → login →
 * destination path the whole feature was built for.
 */
describe('the destination survives the login round trip', () => {
  const BASE = 'https://dashboard.example';

  /** The three hops, in the order and with the encoding the real ones use. */
  function roundTrip(original: string): string {
    // (app)/layout.tsx:24-25
    const attempted = safeNextPath(original);
    if (attempted === '/') return '/';
    const loginUrl = new URL(`/login?next=${encodeURIComponent(attempted)}`, BASE);

    // login/page.tsx:33 — Next has already decoded the query parameter.
    const fromQuery = safeNextPath(loginUrl.searchParams.get('next'));

    // The hidden field in LoginForm, returned verbatim through the POST, then
    // actions/auth.ts:31.
    const posted = new FormData();
    posted.set('next', fromQuery);
    return safeNextPath(String(posted.get('next') ?? '/'));
  }

  test.each([
    ['a percent that used to make the second decode throw', '/products?q=100%25', '100%'],
    ['an ampersand that used to truncate the search term', '/products?q=A%26B', 'A&B'],
    ['a hash that used to cut the path short', '/products?q=A%23B', 'A#B'],
    ['a plain search term', '/products?q=Rak+Display+Akrilik', 'Rak Display Akrilik'],
  ])('keeps %s', (_name, original, expectedQ) => {
    const final = roundTrip(original);

    // Byte-for-byte what the notification pointed at.
    expect(final).toBe(original);
    // And it still means what it meant: the filter the link exists to apply.
    expect(new URL(final, BASE).searchParams.get('q')).toBe(expectedQ);
  });

  test('keeps the channel and the set code the pricing link carries', () => {
    const original = '/pricing?kanal=shopee&q=42218';
    expect(roundTrip(original)).toBe(original);
  });

  test('still refuses a hostile destination on every hop', () => {
    for (const hostile of ['//evil.example', '/\\evil.example', '/%2f%2fevil.example', 'https://evil.example']) {
      expect(roundTrip(hostile)).toBe('/');
    }
  });
});
