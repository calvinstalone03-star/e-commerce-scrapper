import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';

/**
 * Every route handler is behind the login.
 *
 * The pages are gated by where their files sit — inside the `(app)` route group,
 * whose layout redirects — but route handlers are not in that group and no
 * layout runs for them. Deployed, an unguarded `/api/products` hands the whole
 * scrape to anyone who knows the URL, login screen or not.
 *
 * So this file enumerates the handlers rather than testing the guard in the
 * abstract: a route added next month is only covered once it appears here, and
 * the same list is what a reviewer reads to see what is exposed.
 */

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));

const auth = await import('@/lib/auth');
const MIGRATIONS = join(process.cwd(), '..', 'migrations');

/** Route handlers take a `NextRequest`; the URL only has to parse. */
function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

/** The same, for the one handler here that mutates rather than reads. */
function postRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { method: 'POST' });
}

type Route = {
  path: string;
  call: () => Promise<Response>;
};

const ROUTES: Route[] = [
  {
    path: '/api/products',
    call: async () =>
      (await import('@/app/api/products/route')).GET(request('/api/products')),
  },
  {
    path: '/api/stores',
    call: async () => (await import('@/app/api/stores/route')).GET(request('/api/stores')),
  },
  {
    path: '/api/filter-options',
    call: async () =>
      (await import('@/app/api/filter-options/route')).GET(request('/api/filter-options')),
  },
  {
    path: '/api/products/[id]/history',
    call: async () =>
      (await import('@/app/api/products/[id]/history/route')).GET(
        request('/api/products/1/history'),
        { params: Promise.resolve({ id: '1' }) },
      ),
  },
  {
    // The one handler here that writes. Unguarded it would let anyone who finds
    // the URL clear the owner's unread badge — silently, and only forward.
    path: '/api/notifications/seen',
    call: async () =>
      (await import('@/app/api/notifications/seen/route')).POST(
        postRequest('/api/notifications/seen'),
      ),
  },
];

beforeAll(async () => {
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

beforeEach(async () => {
  jar.clear();
  await sql`DELETE FROM app_credentials`;
});

describe.each(ROUTES)('$path', ({ call }) => {
  test('refuses a request with no session', async () => {
    const response = await call();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  test('refuses a forged session cookie', async () => {
    // Future expiry, right shape, invented signature — the case a cookie
    // carrying only a username would let through.
    jar.set('mcl_session', `${Date.now() + 60_000}.${'0'.repeat(64)}`);
    expect((await call()).status).toBe(401);
  });

  test('never answers 401 from a shared cache', async () => {
    const response = await call();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  test('serves the request once signed in', async () => {
    await auth.createSession();
    expect((await call()).status).toBe(200);
  });
});
