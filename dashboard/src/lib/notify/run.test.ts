import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';
import { resolveSettings, runNotify, secretMatches } from '@/lib/notify/run';
import { readCeilings } from '@/lib/notify/watermark';

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
  perProductMax: 30,
};

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

/**
 * A Telegram that accepts everything and remembers what it was told.
 *
 * The two streams are only distinguishable by what was sent and in what order,
 * so a fetch that merely counts calls cannot tell a per-product message from a
 * digest — and the ordering is the property that matters when the cap bites.
 */
function capturingFetch(): { impl: typeof fetch; texts: string[] } {
  const texts: string[] = [];
  const impl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    texts.push(JSON.parse(String(init?.body)).text);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, texts };
}

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

/** A rival price change on each of these sets, one product apiece. */
async function seedRivalChanges(setCodes: string[]): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})
    ON CONFLICT (id) DO NOTHING`;

  let id = 0;
  for (const setCode of setCodes) {
    id += 1;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, first_seen, last_seen)
      VALUES (${id}, 'shopee', ${100 + id}, 1, ${`LEGO ${setCode}`}, ${setCode}, ${BASE}, ${BASE})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (${id}, 186850, ${BASE})`;
    await sql`
      INSERT INTO price_snapshots (product_ref, price, scraped_at)
      VALUES (${id}, ${150100 + id * 1000}, ${new Date(BASE.getTime() + 24 * HOUR)})`;
  }
}

