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
};

const DEFAULT_TIMEOUT_MS = 10_000;

type TelegramResponse = {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
};

async function readBody(response: Response): Promise<TelegramResponse> {
  try {
    return (await response.json()) as TelegramResponse;
  } catch {
    // Telegram answers JSON, but a proxy or a gateway error may not.
    return {};
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

  const response = await fetchImpl(
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

  const body = await readBody(response);
  if (response.ok && body.ok !== false) return { ok: true };

  return {
    ok: false,
    description: body.description ?? `HTTP ${response.status}`,
    retryAfter: body.parameters?.retry_after ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send every message in order.
 *
 * @returns how many were delivered.
 * @throws if any message fails, after one retry for a rate limit. The error
 *   text carries Telegram's own description and never the bot token — errors in
 *   this project have a habit of ending up persisted.
 */
export async function sendMessages(messages: string[], config: TelegramConfig): Promise<number> {
  let sent = 0;

  for (const message of messages) {
    let attempt = await postOnce(message, config);

    if (!attempt.ok && attempt.retryAfter !== null) {
      await sleep(attempt.retryAfter * 1000);
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
