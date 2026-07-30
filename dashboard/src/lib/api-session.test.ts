import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The guard itself, with its one dependency replaced.
 *
 * `require-session.test.ts` proves the real routes are wrapped, against a real
 * Postgres. This file covers what that one cannot reach: what the wrapper does
 * when the session check throws. That only happens when the database is
 * unreachable, and the answer matters — a 401 would tell the user their session
 * expired and send them to a login page that cannot verify a password either.
 */

const isSignedIn = vi.fn<() => Promise<boolean>>();

vi.mock('@/lib/auth', () => ({ isSignedIn: () => isSignedIn() }));

const { withSession } = await import('@/lib/api-session');

const handler = vi.fn(async () => Response.json({ rows: [] }));
const guarded = withSession(handler);
const request = () => new Request('http://localhost:3000/api/products') as never;

beforeEach(() => {
  isSignedIn.mockReset();
  handler.mockClear();
});

describe('withSession', () => {
  test('runs the handler for a signed-in request', async () => {
    isSignedIn.mockResolvedValue(true);

    const response = await guarded(request());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  test('never reaches the handler without a session', async () => {
    isSignedIn.mockResolvedValue(false);

    const response = await guarded(request());

    expect(response.status).toBe(401);
    // The point of the guard: no query runs, so no data can leak through a
    // handler that would otherwise have answered.
    expect(handler).not.toHaveBeenCalled();
  });

  test('answers 503 when the session cannot be checked at all', async () => {
    isSignedIn.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));

    const response = await guarded(request());

    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    // A 401 here would blame the user's session for a database that is down.
    await expect(response.json()).resolves.toMatchObject({
      error: expect.any(String),
      detail: expect.stringContaining('ECONNREFUSED'),
    });
  });

  test('passes the route context through untouched', async () => {
    isSignedIn.mockResolvedValue(true);
    const context = { params: Promise.resolve({ id: '985' }) };

    await guarded(request(), context);

    expect(handler).toHaveBeenCalledWith(expect.any(Request), context);
  });
});
