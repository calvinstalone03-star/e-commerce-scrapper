/**
 * The Bot API, over `fetch`.
 *
 * `fetchImpl` is injectable so the tests never touch the network. The default
 * is the platform `fetch`, which on Vercel is Undici.
 *
 * The whole contract is: either every message went out, or this throws. The
 * caller advances the watermark only on success, so a half-sent digest is
 * re-sent in full next run. Duplicates are recoverable by a human reading them
 * twice; a silently dropped price change is not.
 */

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for the same reason as `fetchImpl`: tests must not really wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  intervalMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

type TelegramResponse = {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
};

type ParseBodyResult =
  | { parsed: true; ok: true }
  | { parsed: true; ok: false; description: string; retryAfter: number | null }
  | { parsed: false };

async function readBody(response: Response): Promise<ParseBodyResult> {
  try {
    const body = (await response.json()) as TelegramResponse;
    if (body.ok === true) {
      return { parsed: true, ok: true };
    }
    return {
      parsed: true,
      ok: false,
      description: body.description ?? `HTTP ${response.status}`,
      retryAfter: body.parameters?.retry_after ?? null,
    };
  } catch {
    // Telegram answers JSON, but a proxy or a gateway error may not.
    return { parsed: false };
  }
}

async function postOnce(
  message: string,
  config: TelegramConfig,
): Promise<{ ok: true } | { ok: false; description: string; retryAfter: number | null }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // A hung request would hold the surrounding transaction open, and that
  // transaction holds the watermark row's lock. Bound it.
  const signal = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: message,
          parse_mode: 'HTML',
          // The links point at a login-protected dashboard, so a preview would be
          // a screenshot of the login page under every message.
          disable_web_page_preview: true,
        }),
        signal,
      },
    );
  } catch (error) {
    // fetchImpl may reject with an error that embeds the URL. Never let that
    // error escape with the token in it.
    const errorName = error instanceof Error ? error.name : 'Error';
    return {
      ok: false,
      description: `Telegram request failed before a response arrived (${errorName})`,
      retryAfter: null,
    };
  }

  const body = await readBody(response);

  // 1. Body did not parse.
  if (!body.parsed) {
    // The response was not valid JSON. Telegram always answers JSON, so this
    // is a proxy, gateway, or other non-Telegram failure. Do not advance.
    return {
      ok: false,
      description: `Telegram response was not JSON (HTTP ${response.status})`,
      retryAfter: null,
    };
  }

  // 2. Body parsed and says failure.
  if (!body.ok) {
    return {
      ok: false,
      description: body.description,
      retryAfter: body.retryAfter,
    };
  }

  // 3. Body says success but HTTP status disagrees.
  if (!response.ok) {
    return {
      ok: false,
      description: `HTTP ${response.status}`,
      retryAfter: null,
    };
  }

  // 4. Success.
  return { ok: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The longest 429 this will wait out rather than walk away from.
 *
 * This sleep happens inside `sql.begin`, holding `FOR UPDATE` on
 * `notify_watermark`, and it is covered by no AbortSignal — the timeout in
 * `postOnce` bounds the request, not the wait between requests. Telegram will
 * ask for tens of seconds when a chat is genuinely rate limited, and obeying
 * that is how a run gets killed by the function's time limit mid-transaction:
 * the transaction rolls back, the watermark stays put, and the next run rebuilds
 * the same digest into the same rate limit.
 *
 * Walking away costs nothing, which is the whole reason five seconds is enough.
 * The watermark did not move, so nothing is lost — the next trigger collects
 * exactly the same events, by which time the limit has cleared.
 */
const MAX_RETRY_AFTER_SECONDS = 5;

/**
 * How long to wait between messages, so a run does not become its own 429.
 *
 * Telegram allows roughly 20 messages a minute to one group — three seconds
 * apart. Until the per-product stream existed this did not bind: a whole run
 * was at most `MAX_MESSAGES` (4) messages, and four sent flat out is not a
 * burst. It is now `NOTIFY_PER_PRODUCT_MAX` + 4, which is 34 by default, and
 * 34 messages with no wait between them is a near-certain flood-wait.
 *
 * What makes that specifically bad rather than merely slow is the interaction
 * with `MAX_RETRY_AFTER_SECONDS` above: a group flood-wait is tens of seconds,
 * so the retry is not taken, `sendMessages` throws, the transaction rolls back
 * with the watermark unmoved, and the next trigger rebuilds the same 34
 * messages into the same limit. Nothing about that clears on its own.
 *
 * The design already counted on this pacing — it justified the cap of 30 by
 * calling 34 messages "~1,7 menit mengirim", which is exactly this interval —
 * so this is the wait that number always assumed, not a new cost. At the caps,
 * 33 waits is 99 seconds, inside the 300-second function limit with room for
 * the requests themselves.
 */
export const SEND_INTERVAL_MS = 3_000;

/**
 * Send every message in order.
 *
 * @returns how many were delivered.
 * @throws if any message fails, after one retry for a rate limit short enough
 *   to be worth waiting for. The error text carries Telegram's own description
 *   and never the bot token — errors in this project have a habit of ending up
 *   persisted.
 */
export async function sendMessages(messages: string[], config: TelegramConfig): Promise<number> {
  const pause = config.sleepImpl ?? sleep;
  const interval = config.intervalMs ?? SEND_INTERVAL_MS;
  let sent = 0;

  for (const [index, message] of messages.entries()) {
    // Between messages, never before the first: a run that sends one message
    // should not pay for a limit it cannot reach.
    if (index > 0) await pause(interval);

    let attempt = await postOnce(message, config);

    if (!attempt.ok && attempt.retryAfter !== null) {
      if (attempt.retryAfter > MAX_RETRY_AFTER_SECONDS) {
        throw new Error(
          `Telegram asked for ${attempt.retryAfter}s before message ${sent + 1} of ` +
            `${messages.length}; abandoning the run rather than holding the watermark ` +
            `transaction open that long. The next trigger will pick these up.`,
        );
      }
      await pause(attempt.retryAfter * 1000);
      attempt = await postOnce(message, config);
    }

    if (!attempt.ok) {
      throw new Error(
        `Telegram rejected message ${sent + 1} of ${messages.length}: ${attempt.description}`,
      );
    }

    sent += 1;
  }

  return sent;
}
