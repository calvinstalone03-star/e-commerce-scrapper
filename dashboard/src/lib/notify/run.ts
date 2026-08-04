import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { sql } from '@/lib/db';
import { collectEvents, hasAny, latestScrapedAt } from '@/lib/notify/events';
import {
  renderDigest,
  renderProductMessage,
  renderStaleWarning,
  splitByOwnSets,
} from '@/lib/notify/format';
import { resolveBaseUrl } from '@/lib/notify/links';
import { ownSetPositions } from '@/lib/notify/positions';
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
  perProductMax: number;
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
  NOTIFY_PER_PRODUCT_MAX?: string;
};

const DEFAULT_MIN_GAP_HOURS = 12;
const DEFAULT_STALE_HOURS = 36;
const STALE_WARNING_COOLDOWN_HOURS = 24;

/**
 * How long this run may take, declared rather than assumed.
 *
 * `route.ts` sets `maxDuration` to this number, and a test holds the two
 * together. Everything else in the notifier that reasons about time — the send
 * pacing, the cap below, the refusal to wait out a long `retry_after` — spends
 * this budget, and until it was declared nothing checked that the total fit.
 *
 * Sixty, because `scripts/notify.sh` documents this deployment as Vercel's
 * Hobby plan, where sixty seconds is the ceiling. The design's own arithmetic
 * assumed 300 — the Pro ceiling — and that is where the cap of 30 came from.
 * On Hobby a 30-message run does not merely run late, it is killed
 * mid-transaction, and a killed run rolls back with the watermark unmoved so
 * the next one rebuilds the same backlog into the same wall.
 *
 * If this deployment is on Pro, raise this to 300 and
 * `NOTIFY_PER_PRODUCT_MAX` to 30 and the design's numbers are back.
 */
export const FUNCTION_BUDGET_SECONDS = 60;

/**
 * How many changes may get a message of their own in one run.
 *
 * Ten, which is what `FUNCTION_BUDGET_SECONDS` pays for. Telegram allows about
 * 20 messages a minute to one group, so `SEND_INTERVAL_MS` spaces them three
 * seconds apart: ten per-product messages plus at most `MAX_MESSAGES` (4) of
 * digest is 14 messages, 39 seconds of pacing, plus the requests themselves
 * and the queries either side. That fits sixty seconds; the design's 30 does
 * not, and would need the 300 it was costed against.
 *
 * Raising it via `NOTIFY_PER_PRODUCT_MAX` is supported and is the right move
 * the moment the budget above allows it — but the consequence has to be
 * legible: the higher it goes the longer the transaction holds the watermark
 * lock, and passing the function's limit means the transaction is rolled back,
 * the watermark does not move, and the next run queues the same backlog only
 * longer. That is a jam that does not clear itself.
 *
 * What is lost meanwhile is only how many changes get their own message. The
 * rest are not dropped: they spill into the digest, which says how many.
 */
export const DEFAULT_PER_PRODUCT_MAX = 10;

