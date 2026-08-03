import type { NextRequest } from 'next/server';

import { resolveSettings, runNotify, secretMatches, type NotifyEnv } from '@/lib/notify/run';

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

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(request: NextRequest): Promise<Response> {
  let settings;
  try {
    // The cast is required, not decorative: `NotifyEnv`'s keys don't appear on
    // `ProcessEnv` itself (only through its index signature), so plain
    // assignment trips TypeScript's weak-type "no properties in common" check.
    // The cast bypasses only that heuristic — `ProcessEnv`'s index signature
    // already makes every field here a legal string key at runtime.
    settings = resolveSettings(process.env as NotifyEnv);
  } catch (error) {
    // Misconfiguration, not a bad request. The message names the missing
    // variable and nothing else — no values are echoed.
    return Response.json(
      { error: error instanceof Error ? error.message : 'Notifier is not configured.' },
      { status: 500, headers: NO_STORE },
    );
  }

  const header = request.headers.get('authorization');
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!secretMatches(supplied, settings.secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
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
