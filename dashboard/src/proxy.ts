import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { PATH_HEADER } from '@/lib/next-path';

/**
 * Publishes the requested path as a request header.
 *
 * App Router layouts do not receive a pathname, and `(app)/layout.tsx` is where
 * the redirect to `/login` happens — so without this the layout cannot say
 * where the visitor was trying to go.
 *
 * Note what this deliberately does **not** do: any session check.
 * `lib/api-session.ts` explains why the login is verified per-route rather than
 * in middleware — verifying the cookie means an HMAC against a secret held in
 * Postgres, and putting that in front of every request means a database round
 * trip for every static asset too. This sets one header from data already in
 * the request. No crypto, no database, no await.
 *
 * Middleware is called Proxy as of Next.js 16; the file name and the export
 * follow that.
 */

export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next's own assets.
  //
  // `api/notify` used to be excluded here as well — the notifier's trigger was
  // machine-to-machine and had no use for a path header. That route is gone,
  // and the exclusion goes with it rather than sitting here waiting for a path
  // of that name to be reintroduced and silently skip this proxy.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