/** Our own shop, carrying each of these sets at a price of its own. */
async function seedOwnShop(setCodes: string[]): Promise<void> {
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (900, 'shopee', 900, 'i_bricks', true, ${BASE}, ${BASE})`;

  let id = 900;
  for (const setCode of setCodes) {
    id += 1;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, first_seen, last_seen)
      VALUES (${id}, 'shopee', ${id}, 900, ${`Punya kita ${setCode}`}, ${setCode}, ${BASE}, ${BASE})`;
    // One snapshot only: a single price is a position, not a change, so our own
    // listings never become events of their own here.
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (${id}, 165000, ${BASE})`;
  }
}

/**
 * Put every store and product already seeded behind the watermark.
 *
 * Without this the shops and listings a test seeds to create a *price change*
 * arrive as "new store" and "new product" events too, and the digest they
 * produce hides whether the price change went where the test says it did.
 * `last_snapshot_id` is deliberately left alone — the price changes are the
 * point.
 */
async function coverStoresAndProducts(): Promise<void> {
  await sql`
    UPDATE notify_watermark
       SET last_store_id   = (SELECT coalesce(max(id), 0) FROM stores),
           last_product_id = (SELECT coalesce(max(id), 0) FROM products)
     WHERE id = 1`;
}

/**
 * The watermark row, read fresh rather than assumed — the quiet and stale
 * branches are told apart only by whether this changes across a call.
 */
async function readWatermarkRow(): Promise<{
  lastSnapshotId: string;
  lastProductId: number;
  lastStoreId: number;
  lastStaleWarningAt: Date | null;
}> {
  const [row] = await sql`
    SELECT last_snapshot_id, last_product_id, last_store_id, last_stale_warning_at
      FROM notify_watermark
     WHERE id = 1`;
  return {
    lastSnapshotId: String(row.last_snapshot_id),
    lastProductId: row.last_product_id,
    lastStoreId: row.last_store_id,
    lastStaleWarningAt: row.last_stale_warning_at,
  };
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

  /**
   * The shape a half-finished Vercel variable actually has: the key exists, the
   * value was never pasted. `Number('')` and `Number('   ')` are both `0`, which
   * is finite and non-negative, so the condition that rejects `'banyak'` waves
   * these straight through — and a zero here is not a smaller setting, it is the
   * rule switched off. Gap 0 compares a capture against the capture before it,
   * which is exactly the artefact the minimum gap exists to suppress: measured
   * against the live database, 3 real price changes become 40.
   */
  test.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats a %s NOTIFY_MIN_GAP_HOURS as unset rather than as zero', (_name, raw) => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
      NOTIFY_MIN_GAP_HOURS: raw,
    });

    expect(settings.minGapHours).toBe(12);
  });

  /**
   * Same blank, other variable, different disaster: `staleHours` of 0 makes
   * `ageHours < 0` false however fresh the data is, so every quiet run takes the
   * stale branch — a daily "Data tidak bergerak" about a database that is
   * working, and no `advanceWatermark` on quiet runs.
   */
  test.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats a %s NOTIFY_STALE_HOURS as unset rather than as zero', (_name, raw) => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
      NOTIFY_STALE_HOURS: raw,
    });

    expect(settings.staleHours).toBe(36);
  });

  /**
   * `make_interval(hours => $)` takes an `int`. A fraction is not a finer
   * setting, it is `22P02` on every single run — so it falls back, and it falls
   * back rather than flooring because `floor(0.5)` is `0`, the disabled rule
   * again.
   */
  test('falls back rather than sending Postgres a fractional hour', () => {
    const base = {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
    };

    expect(resolveSettings({ ...base, NOTIFY_MIN_GAP_HOURS: '1.5' }).minGapHours).toBe(12);
    expect(resolveSettings({ ...base, NOTIFY_MIN_GAP_HOURS: '0.5' }).minGapHours).toBe(12);
    expect(resolveSettings({ ...base, NOTIFY_STALE_HOURS: '36.5' }).staleHours).toBe(36);
  });

  test('still honours a whole-number override, including a deliberate zero', () => {
    const base = {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
    };

    expect(resolveSettings({ ...base, NOTIFY_MIN_GAP_HOURS: '6' }).minGapHours).toBe(6);
    // Written out, `0` is a choice rather than an accident, and the difference
    // between the two is the whole point of the blankness check above.
    expect(resolveSettings({ ...base, NOTIFY_MIN_GAP_HOURS: '0' }).minGapHours).toBe(0);
  });

  /**
   * The cap gets the same parser, because it has the same blank-string defect
   * waiting for it: `NOTIFY_PER_PRODUCT_MAX=` would be read as a cap of zero,
   * which sends every per-product message back into the digest and silently
   * switches off the feature the variable exists to size.
   */
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a number', 'banyak'],
    ['fractional', '7.5'],
    ['negative', '-1'],
  ])('treats a %s NOTIFY_PER_PRODUCT_MAX as unset', (_name, raw) => {
    const settings = resolveSettings({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
      NOTIFY_PER_PRODUCT_MAX: raw,
    });

    expect(settings.perProductMax).toBe(30);
  });

  test('honours a per-product cap that was actually chosen', () => {
    const base = {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      NOTIFY_SECRET: 'secret',
      NOTIFY_BASE_URL: 'https://x',
    };

    expect(resolveSettings({ ...base, NOTIFY_PER_PRODUCT_MAX: '5' }).perProductMax).toBe(5);
    // Zero written out is a choice: digest only, no per-product messages.
    expect(resolveSettings({ ...base, NOTIFY_PER_PRODUCT_MAX: '0' }).perProductMax).toBe(0);
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
    // Store and product watermark cover what was just seeded, so neither
    // becomes a "new" event. The snapshot watermark is deliberately left
    // behind the ceiling (id 1) instead of pinned to it: a single snapshot has
    // no older predecessor to compare against, so it still produces no
    // price-change event, but "advanced to the ceiling" and "never advanced"
    // stay distinguishable below — pinning to the ceiling would erase that.
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1 WHERE id = 1`;

    const ceilings = await readCeilings(sql);
    const before = await readWatermarkRow();
    expect(before.lastSnapshotId).not.toBe(ceilings.snapshotId);

    const fetchImpl = okFetch();
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome.sent).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Quiet, not stale: the watermark still advances to the ceiling, so the
    // rows just examined are not re-examined next run.
    const after = await readWatermarkRow();
    expect(after.lastSnapshotId).toBe(ceilings.snapshotId);
    expect(after.lastProductId).toBe(ceilings.productId);
    expect(after.lastStoreId).toBe(ceilings.storeId);
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
    // Same reasoning as the quiet-branch test above: the snapshot watermark is
    // left behind the ceiling rather than pinned to it, so "did not advance"
    // is something the assertions below can actually observe.
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1 WHERE id = 1`;

    const before = await readWatermarkRow();

    const fetchImpl = okFetch();
    // NOW is 48h after the only snapshot; the threshold is 36h.
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl });

    expect(outcome.stale).toBe(true);
    expect(outcome.sent).toBe(1);

    const body = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toContain('Data tidak bergerak');

    // Stale: there was nothing to report, so the watermark ids must not move —
    // moving them would hide the gap if the database starts moving again.
    // (`lastStaleWarningAt` is excluded: stamping it is this branch's whole job.)
    const after = await readWatermarkRow();
    expect(after.lastSnapshotId).toBe(before.lastSnapshotId);
    expect(after.lastProductId).toBe(before.lastProductId);
    expect(after.lastStoreId).toBe(before.lastStoreId);
  });

  test('does not repeat the staleness warning within a day', async () => {
    await sql`
      INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
      VALUES (1, 'shopee', 111, 'rival-a', false, ${BASE}, ${BASE})`;
    await sql`
      INSERT INTO products (id, marketplace, item_id, shop_ref, name, first_seen, last_seen)
      VALUES (1, 'shopee', 222, 1, 'LEGO', ${BASE}, ${BASE})`;
    await sql`INSERT INTO price_snapshots (product_ref, price, scraped_at) VALUES (1, 1000, ${BASE})`;
    // Same reasoning as the other two branch tests above: left behind the
    // ceiling so a spurious write on the second call below is observable.
    await sql`UPDATE notify_watermark SET last_store_id = 1, last_product_id = 1 WHERE id = 1`;

    await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });
    const before = await readWatermarkRow();

    const second = okFetch();
    const outcome = await runNotify({
      settings: SETTINGS,
      now: new Date(NOW.getTime() + 2 * HOUR),
      fetchImpl: second,
    });

    expect(outcome.stale).toBe(true);
    expect(outcome.sent).toBe(0);
    expect(second).not.toHaveBeenCalled();

    // Within the cooldown, the second call writes nothing at all — not the
    // watermark ids, and not a fresh stale-warning stamp either.
    const after = await readWatermarkRow();
    expect(after).toEqual(before);
  });
});

describe('runNotify — the two streams', () => {
  test('gives a change on a set we sell a message of its own, not a digest line', async () => {
    await seedRivalChanges(['42218']);
    await seedOwnShop(['42218']);
    await coverStoresAndProducts();
    const telegram = capturingFetch();

    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: telegram.impl });

    expect(outcome).toMatchObject({ priceChanges: 1, perProduct: 1 });
    // One message, and it is the per-product one: `rest` is empty, so there is
    // no digest left to render.
    expect(telegram.texts).toHaveLength(1);
    expect(outcome.sent).toBe(1);
    expect(telegram.texts[0]).toContain('posisi kita di 42218');
    expect(telegram.texts[0]).toContain('i_bricks');
    expect(telegram.texts[0]).not.toContain('📊');
  });

  test('leaves a change on a set we do not sell in the digest', async () => {
    await seedRivalChanges(['42218']);
    await seedOwnShop(['10321']);
    await coverStoresAndProducts();
    const telegram = capturingFetch();

    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: telegram.impl });

    expect(outcome).toMatchObject({ priceChanges: 1, perProduct: 0 });
    expect(telegram.texts).toHaveLength(1);
    // The digest, not a per-product message. "posisi kita di" is no use as the
    // discriminator — it is also the digest's own link label
    // (renderPriceGroup) — so this checks the header and the position block,
    // which only the per-product renderer produces.
    expect(telegram.texts[0].startsWith('<b>📊')).toBe(true);
    expect(telegram.texts[0]).not.toContain('Termurah');
    expect(telegram.texts[0]).not.toContain('belum berharga');
  });

  test('spills past the cap into the digest, and says how many spilled', async () => {
    await seedRivalChanges(['1', '2', '3', '4']);
    await seedOwnShop(['1', '2', '3', '4']);
    await coverStoresAndProducts();
    const telegram = capturingFetch();

    const outcome = await runNotify({
      settings: { ...SETTINGS, perProductMax: 2 },
      now: NOW,
      fetchImpl: telegram.impl,
    });

    expect(outcome).toMatchObject({ priceChanges: 4, perProduct: 2 });
    // Two per-product messages, then one digest carrying the other two.
    expect(telegram.texts).toHaveLength(3);
    expect(telegram.texts[0]).toContain('posisi kita di');
    expect(telegram.texts[1]).toContain('posisi kita di');

    const digest = telegram.texts[2];
    expect(digest).toContain('📊');
    // Named, not merely present: a reader who gets two messages and a digest
    // needs to know the digest is holding the overflow of the same stream.
    expect(digest).toContain('2');
    expect(digest).toMatch(/batas|melewati/i);
  });

  test('sends the most significant moves first when the cap bites', async () => {
    await seedRivalChanges(['1', '2', '3', '4']);
    await seedOwnShop(['1', '2', '3', '4']);
    await coverStoresAndProducts();
    // seedRivalChanges moves each set from 186.850 to 150.100 + 1.000 x n, so
    // set 1 falls furthest and set 4 least. A cap of 1 must keep set 1.
    const telegram = capturingFetch();

    await runNotify({
      settings: { ...SETTINGS, perProductMax: 1 },
      now: NOW,
      fetchImpl: telegram.impl,
    });

    expect(telegram.texts[0]).toContain('posisi kita di 1');
  });

  test('sends no per-product message when the cap is a deliberate zero', async () => {
    await seedRivalChanges(['42218']);
    await seedOwnShop(['42218']);
    await coverStoresAndProducts();
    const telegram = capturingFetch();

    const outcome = await runNotify({
      settings: { ...SETTINGS, perProductMax: 0 },
      now: NOW,
      fetchImpl: telegram.impl,
    });

    expect(outcome.perProduct).toBe(0);
    expect(telegram.texts).toHaveLength(1);
    expect(telegram.texts[0]).toContain('📊');
  });

  test('advances the watermark past both streams together', async () => {
    await seedRivalChanges(['42218', '10321']);
    await seedOwnShop(['42218']);
    await coverStoresAndProducts();
    const ceilings = await readCeilings(sql);

    await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: okFetch() });

    // One event set, one watermark: the split is a rendering decision and must
    // not leave half the changes to be found again next run.
    const after = await readWatermarkRow();
    expect(after.lastSnapshotId).toBe(String(ceilings.snapshotId));

    const second = okFetch();
    const outcome = await runNotify({ settings: SETTINGS, now: NOW, fetchImpl: second });
    expect(outcome.priceChanges).toBe(0);
    expect(second).not.toHaveBeenCalled();
  });

  test('leaves the watermark alone when a per-product message is refused', async () => {
    await seedRivalChanges(['42218']);
    await seedOwnShop(['42218']);
    await coverStoresAndProducts();
    const before = await readWatermarkRow();

    const refuse = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(
      runNotify({ settings: SETTINGS, now: NOW, fetchImpl: refuse }),
    ).rejects.toThrow(/Telegram/);

    // The per-product stream is inside the same transaction as everything else,
    // so a rejection there rolls the watermark back exactly as a digest
    // rejection does — duplicates next run, never a silent loss.
    expect(await readWatermarkRow()).toEqual(before);
  });
});
