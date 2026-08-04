import { describe, expect, test, vi } from 'vitest';

import { MAX_MESSAGES } from '@/lib/notify/format';
import { DEFAULT_PER_PRODUCT_MAX, FUNCTION_BUDGET_SECONDS } from '@/lib/notify/run';
import { SEND_INTERVAL_MS, sendMessages } from '@/lib/notify/telegram';

/**
 * The Bot API call.
 *
 * Two things matter and neither is the happy path: that a failure stops the
 * run rather than being swallowed (the watermark must not advance past a
 * message nobody received), and that the bot token never appears in an error.
 */

/**
 * Every case here injects a sleep that does not sleep.
 *
 * `sendMessages` paces itself, so without this the suite would spend the real
 * interval between every message it sends — and the pacing is asserted below
 * by what it was *asked* to wait, which is the part that matters anyway.
 */
const config = (fetchImpl: typeof fetch, waits: number[] = []) => ({
  botToken: 'SECRET-TOKEN',
  chatId: '12345',
  fetchImpl,
  timeoutMs: 1000,
  sleepImpl: async (ms: number) => {
    waits.push(ms);
  },
});

const ok = () =>
  new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('sendMessages', () => {
  test('posts each message to sendMessage with HTML parse mode', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    const sent = await sendMessages(['satu', 'dua'], config(fetchImpl));

    expect(sent).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.telegram.org/botSECRET-TOKEN/sendMessage');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      chat_id: '12345',
      text: 'satu',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  /**
   * The per-product stream made this load-bearing.
   *
   * Telegram allows roughly 20 messages a minute to one group. Until this
   * branch the whole run was at most 4 messages (`MAX_MESSAGES`), so a burst
   * could not reach that; now it is `NOTIFY_PER_PRODUCT_MAX` + 4, which is 34
   * by default. Sent flat out that is a near-certain 429, and a group
   * flood-wait is tens of seconds — past `MAX_RETRY_AFTER_SECONDS`, so
   * `sendMessages` abandons the run, the watermark stays put, and the next
   * trigger rebuilds the same 34 messages into the same wall. That is the
   * self-perpetuating jam this module's own comments exist to avoid.
   *
   * The design already assumed this pacing: it sized the cap of 30 by calling
   * 34 messages "~1,7 menit mengirim", which is 34 messages three seconds
   * apart. The number was right; nothing was doing the waiting.
   */
  test('waits between messages so a burst cannot trip the group flood limit', async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;

    await sendMessages(['satu', 'dua', 'tiga'], config(fetchImpl, waits));

    // Between the messages, not before the first: three messages, two waits.
    expect(waits).toEqual([SEND_INTERVAL_MS, SEND_INTERVAL_MS]);
  });

  test('does not wait at all for a single message', async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;

    await sendMessages(['satu'], config(fetchImpl, waits));

    expect(waits).toEqual([]);
  });

  /**
   * The three constants have to be read together or not at all.
   *
   * `DEFAULT_PER_PRODUCT_MAX` + `MAX_MESSAGES` is how many messages a run can
   * send; `SEND_INTERVAL_MS` is what each one costs; `FUNCTION_BUDGET_SECONDS`
   * is what there is to spend. Any one of them can be changed in good faith and
   * leave the run unable to finish — and a run that cannot finish rolls back
   * with the watermark unmoved, so the next one rebuilds the same backlog into
   * the same wall. This is the arithmetic that keeps them honest.
   */
  test('a worst-case run fits the function budget, with room for the requests', () => {
    const messages = DEFAULT_PER_PRODUCT_MAX + MAX_MESSAGES;
    const pacing = (messages - 1) * SEND_INTERVAL_MS;
    // Each request is bounded by postOnce's abort, but the realistic cost is a
    // round trip. Half a second apiece, plus ten seconds for the queries and
    // the transaction either side of the sending.
    const requests = messages * 500;
    const overhead = 10_000;

    expect(pacing + requests + overhead).toBeLessThan(FUNCTION_BUDGET_SECONDS * 1000);
  });

  test('sends nothing and calls nothing for an empty list', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    expect(await sendMessages([], config(fetchImpl))).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('throws on a Telegram-level failure so the watermark cannot advance', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request: can\'t parse entities' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/parse entities/);
  });

  test('never puts the bot token in the error it throws', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toSatisfy(
      (error: Error) => !error.message.includes('SECRET-TOKEN'),
    );
  });

  test('honours retry_after once on a 429, then gives up', async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(Date.now());
      return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/Too Many Requests/);
    // One original attempt plus exactly one retry.
    expect(calls).toHaveLength(2);
  });

  /**
   * The sleep between the two attempts runs inside `sql.begin`, holding
   * `FOR UPDATE` on `notify_watermark`, and no AbortSignal covers it — the
   * timeout in `postOnce` bounds a request, not a wait. Obeying a 42-second
   * `retry_after` is therefore 42 seconds of a serverless function's budget
   * spent holding a lock, and a run killed there rolls back: the watermark
   * stays put and the next run rebuilds the same digest into the same limit.
   * Walking away costs nothing precisely because the watermark did not move.
   */
  test('abandons the run rather than sleeping out a retry_after it cannot afford', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            description: 'Too Many Requests: retry after 42',
            parameters: { retry_after: 42 },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const started = Date.now();
    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/42s/);

    // No retry, and no wait: both would mean the sleep happened.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('still waits out a retry_after short enough to be worth it', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      return ok();
    }) as unknown as typeof fetch;

    expect(await sendMessages(['x'], config(fetchImpl))).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('stops at the first failure rather than sending the rest out of order', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) return new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 });
      return ok();
    }) as unknown as typeof fetch;

    await expect(sendMessages(['a', 'b', 'c'], config(fetchImpl))).rejects.toThrow(/boom/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('never puts the bot token in the error when fetchImpl rejects', async () => {
    const fetchImpl = vi.fn(
      async () => {
        const error = new Error('FetchError: request to https://api.telegram.org/botSECRET-TOKEN/sendMessage failed');
        throw error;
      },
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toSatisfy(
      (error: Error) => !error.message.includes('SECRET-TOKEN'),
    );
  });

  test('rejects on 2xx with non-JSON body (HTML)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html><body>Gateway Error</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/not JSON/);
  });

  test('rejects on 2xx with empty body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/not JSON/);
  });

  test('aborts when AbortSignal.timeout fires', async () => {
    const fetchImpl = vi.fn(
      async (url, init) => {
        // Wait for the abort signal to fire
        await new Promise((resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
          // Fallback in case abort doesn't fire
          setTimeout(() => reject(new Error('timeout did not fire')), 5000);
        });
      },
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], { ...config(fetchImpl), timeoutMs: 50 })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects 200 with {"result":{}} — no ok field', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow();
  });

  test('rejects 200 with {"ok":null}', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow();
  });

  test('rejects 500 with {"error":"Internal Server Error"} and names the status', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/500/);
  });

  test('uses Telegram description when present, even for error status', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/chat not found/);
    await expect(sendMessages(['x'], config(fetchImpl))).rejects.not.toThrow(/500/);
  });

  test('rejects ok:true under error status — status veto', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendMessages(['x'], config(fetchImpl))).rejects.toThrow(/500/);
  });
});
