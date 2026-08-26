import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeEach, describe, expect, test } from 'vitest';

/**
 * The extension's batch queue, exercised without Chrome.
 *
 * `extension/batch.js` is written as a factory over injected dependencies for
 * exactly this reason: the decisions worth pinning down — a failed shop does not
 * end the sweep, a resumed sweep restarts at the shop it was interrupted in, a
 * cancel stops the queue and not just the page — are sequencing decisions, and
 * none of them needs a browser to be wrong.
 *
 * Loaded through `node:vm` because the file is a service-worker script that
 * assigns to `globalThis` rather than a module with exports. That is the shape
 * `importScripts` needs, and re-shaping it for the sake of a test would mean the
 * test no longer covers the file that ships.
 *
 * Skipped where the source is absent — a partial checkout or the deployment,
 * same as `extension-package.test.ts`.
 */

const SOURCE = resolve(__dirname, '../../../extension/batch.js');

type Entry = { marketplace: string; slug: string };

function loadFactory() {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(SOURCE, 'utf8'), sandbox);
  return sandbox.ecomCreateBatchRunner as (deps: Record<string, unknown>) => {
    start: (options: { target: number; shops?: Entry[] }) => Promise<{
      ok: boolean;
      error?: string;
      count?: number;
    }>;
    resume: () => Promise<{ ok: boolean; error?: string; from?: number }>;
    retryFailed: () => Promise<{ ok: boolean; error?: string }>;
    cancel: () => { ok: boolean; error?: string };
    offer: () => Promise<{ index: number; total: number; next: Entry } | null>;
    snapshot: () => {
      running: boolean;
      index: number;
      total: number;
      results: Array<{ slug: string; ok: boolean; unique: number; error: string | null }>;
      failed: number;
      unique: number;
    } | null;
    isRunning: () => boolean;
  };
}

/** A fixed clock, so "older than 12 hours" is a fact rather than a wall-clock race. */
const NOW = 1_760_000_000_000;
const THIRTEEN_HOURS = 13 * 60 * 60 * 1000;

const SHOPS: Entry[] = [
  { marketplace: 'shopee', slug: 'satu' },
  { marketplace: 'shopee', slug: 'dua' },
  { marketplace: 'tokopedia', slug: 'tiga' },
];

/** A finished job the way `background.js` reports one. */
function job(overrides: Record<string, unknown> = {}) {
  return { unique: 10, stored: 4, unchanged: 6, filtered: 0, pagesDone: 2, error: null, ...overrides };
}

type Harness = ReturnType<typeof buildHarness>;

function buildHarness(options: {
  shops?: Entry[];
  fetchError?: string;
  run?: (spec: { slug: string; useResume: boolean }) => Promise<unknown>;
  saved?: Record<string, unknown> | null;
  shopResume?: boolean;
}) {
  const calls: Array<{ slug: string; useResume: boolean; target: number }> = [];
  const saves: Array<Record<string, unknown> | null> = [];
  let stored: Record<string, unknown> | null = options.saved ?? null;
  let cancels = 0;
  let changes = 0;

  const deps = {
    fetchShops: async () =>
      options.fetchError
        ? { ok: false, error: options.fetchError }
        : { ok: true, shops: options.shops ?? SHOPS },
    runShop: async (spec: { slug: string; useResume: boolean; target: number }) => {
      calls.push({ slug: spec.slug, useResume: spec.useResume, target: spec.target });
      return options.run ? await options.run(spec) : job();
    },
    cancelShop: () => {
      cancels += 1;
    },
    saveState: async (state: Record<string, unknown> | null) => {
      saves.push(state);
      stored = state;
    },
    loadState: async () => stored,
    hasShopResume: () => Boolean(options.shopResume),
    onChange: () => {
      changes += 1;
    },
    sleep: async () => {},
    now: () => NOW,
    gapMs: 0,
    jitterMs: 0,
  };

  return {
    runner: loadFactory()(deps),
    calls,
    saves,
    cancels: () => cancels,
    changes: () => changes,
    storedState: () => stored,
  };
}