function required(env: NotifyEnv, name: keyof NotifyEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. The notifier cannot run without it.`);
  }
  return value;
}

/**
 * A whole, non-negative number — or the documented default.
 *
 * Used for the two hour settings and for the per-product cap. One parser, not
 * three: the defect it guards against is a property of the environment, not of
 * any one variable, and `NOTIFY_PER_PRODUCT_MAX=` read as a cap of zero would
 * send every per-product message back into the digest — the feature switched
 * off by the variable that exists to size it.
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
function wholeNumber(raw: string | undefined, fallback: number): number {
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
    minGapHours: wholeNumber(env.NOTIFY_MIN_GAP_HOURS, DEFAULT_MIN_GAP_HOURS),
    staleHours: wholeNumber(env.NOTIFY_STALE_HOURS, DEFAULT_STALE_HOURS),
    perProductMax: wholeNumber(env.NOTIFY_PER_PRODUCT_MAX, DEFAULT_PER_PRODUCT_MAX),
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
  /** How many of those changes got a message of their own. */
  perProduct: number;
  newStores: number;
  newProducts: number;
  stale: boolean;
};

/**
 * Read, send, advance — in one transaction.
 *
 * The transaction spans the Telegram calls, which the scraper's own doctrine
 * warns against (`runner.py:976`). Holding it is what makes the `FOR UPDATE` on
 * the watermark row mean anything — release it before sending and two
 * concurrent triggers both send.
 *
 * What it costs has grown, and is worth stating plainly rather than leaving as
 * the single 10-second POST this comment used to describe. A run is now up to
 * `perProductMax` + 4 messages, each request bounded by `postOnce`'s 10-second
 * abort and separated by `SEND_INTERVAL_MS` so the burst does not become its
 * own 429. At the defaults that is 34 messages and 99 seconds of pacing — the
 * ~1.7 minutes the design costed when it chose 30 — against a 300-second
 * function limit. The lock is held for all of it. Raising
 * `NOTIFY_PER_PRODUCT_MAX` spends that margin, and running out of it means a
 * rollback with the watermark unmoved and a longer backlog next run.
 *
 * The order is deliberate: send first, advance second. A crash between them
 * re-sends next run; the reverse would lose the digest silently.
 */
export async function runNotify(options: {
  settings: NotifySettings;
  now: Date;
  fetchImpl?: typeof fetch;
  /** Injected by tests so the send pacing does not cost them real seconds. */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<NotifyOutcome> {
  const { settings, now, fetchImpl, sleepImpl } = options;

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
      // Read once for the whole run: the map's keys are the membership the
      // split filters on, and its values are the position each per-product
      // message states. Asking per change would be the 9.5ms x 77 this query
      // exists to avoid.
      const positions = await ownSetPositions(tx);
      const { perProduct, rest } = splitByOwnSets(
        events.priceChanges,
        new Set(positions.keys()),
      );

      // Ordered by proportional move, so the cap keeps the changes that most
      // demand a decision and spills the rest — into the digest, never away.
      const taken = perProduct.slice(0, settings.perProductMax);
      const spilled = perProduct.slice(settings.perProductMax);

      const productMessages = taken.map((change) =>
        renderProductMessage(
          change,
          change.setCode === null ? undefined : positions.get(change.setCode),
          { baseUrl: settings.baseUrl },
        ),
      );

      const digest = renderDigest(
        { ...events, priceChanges: [...rest, ...spilled] },
        { baseUrl: settings.baseUrl, now, spilled: spilled.length },
      );

      // One call, per-product first: if the cap bit, the most significant moves
      // are the ones already delivered when a rejection ends the run.
      const sent = await sendMessages([...productMessages, ...digest], {
        botToken: settings.botToken,
        chatId: settings.chatId,
        fetchImpl,
        sleepImpl,
      });
      await advanceWatermark(tx, ceilings);
      return { sent, ...counts, perProduct: taken.length, stale: false };
    }

    // Nothing happened. Before accepting that as the answer, check whether this
    // database is being written to at all.
    const latest = await latestScrapedAt(tx);
    const ageHours = latest === null ? Infinity : (now.getTime() - latest.getTime()) / 3_600_000;

    if (ageHours < settings.staleHours) {
      // Genuinely quiet. Advance anyway so the rows examined this run are not
      // re-examined next run.
      await advanceWatermark(tx, ceilings);
      return { sent: 0, ...counts, perProduct: 0, stale: false };
    }

    const warnedAgoHours =
      watermark.lastStaleWarningAt === null
        ? Infinity
        : (now.getTime() - watermark.lastStaleWarningAt.getTime()) / 3_600_000;

    if (warnedAgoHours < STALE_WARNING_COOLDOWN_HOURS) {
      // Already warned recently. A database frozen for a fortnight must not
      // become the source of its own spam.
      return { sent: 0, ...counts, perProduct: 0, stale: true };
    }

    const sent = await sendMessages([renderStaleWarning({ latest, hours: ageHours })], {
      botToken: settings.botToken,
      chatId: settings.chatId,
      fetchImpl,
      sleepImpl,
    });
    await stampStaleWarning(tx, now);
    // The watermark deliberately does not move: there was nothing to report,
    // and moving it would hide the gap if the database starts moving again.
    return { sent, ...counts, perProduct: 0, stale: true };
  });
}
