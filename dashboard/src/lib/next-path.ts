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
 * **Validates the decoded form, returns the original.** This is the difference
 * between preserving a destination and mangling it, because the value makes
 * three hops: `layout.tsx` puts it in `?next=`, `login/page.tsx` reads it back
 * out (Next has already decoded the query parameter by then), and `signIn`
 * reads it a third time off the submitted form. Returning the decoded form
 * meant each hop decoded once more than it encoded, and the notifier's own
 * rival-without-a-set-code link is `/products?q=<listing name>`:
 * `/products?q=100%25` reached hop two as `/products?q=100%`, where
 * `decodeURIComponent` throws and the destination is lost to `/`, and
 * `/products?q=A%26B` came back as `/products?q=A&B`, silently truncating the
 * search at the ampersand. 29 listings in the database carry `&`, `#` or `%`.
 *
 * Decoding is still exactly where the security is — `/%2f%2fevil.example` is
 * protocol-relative once decoded and nothing else would see it — so both forms
 * are checked and the stricter of the two answers decides. Returning the
 * original can only ever be safer than returning the decoded form: escaping is
 * what makes a character inert to a URL parser, so the original is the more
 * inert of the two strings, and it is checked on its own account regardless.
 *
 * No `server-only`, and nothing imported: this is string work over a value that
 * arrives in a URL, with no database handle, no secret and no `next/headers`
 * anywhere in it, so there is nothing here for that marker to keep out of a
 * client bundle. Nor is its absence a constraint — `proxy.ts` imports
 * `PATH_HEADER` from this file, and adding the marker was tried: it builds, and
 * the emitted middleware bundle carries no trace of it, because `server-only`
 * resolves to an empty module in every layer this file is reached from. If
 * something here ever does become server-side, the marker is available.
 */

/** Where `proxy.ts` publishes the requested path for the layout to read. */
export const PATH_HEADER = 'x-ecom-path';

/**
 * A same-origin URL nothing here ever answers to — it exists only to give
 * `URL` a base to resolve a candidate path against, so the final check below
 * can ask a single question: did resolving this change the host?
 */
const SENTINEL = new URL('http://same-origin.invalid');

/**
 * Is this a path that stays on this origin?
 *
 * Applied to the raw value and to its decoded form both, because each catches
 * what the other cannot: only the decoded form reveals `/%2f%2fevil.example`,
 * and only the raw form is what actually ends up in a `Location` header.
 */
function isSameOriginPath(candidate: string): boolean {
  // The URL spec removes every ASCII tab, CR and LF from its input before it
  // looks at scheme or `//` — not just leading/trailing, anywhere in the
  // string. A check that skipped this would be validating a different string
  // than the one a browser navigates to: `/\t//evil.example` does not start
  // with `//`, so it would sail past the check below, and only reads as
  // protocol-relative once the tab is gone — which, per spec, it always is by
  // the time anything downstream treats this as a URL.
  //
  // Rejected outright rather than stripped, now that the value returned is the
  // one that was checked: no path anyone means to visit contains a raw tab, CR
  // or LF (a real URL carries them percent-encoded, and those are caught on the
  // decoded pass), and stripping would hand back a string that is illegal in a
  // `Location` header anyway. Strictly stricter than stripping — nothing that
  // stripping rejected is accepted here.
  if (/[\t\n\r]/.test(candidate)) return false;

  // Backslashes are normalised to slashes by browsers, so check both forms.
  const normalised = candidate.replace(/\\/g, '/');

  if (!normalised.startsWith('/')) return false;
  if (normalised.startsWith('//')) return false;
  // Sending someone back to the login they just cleared is a loop.
  if (normalised === '/login' || normalised.startsWith('/login?')) return false;

  // Belt and suspenders: rather than trust the hand-written checks above to
  // have anticipated every shape the platform's own parser normalises, ask
  // that parser directly. Anything that makes the resolved host disagree
  // with the sentinel — or that `URL` refuses to parse at all — is treated
  // the same as every other rejection here.
  let resolved: URL;
  try {
    resolved = new URL(normalised, SENTINEL);
  } catch {
    return false;
  }
  return resolved.host === SENTINEL.host;
}

export function safeNextPath(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value === '') return '/';

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed escape is not a path anyone meant to visit.
    return '/';
  }

  if (!isSameOriginPath(value) || !isSameOriginPath(decoded)) return '/';

  return value;
}
