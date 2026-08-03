/**
 * Where the login may send you afterwards.
 *
 * A notification is clicked from a phone, and a phone is where the seven-day
 * session cookie is most likely to have expired. Without this the click lands
 * on `/login` and then on `/`, and the link that named a specific listing is
 * gone.
 *
 * The value comes from a URL, so it is only ever a same-origin path. The two
 * shapes that look relative and are not — `//host` and `/\host`, both of which
 * browsers resolve as protocol-relative — are the whole reason this is a
 * function rather than a `startsWith('/')`.
 *
 * Neither `server-only` nor any import: the client form reads it too.
 */

/** Where `proxy.ts` publishes the requested path for the layout to read. */
export const PATH_HEADER = 'x-ecom-path';

/**
 * A same-origin URL nothing here ever answers to — it exists only to give
 * `URL` a base to resolve a candidate path against, so the final check below
 * can ask a single question: did resolving this change the host?
 */
const SENTINEL = new URL('http://same-origin.invalid');

export function safeNextPath(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value === '') return '/';

  // Percent-encoding can hide a second slash from a naive prefix check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed escape is not a path anyone meant to visit.
    return '/';
  }

  // The URL spec removes every ASCII tab, CR and LF from its input before it
  // looks at scheme or `//` — not just leading/trailing, anywhere in the
  // string. A check that skips this step is validating a different string
  // than the one a browser will actually navigate to: `/\t//evil.example`
  // does not start with `//`, so it sails past that check below, and only
  // reads as protocol-relative once the tab is gone — which, per spec, it
  // always is by the time anything downstream treats this as a URL.
  const stripped = decoded.replace(/[\t\n\r]/g, '');

  // Backslashes are normalised to slashes by browsers, so check both forms.
  const normalised = stripped.replace(/\\/g, '/');

  if (!normalised.startsWith('/')) return '/';
  if (normalised.startsWith('//')) return '/';
  // Sending someone back to the login they just cleared is a loop.
  if (normalised === '/login' || normalised.startsWith('/login?')) return '/';

  // Belt and suspenders: rather than trust the hand-written checks above to
  // have anticipated every shape the platform's own parser normalises, ask
  // that parser directly. Anything that makes the resolved host disagree
  // with the sentinel — or that `URL` refuses to parse at all — is treated
  // the same as every other rejection here.
  let resolved: URL;
  try {
    resolved = new URL(normalised, SENTINEL);
  } catch {
    return '/';
  }
  if (resolved.host !== SENTINEL.host) return '/';

  return normalised;
}
