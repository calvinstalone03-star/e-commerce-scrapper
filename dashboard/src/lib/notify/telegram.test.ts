import { describe, expect, test, vi } from 'vitest';

import { sendMessages } from '@/lib/notify/telegram';

/**
 * The Bot API call.
 *
 * Two things matter and neither is the happy path: that a failure stops the
 * run rather than being swallowed (the watermark must not advance past a
 * message nobody received), and that the bot token never appears in an error.
 */

const config = (fetchImpl: typeof fetch) => ({
  botToken: 'SECRET-TOKEN',
  chatId: '12345',
  fetchImpl,
  timeoutMs: 1000,
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
});
