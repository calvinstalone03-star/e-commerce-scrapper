import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';
import { resolveSettings, runNotify, secretMatches } from '@/lib/notify/run';

/**
 * The run, end to end against a real database with a fake Telegram.
 *
 * The cases that matter are the transactional ones: a send that fails must
 * leave the watermark where it was, and a second run after a successful one
 * must find nothing.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');
const HOUR = 3600 * 1000;
const BASE = new Date('2026-08-01T00:00:00Z');
const NOW = new Date(BASE.getTime() + 48 * HOUR);

const SETTINGS = {
  botToken: 'T',
  chatId: 'C',
  secret: 'S',
  baseUrl: 'https://dash.example',
  minGapHours: 12,
  staleHours: 36,
};

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

beforeAll(async () => {
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
  await sql`
    UPDATE notify_watermark
       SET last_snapshot_id = 0, last_product_id = 0, last_store_id = 0,
           last_stale_warning_at = NULL
     WHERE id = 1`;
});

async function seedPriceChange(): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, first_seen, last_seen)
    VALUES (1, 'shopee', 222, 1, 'LEGO Technic 42218', '42218', ${BASE}, ${BASE})`;
  await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 186850, ${BASE})`;
  await sql`
    INSERT INTO price_snapshots (product_ref, price, scraped_at)
    VALUES (1, 211850, ${new Date(BASE.getTime() + 24 * HOUR)})`;
  // The store is already known, so this run is about the price, not the shop.
  await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1 WHERE id = 1`;
}

describe('resolveSettings', () => {
  test('reads every variable and applies the documented defaults', () => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://dash.example',
    });

    expect(settings.minGapHours).toBe(12);
    expect(settings.staleHours).toBe(36);
    expect(settings.baseUrl).toBe('https://dash.example');
  });

  test('names the variable that is missing rather than failing vaguely', () => {
    expect(() =>
      resolveSettings({ TELEGRAM_CHAT_ID: 'chat', NOTIFY_SECRET: 'secret' }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  test('rejects a blank secret rather than accepting every caller', () => {
    expect(() =>
      resolveSettings({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: 'chat',
        NOTIFY_SECRET: '   ',
        NOTIFY_BASE_URL: 'https://x',
      }),
    ).toThrow(/NOTIFY_SECRET/);
  });

  test('falls back to a non-negative gap when the override is nonsense', () => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
      NOTIFY_MIN_GAP_HOURS: 'banyak',
    });

    expect(settings.minGapHours).toBe(12);
  });
});

describe('secretMatches', () => {
  test('accepts the exact secret', () => {
    expect(secretMatches('hunter2', 'hunter2')).toBe(true);
  });

  test('rejects a wrong secret, a missing one, and one of a different length', () => {
    expect(secretMatches('nope', 'hunter2')).toBe(false);
    expect(secretMatches(null, 'hunter2')).toBe(false);
    expect(secretMatches('hunter2extra', 'hunter2')).toBe(false);
  });
});

describe('runNotify', () => {
  test('sends the digest and advances past everything it looked at', async () => {
    await seedPriceChange();
    const fetchImpl = okFetch();

    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome).toMatchObject({ priceChanges: 1, newStores: 0, newProducts: 0, stale: false });
    expect(outcome.sent).toBe(1);

    const [row] = await sql`SELECT last_snapshot_id FROM notify_watermark WHERE id = 1`;
    expect(String(row.last_snapshot_id)).toBe('2');
  });

  test('finds nothing on an immediate second run', async () => {
    await seedPriceChange();
    await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });

    const second = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });
    expect(second).toMatchObject({ sent: 0, priceChanges: 0 });
  });

  test('sends nothing when nothing changed', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${NOW}, ${NOW})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${NOW}, ${NOW})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${NOW})`;
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1, last_snapshot_id = 1 WHERE id = 1`;

    const fetchImpl = okFetch();
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome.sent).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('leaves the watermark alone when Telegram refuses', async () => {
    await seedPriceChange();
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(runNotify({ settings: SETTINGS, now: NOW, fetchImpl: failing })).rejects.toThrow(/boom/);

    const [row] = await sql`SELECT last_snapshot_id FROM notify_watermark WHERE id = 1`;
    expect(String(row.last_snapshot_id)).toBe('0');
  });

  test('re-sends the same events after a failure', async () => {
    await seedPriceChange();
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(runNotify({ settings: SETTINGS, now: NOW, fetchImpl: failing })).rejects.toThrow();

    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });
    expect(outcome.priceChanges).toBe(1);
  });

  test('warns instead of staying silent when the data has stopped moving', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${BASE}, ${BASE})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${BASE})`;
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1, last_snapshot_id = 1 WHERE id = 1`;

    const fetchImpl = okFetch();
    // NOW is 48h after the only snapshot; the threshold is 36h.
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome.stale).toBe(true);
    expect(outcome.sent).toBe(1);

    const body = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toContain('Data tidak bergerak');
  });

  test('does not repeat the staleness warning within a day', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${BASE}, ${BASE})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${BASE})`;
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1, last_snapshot_id = 1 WHERE id = 1`;

    await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });

    const second = okFetch();
    const outcome = await runNotify({
      settings: SETTINGS,
      now: new Date(NOW.getTime() + 2 * HOUR),
      fetchImpl: second,
    });

    expect(outcome.stale).toBe(true);
    expect(outcome.sent).toBe(0);
    expect(second).not.toHaveBeenCalled();
  });
});
