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

  // Backslashes are normalised to slashes by browsers, so check both forms.
  const normalised = decoded.replace(/\\/g, '/');

  if (!normalised.startsWith('/')) return '/';
  if (normalised.startsWith('//')) return '/';
  // Sending someone back to the login they just cleared is a loop.
  if (normalised === '/login' || normalised.startsWith('/login?')) return '/';

  return normalised;
}
