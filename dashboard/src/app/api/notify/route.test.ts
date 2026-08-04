import { NextRequest } from 'next/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { POST, maxDuration } from '@/app/api/notify/route';
import { FUNCTION_BUDGET_SECONDS } from '@/lib/notify/run';

/**
 * What the trigger tells a caller who has not proved who it is.
 *
 * This route is the one handler not behind `withSession` — its caller is the
 * scraping laptop's cron, with a bearer token and no cookie. So it is also the
 * only one whose 401 path anybody on the internet can reach, and the order it
 * does its work in is therefore part of the guard rather than an implementation
 * detail: resolving the settings before checking the token turns every missing
 * environment variable into a 500 that names it.
 */

/** A half-configured deployment: the secret is set, nothing else is. */
function halfConfigured(): void {
  vi.stubEnv('NOTIFY_SECRET', 'the-real-secret');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '');
  vi.stubEnv('NOTIFY_BASE_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
}

function post(authorization?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/notify', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the function budget', () => {
  /**
   * Every duration argument in the notifier — the send pacing, the cap on
   * per-product messages, the refusal to wait out a long `retry_after` — is
   * reasoned against how long this function may run. Until now that number was
   * only ever stated in comments, so nothing checked it and nothing enforced
   * it: unconfigured, the platform picks, and the run is killed mid-transaction
   * if it picks lower than the comments assumed.
   */
  test('is declared on the route, not assumed by the code that spends it', () => {
    expect(maxDuration).toBe(FUNCTION_BUDGET_SECONDS);
  });
});

describe('POST /api/notify', () => {
  test('answers an unauthenticated caller 401, not a 500 naming what is unset', async () => {
    halfConfigured();

    const response = await POST(post());

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.not.toContain('TELEGRAM_BOT_TOKEN');
  });

  test('says nothing more to a caller with the wrong token', async () => {
    halfConfigured();

    const response = await POST(post('Bearer not-the-secret'));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.not.toMatch(/TELEGRAM|NOTIFY_BASE_URL|VERCEL/);
  });

  test('never lets a 401 into a shared cache', async () => {
    halfConfigured();
    expect((await POST(post())).headers.get('Cache-Control')).toContain('no-store');
  });

  /**
   * The diagnostic is not lost, only moved behind the token: the operator runs
   * this with the secret, and a run that cannot start still has to say why.
   */
  test('names the missing variable once the caller has proved who it is', async () => {
    halfConfigured();

    const response = await POST(post('Bearer the-real-secret'));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('TELEGRAM_BOT_TOKEN');
  });

  test('reports its own missing secret, since without it nobody can ever authorise', async () => {
    vi.stubEnv('NOTIFY_SECRET', '');

    const response = await POST(post());

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('NOTIFY_SECRET');
  });
});
