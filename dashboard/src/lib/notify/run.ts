import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { sql } from '@/lib/db';
import { collectEvents, hasAny, latestScrapedAt } from '@/lib/notify/events';
import { renderDigest, renderStaleWarning } from '@/lib/notify/format';
import { resolveBaseUrl } from '@/lib/notify/links';
import { sendMessages } from '@/lib/notify/telegram';
import {
  advanceWatermark,
  readCeilings,
  readWatermarkForUpdate,
  stampStaleWarning,
} from '@/lib/notify/watermark';

/**
 * One notification run, and the settings it needs.
 *
 * `resolveSettings` mirrors `resolveConnectionString` in `db.ts`: it takes the
 * environment as an argument rather than reading it, so it is testable, and it
 * refuses to start rather than degrading — a notifier missing its chat id
 * should say so once, not send successfully into nowhere.
 */

export type NotifySettings = {
  botToken: string;
  chatId: string;
  secret: string;
  baseUrl: string;
  minGapHours: number;
  staleHours: number;
};

/**
 * The slice of the environment this module reads.
 *
 * Mirrors `db.ts`'s local `Env` type rather than `NodeJS.ProcessEnv`, and for the
 * same reason: a narrow, all-optional structural type is callable with a bare
 * object literal in a test, no cast required. `NodeJS.ProcessEnv` does not have
 * that property here — Next 16 augments it with a required `NODE_ENV` field
 * (`next/types/global.d.ts`), so a literal missing that key fails to convert to
 * it.
 *
 * The real `process.env` is a legal value at runtime — every field below is a
 * plain string key, and `ProcessEnv`'s own index signature covers it — but it
 * still needs a cast at the one real call site (`route.ts`). None of these keys
 * are declared directly on `ProcessEnv` itself, so TypeScript's "weak type" check
 * (which looks only at declared properties, not index signatures, when the
 * target's fields are all optional) sees no property in common and refuses plain
 * assignment. `db.ts`'s `Env` avoids this by coincidence — `NODE_ENV` is one of
 * its own fields and also the one property Next adds to `ProcessEnv` directly.
 */
export type NotifyEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  NOTIFY_SECRET?: string;
  NOTIFY_BASE_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  NOTIFY_MIN_GAP_HOURS?: string;
  NOTIFY_STALE_HOURS?: string;
};

const DEFAULT_MIN_GAP_HOURS = 12;
const DEFAULT_STALE_HOURS = 36;
const STALE_WARNING_COOLDOWN_HOURS = 24;