/** Let the queue's floating promise chain drain. */
async function settle() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe.runIf(existsSync(SOURCE))('extension batch queue', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness({});
  });

  test('walks every shop on the list, in file order', async () => {
    await harness.runner.start({ target: 100 });
    await settle();

    expect(harness.calls.map((call) => call.slug)).toEqual(['satu', 'dua', 'tiga']);
    expect(harness.runner.snapshot()?.running).toBe(false);
  });

  test('passes the one target to every shop', async () => {
    await harness.runner.start({ target: 250 });
    await settle();

    expect(harness.calls.every((call) => call.target === 250)).toBe(true);
  });

  test('a failed shop is recorded and the sweep goes on', async () => {
    // The decision this whole queue exists to make: one bad slug costs one shop.
    const failing = buildHarness({
      run: async ({ slug }) =>
        slug === 'dua' ? job({ error: 'toko "dua" tidak ditemukan', unique: 0 }) : job(),
    });

    await failing.runner.start({ target: 100 });
    await settle();

    const snapshot = failing.runner.snapshot()!;
    expect(failing.calls.map((call) => call.slug)).toEqual(['satu', 'dua', 'tiga']);
    expect(snapshot.results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.results[1].error).toBe('toko "dua" tidak ditemukan');
  });

  test('a shop that throws is a failure, not a crashed sweep', async () => {
    // `runShop` reaching Chrome means it can reject rather than resolve — a tab
    // closed mid-run does exactly that.
    const throwing = buildHarness({
      run: async ({ slug }) => {
        if (slug === 'satu') throw new Error('tab ditutup');
        return job();
      },
    });

    await throwing.runner.start({ target: 100 });
    await settle();

    expect(throwing.calls).toHaveLength(3);
    expect(throwing.runner.snapshot()?.results[0]).toMatchObject({
      ok: false,
      error: 'tab ditutup',
    });
  });

  test('totals across the sweep are summed, not the last shop only', async () => {
    await harness.runner.start({ target: 100 });
    await settle();

    expect(harness.runner.snapshot()?.unique).toBe(30);
  });

  test('an empty list is refused with the fix in the message', async () => {
    const empty = buildHarness({ shops: [] });

    const answer = await empty.runner.start({ target: 100 });

    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('stores.txt');
    expect(empty.calls).toHaveLength(0);
  });

  test('a server that cannot answer stops the start, and says why', async () => {
    const broken = buildHarness({ fetchError: 'server ingest tidak menjawab' });

    const answer = await broken.runner.start({ target: 100 });

    expect(answer).toEqual({ ok: false, error: 'server ingest tidak menjawab' });
  });

  test('the place is saved before a shop starts, so an eviction resumes at it', async () => {
    // Saving only on completion would resume at the *next* shop and lose the
    // half-walked one, which is the case this is here to prevent.
    const indices: number[] = [];
    const watching = buildHarness({
      run: async () => {
        indices.push((watching.storedState() as { index: number }).index);
        return job();
      },
    });

    await watching.runner.start({ target: 100 });
    await settle();

    expect(indices).toEqual([0, 1, 2]);
  });

  test('a finished sweep clears its saved place', async () => {
    await harness.runner.start({ target: 100 });
    await settle();

    expect(harness.storedState()).toBeNull();
  });

  test('cancel stops the queue and the shop in flight', async () => {
    const slow = buildHarness({
      run: async ({ slug }) => {
        if (slug === 'satu') slow.runner.cancel();
        return job();
      },
    });

    await slow.runner.start({ target: 100 });
    await settle();

    expect(slow.calls.map((call) => call.slug)).toEqual(['satu']);
    expect(slow.cancels()).toBe(1);
    expect(slow.runner.isRunning()).toBe(false);
  });

  test('a cancelled sweep keeps its place so it can be continued', async () => {
    const slow = buildHarness({
      run: async ({ slug }) => {
        if (slug === 'satu') slow.runner.cancel();
        return job();
      },
    });

    await slow.runner.start({ target: 100 });
    await settle();

    expect(slow.storedState()).toMatchObject({ index: 1 });
  });

  test('resume continues at the interrupted shop, not the one after it', async () => {
    const saved = {
      shops: SHOPS,
      index: 1,
      target: 100,
      results: [{ marketplace: 'shopee', slug: 'satu', ok: true, unique: 10 }],
      savedAt: NOW,
    };
    const continuing = buildHarness({ saved, shopResume: true });

    const answer = await continuing.runner.resume();
    await settle();

    expect(answer).toMatchObject({ ok: true, from: 1 });
    expect(continuing.calls.map((call) => call.slug)).toEqual(['dua', 'tiga']);
  });

  test('only the first shop of a resumed sweep re-uses the mid-shop place', async () => {
    // The saved page belongs to the shop that was interrupted. Handing it to the
    // next shop would resume its walk at a page of a different storefront.
    const continuing = buildHarness({
      saved: { shops: SHOPS, index: 0, target: 100, results: [], savedAt: NOW },
      shopResume: true,
    });

    await continuing.runner.resume();
    await settle();

    expect(continuing.calls.map((call) => call.useResume)).toEqual([true, false, false]);
  });

  test('a fresh sweep never re-uses a mid-shop place', async () => {
    const fresh = buildHarness({ shopResume: true });

    await fresh.runner.start({ target: 100 });
    await settle();

    expect(fresh.calls.every((call) => call.useResume === false)).toBe(true);
  });

  test('a stale saved sweep is dropped rather than offered', async () => {
    const stale = buildHarness({
      saved: { shops: SHOPS, index: 1, target: 100, results: [], savedAt: NOW - THIRTEEN_HOURS },
    });

    expect(await stale.runner.offer()).toBeNull();
    expect(await stale.runner.resume()).toMatchObject({ ok: false });
  });

  test('a completed saved sweep is not offered', async () => {
    const done = buildHarness({
      saved: { shops: SHOPS, index: 3, target: 100, results: [], savedAt: NOW },
    });

    expect(await done.runner.offer()).toBeNull();
  });

  test('the offer names the shop that comes next', async () => {
    const waiting = buildHarness({
      saved: { shops: SHOPS, index: 2, target: 100, results: [], savedAt: NOW },
    });

    expect(await waiting.runner.offer()).toMatchObject({
      index: 2,
      total: 3,
      next: { marketplace: 'tokopedia', slug: 'tiga' },
    });
  });

  test('retry re-runs only the shops that failed', async () => {
    const mixed = buildHarness({
      run: async ({ slug }) => (slug === 'dua' ? job({ error: 'gagal' }) : job()),
    });
    await mixed.runner.start({ target: 100 });
    await settle();
    mixed.calls.length = 0;

    const answer = await mixed.runner.retryFailed();
    await settle();

    expect(answer.ok).toBe(true);
    expect(mixed.calls.map((call) => call.slug)).toEqual(['dua']);
  });

  test('retry with nothing failed is refused rather than re-running everything', async () => {
    await harness.runner.start({ target: 100 });
    await settle();

    expect(await harness.runner.retryFailed()).toMatchObject({ ok: false });
  });

  test('a second start while one is running is refused', async () => {
    const slow = buildHarness({
      run: async () => {
        await new Promise((done) => setTimeout(done, 5));
        return job();
      },
    });

    const first = slow.runner.start({ target: 100 });
    const second = await slow.runner.start({ target: 100 });
    await first;
    await settle();

    expect(second).toMatchObject({ ok: false });
  });
});
