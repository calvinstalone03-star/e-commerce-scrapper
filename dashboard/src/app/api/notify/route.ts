import type { NextRequest } from 'next/server';

import {
  resolveSecret,
  resolveSettings,
  runNotify,
  secretMatches,
  type NotifyEnv,
} from '@/lib/notify/run';

/**
 * The notifier's trigger.
 *
 * Machine-to-machine, so it is the one route here that is **not** wrapped in
 * `withSession`: the caller is the scraping laptop's cron, which has no browser
 * cookie. Its own guard is a bearer token, and the absence of `withSession` on
 * this export is deliberate rather than forgotten — see `lib/api-session.ts` for
 * why the wrapper is normally the rule.
 *
 * `POST` only. This advances the watermark, and a GET that mutates is a GET
 * that a link prefetcher eventually fires.
 */

export const dynamic = 'force-dynamic';

/**
 * How long the run is allowed to take.
 *
 * A literal because Next reads this statically, but it is not a free choice:
 * it must equal `FUNCTION_BUDGET_SECONDS` in `lib/notify/run.ts`, which is
 * what the send pacing and the per-product cap are sized against, and
 * `route.test.ts` asserts the two agree. Unset, the platform picks the limit
 * and the notifier's arithmetic is reasoning about a number nobody declared.
 */
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** Misconfiguration, not a bad request. Names the variable, echoes no values. */
function notConfigured(error: unknown): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : 'Notifier is not configured.' },
    { status: 500, headers: NO_STORE },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  // The cast is required, not decorative: `NotifyEnv`'s keys don't appear on
  // `ProcessEnv` itself (only through its index signature), so plain
  // assignment trips TypeScript's weak-type "no properties in common" check.
  // The cast bypasses only that heuristic — `ProcessEnv`'s index signature
  // already makes every field here a legal string key at runtime.
  const env = process.env as NotifyEnv;

  // Authorisation before configuration, and that order is the point. Resolving
  // every setting first means an unauthenticated POST to a half-configured
  // deployment is answered with a 500 naming the variable that is missing —
  // anyone who finds the URL learns which of the notifier's environment
  // variables this deployment does and does not have set, for free.
  //
  // The secret is the one setting the 401 itself needs, so it is the only one
  // resolved this side of the check. Its own absence is still reported, because
  // without it no request can ever authorise and the operator has to be able to
  // see why; every other variable waits until the caller has proved who it is.
  let secret: string;
  try {
    secret = resolveSecret(env);
  } catch (error) {
    return notConfigured(error);
  }

  const header = request.headers.get('authorization');
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!secretMatches(supplied, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  let settings;
  try {
    settings = resolveSettings(env);
  } catch (error) {
    return notConfigured(error);
  }

  try {
    const outcome = await runNotify({ settings, now: new Date() });
    // Counts only. The caller is a cron job with a shell log, not a screen —
    // and product names in a log are one more place for them to leak.
    return Response.json(outcome, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      {
        error: 'Notification run failed.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: NO_STORE },
    );
  }
}