function required(env: NotifyEnv, name: keyof NotifyEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. The notifier cannot run without it.`);
  }
  return value;
}

/**
 * A whole, non-negative number of hours — or the documented default.
 *
 * The blankness check has to come before `Number()`, not be folded into the
 * condition after it: `Number('')` is `0`, and `Number('   ')` is `0` too. Both
 * are finite and non-negative, so a "covers everything in one condition" test
 * accepts them silently. A key present with an empty value is the ordinary
 * shape of a half-finished Vercel environment variable, and the two ways it
 * lands here are both quiet disasters — `NOTIFY_MIN_GAP_HOURS=` would set the
 * gap to zero and switch off the rule the whole feature is built on, and
 * `NOTIFY_STALE_HOURS=` would make `ageHours < 0` false for every quiet run, so
 * a healthy database gets a daily "Data tidak bergerak" and stops advancing its
 * watermark on quiet runs.
 *
 * Whole numbers only, because `make_interval(hours => $)` takes an `int`
 * (events.ts:133) and Postgres answers `1.5` with `22P02` — every run fails,
 * not just an edge case. A fraction falls back rather than being floored: the
 * floor of anything under 1 is 0, which is the same silent disabling as the
 * blank case, and someone who typed a fraction is better served by the
 * documented default than by a rule they did not ask for and cannot see.
 */
function wholeHours(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The one setting the 401 needs, resolvable on its own.
 *
 * Split out so `route.ts` can check the bearer token before resolving anything
 * else — see the ordering note there.
 */
export function resolveSecret(env: NotifyEnv): string {
  return required(env, 'NOTIFY_SECRET');
}

export function resolveSettings(env: NotifyEnv): NotifySettings {
  return {
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    chatId: required(env, 'TELEGRAM_CHAT_ID'),
    secret: resolveSecret(env),
    baseUrl: resolveBaseUrl({
      NOTIFY_BASE_URL: env.NOTIFY_BASE_URL,
      VERCEL_PROJECT_PRODUCTION_URL: env.VERCEL_PROJECT_PRODUCTION_URL,
    }),
    minGapHours: wholeHours(env.NOTIFY_MIN_GAP_HOURS, DEFAULT_MIN_GAP_HOURS),
    staleHours: wholeHours(env.NOTIFY_STALE_HOURS, DEFAULT_STALE_HOURS),
  };
}

/**
 * Compare a bearer token without leaking its length or contents through timing.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees 32 bytes: it
 * throws on a length mismatch, and that throw is itself an oracle for the
 * secret's length.
 */
export function secretMatches(supplied: string | null | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export type NotifyOutcome = {
  sent: number;
  priceChanges: number;
  newStores: number;
  newProducts: number;
  stale: boolean;
};

/**
 * Read, send, advance — in one transaction.
 *
 * The transaction spans the Telegram call, which the scraper's own doctrine
 * warns against (`runner.py:976`). The difference is duration: that warning is
 * about a fetch measured in minutes, this is one POST bounded by a 10-second
 * abort. Holding it is what makes the `FOR UPDATE` on the watermark row mean
 * anything — release it before sending and two concurrent triggers both send.
 *
 * The order is deliberate: send first, advance second. A crash between them
 * re-sends next run; the reverse would lose the digest silently.
 */
export async function runNotify(options: {
  settings: NotifySettings;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<NotifyOutcome> {
  const { settings, now, fetchImpl } = options;

  return sql.begin(async (tx) => {
    const watermark = await readWatermarkForUpdate(tx);
    const ceilings = await readCeilings(tx);
    const events = await collectEvents(tx, watermark, ceilings, settings.minGapHours);

    const counts = {
      priceChanges: events.priceChanges.length,
      newStores: events.newStores.length,
      newProducts: events.newProducts.length,
    };

    if (hasAny(events)) {
      const messages = renderDigest(events, { baseUrl: settings.baseUrl, now });
      const sent = await sendMessages(messages, {
        botToken: settings.botToken,
        chatId: settings.chatId,
        fetchImpl,
      });
      await advanceWatermark(tx, ceilings);
      return { sent, ...counts, stale: false };
    }

    // Nothing happened. Before accepting that as the answer, check whether this
    // database is being written to at all.
    const latest = await latestScrapedAt(tx);
    const ageHours = latest === null ? Infinity : (now.getTime() - latest.getTime()) / 3_600_000;

    if (ageHours < settings.staleHours) {
      // Genuinely quiet. Advance anyway so the rows examined this run are not
      // re-examined next run.
      await advanceWatermark(tx, ceilings);
      return { sent: 0, ...counts, stale: false };
    }

    const warnedAgoHours =
      watermark.lastStaleWarningAt === null
        ? Infinity
        : (now.getTime() - watermark.lastStaleWarningAt.getTime()) / 3_600_000;

    if (warnedAgoHours < STALE_WARNING_COOLDOWN_HOURS) {
      // Already warned recently. A database frozen for a fortnight must not
      // become the source of its own spam.
      return { sent: 0, ...counts, stale: true };
    }

    const sent = await sendMessages([renderStaleWarning({ latest, hours: ageHours })], {
      botToken: settings.botToken,
      chatId: settings.chatId,
      fetchImpl,
    });
    await stampStaleWarning(tx, now);
    // The watermark deliberately does not move: there was nothing to report,
    // and moving it would hide the gap if the database starts moving again.
    return { sent, ...counts, stale: true };
  });
}
