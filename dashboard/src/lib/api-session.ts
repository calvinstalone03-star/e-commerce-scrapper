import 'server-only';

import type { NextRequest } from 'next/server';

import { isSignedIn } from '@/lib/auth';

/**
 * The login, applied to route handlers.
 *
 * Pages are protected by where their files sit: they are inside the `(app)`
 * route group, and its layout redirects anyone without a session. Route
 * handlers are not in that group and no layout runs for them, so they need the
 * check stated. Wrapping rather than an early return per handler is deliberate —
 * an unwrapped export is visible at a glance, while a forgotten
 * `if (!signedIn)` three lines into a function is not, and `/api/products` is
 * the whole scrape in one response.
 *
 * Not middleware: verifying the cookie means an HMAC against a secret that
 * lives in Postgres, so the check needs `node:crypto` and a database round
 * trip. In middleware that is a query in front of every request the deployment
 * serves, including the ones for static assets.
 */

const UNAUTHORIZED = 'Belum masuk, atau sesi sudah berakhir.';
const UNVERIFIABLE = 'Tidak bisa memverifikasi sesi. Pastikan database bisa dihubungi.';

/** Neither answer may be reused: one is per-session, the other is a transient fault. */
const NO_STORE = { 'Cache-Control': 'private, no-store' };

type Handler<Args extends unknown[]> = (
  request: NextRequest,
  ...args: Args
) => Promise<Response>;

export function withSession<Args extends unknown[]>(handler: Handler<Args>): Handler<Args> {
  return async (request, ...args) => {
    let signedIn: boolean;
    try {
      signedIn = await isSignedIn();
    } catch (error) {
      // The session check reads the credential row, so a database that is down
      // makes "is this request allowed" unanswerable rather than false. 503
      // says so; 401 would blame the user's cookie and send them to a login
      // screen that cannot verify a password either.
      return Response.json(
        {
          error: UNVERIFIABLE,
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 503, headers: NO_STORE },
      );
    }

    if (!signedIn) {
      return Response.json({ error: UNAUTHORIZED }, { status: 401, headers: NO_STORE });
    }

    return handler(request, ...args);
  };
}
