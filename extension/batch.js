// One click, every shop on the list.
//
// The single-shop run this sits on top of is unchanged: `background.js` still
// owns "walk one storefront, page by page, and file what it reads". This file
// owns only the queue — which shop is next, what happened to the last one, and
// where to pick up when the worker is torn down mid-sweep.
//
// Kept out of `background.js` because that file is already long and its shop
// walk is the most delicate code in the extension. Two nested loops in one file
// is how the inner one stops being readable.
//
// Written as a factory over injected dependencies rather than as code that
// reaches for `chrome.*` directly, so the sequencing — skip a failed shop,
// resume at the right index, stop when cancelled — can be tested in Node
// against fakes. Everything Chrome-shaped is passed in by `background.js`.
//
// Three decisions worth stating, because none of them is the obvious default:
//
//   1. A failed shop does not stop the sweep. Twenty shops with one bad slug
//      should file nineteen shops' products, not zero. Failures are collected
//      and reported at the end, and can be retried as a group.
//   2. The place is saved *before* a shop starts as well as after it ends. An
//      eviction mid-shop then resumes at that shop rather than the next one,
//      and the per-shop resume `background.js` already keeps takes over from
//      there — so an interrupted sweep re-reads at most one page.
//   3. The pause between shops is longer than the pause between pages. Twenty
//      storefronts in a row is a more conspicuous pattern than one person
//      paging through one shop, and the run has hours anyway.

(() => {
  if (globalThis.ecomCreateBatchRunner) return; // already loaded into this worker

  //: Pause between shops, milliseconds. Deliberately longer than the 1.2–2.7s
  //: between pages of one shop — see note 3 above.
  const SHOP_GAP_MS = 4_000;
  const SHOP_GAP_JITTER_MS = 4_000;

  //: How long a saved sweep is worth offering. Same 12 hours as the per-shop
  //: resume: past that the prices have moved and the run is better restarted.
  const BATCH_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  /**
   * Build the batch runner.
   *
   * @param {object} deps
   * @param {() => Promise<{ok: boolean, shops?: Array<{marketplace: string, slug: string}>, error?: string}>} deps.fetchShops
   *   Ask the ingest server for the list. Owns its own token and endpoint.
   * @param {(spec: {marketplace: string, slug: string, target: number, useResume: boolean}) => Promise<object>} deps.runShop
   *   Run one shop to completion and resolve with its finished job snapshot.
   *   Rejecting is allowed: it is recorded as that shop's failure.
   * @param {() => void} deps.cancelShop Ask the running shop to stop.
   * @param {(state: object|null) => Promise<void>} deps.saveState Persist, or clear when null.
   * @param {() => Promise<object|null>} deps.loadState Read what was persisted.
   * @param {() => boolean} deps.hasShopResume Whether a mid-shop place is saved.
   * @param {() => void} deps.onChange Called whenever the snapshot changes.
   * @param {(ms: number) => Promise<void>} deps.sleep
   * @param {() => number} deps.now Milliseconds since the epoch. Injected for tests.
   * @param {number} [deps.gapMs] Override the inter-shop pause. Tests pass 0.
   */
  function createBatchRunner(deps) {
    const {
      fetchShops,
      runShop,
      cancelShop,
      saveState,
      loadState,
      hasShopResume,
      onChange,
      sleep,
      now,
      gapMs,
      jitterMs,
    } = deps;

    //: The sweep in progress, or null. In memory like `job` in background.js and
    //: for the same reason: a worker that was torn down is not running anything,
    //: and saying otherwise would be a lie the popup cannot check.
    let batch = null;

    //: Held between "a start was accepted" and "`batch` exists to prove it".
    //: `start` awaits the server for the list before it can build `batch`, and
    //: two clicks inside that window both found `batch` null and both went on to
    //: sweep the same twenty shops — twice the requests, twice the wall time,
    //: and a progress display that only ever showed one of them.
    let starting = false;

    function snapshot() {
      if (!batch) return null;
      return {
        running: batch.running,
        cancelled: batch.cancelled,
        target: batch.target,
        total: batch.shops.length,
        index: batch.index,
        // The shop being walked right now, so the popup can name it without
        // having to line up two arrays itself.
        current: batch.shops[batch.index] || null,
        results: batch.results.slice(),
        failed: batch.results.filter((result) => !result.ok).length,
        // Products filed across the whole sweep, which is the number someone
        // watching a two-hour run actually wants.
        unique: batch.results.reduce((sum, result) => sum + (result.unique || 0), 0),
        stored: batch.results.reduce((sum, result) => sum + (result.stored || 0), 0),
        startedAt: batch.startedAt,
      };
    }

    function persistable() {
      return {
        shops: batch.shops,
        index: batch.index,
        target: batch.target,
        results: batch.results,
        savedAt: now(),
      };
    }

    //: What one shop's finished job says, reduced to what a list of twenty can
    //: show. `error` is kept verbatim: it is the only thing that explains a
    //: failed row, and rewording it here would hide which of the many ways a
    //: storefront can refuse actually happened.
    function summarise(entry, job) {
      return {
        marketplace: entry.marketplace,
        slug: entry.slug,
        ok: Boolean(job && !job.error),
        unique: job?.unique || 0,
        stored: job?.stored || 0,
        unchanged: job?.unchanged || 0,
        filtered: job?.filtered || 0,
        pages: job?.pagesDone || 0,
        cancelled: Boolean(job?.cancelled),
        // Why this shop's walk stopped. A sweep asks every shop for the same
        // number, so most rows come back under it — and without this the list
        // cannot tell "that is the whole shop" from "it stopped early".
        ended: job?.ended || null,
        error: job?.error || null,
      };
    }

    function pause() {
      const base = Number.isFinite(gapMs) ? gapMs : SHOP_GAP_MS;
      const jitter = Number.isFinite(jitterMs) ? jitterMs : SHOP_GAP_JITTER_MS;
      // Math.random rather than a counter: a fixed pause is itself a pattern.
      return base + Math.random() * jitter;
    }

    /**
     * Walk shops from `batch.index` to the end of the list.
     *
     * Never throws: a shop that fails is a row in `results`, and the sweep goes
     * on. That is the whole point of the queue — nineteen shops should not be
     * lost to one bad slug.
     */
    async function walk() {
      while (batch.index < batch.shops.length) {
        if (batch.cancelled) break;

        const entry = batch.shops[batch.index];
        // Saved before the shop starts, so an eviction mid-shop resumes at this
        // shop and not at the one after it.
        await saveState(persistable());
        onChange();

        let job = null;
        try {
          job = await runShop({
            marketplace: entry.marketplace,
            slug: entry.slug,
            target: batch.target,
            // Only the first shop of a resumed sweep can have a mid-shop place
            // saved, and only if that place belongs to this shop. `hasShopResume`
            // answers both, because `background.js` clears it when a run ends.
            useResume: batch.useResumeOnce && hasShopResume(),
          });
        } catch (err) {
          job = { error: String(err?.message || err) };
        }
        batch.useResumeOnce = false;

        batch.results[batch.index] = summarise(entry, job);
        batch.index += 1;
        await saveState(persistable());
        onChange();

        if (batch.cancelled) break;
        if (batch.index < batch.shops.length) await sleep(pause());
      }

      batch.running = false;
      // A sweep that finished has nowhere to continue from. A cancelled one
      // does, and that is exactly when the saved place earns its keep.
      if (!batch.cancelled) await saveState(null);
      onChange();
    }

    /**
     * Start a sweep over the whole list.
     *
     * @param {{target: number, shops?: Array<object>}} options `shops` is for
     *   the retry path, which re-runs a subset rather than re-reading the file.
     */
    async function start({ target, shops }) {
      if (batch?.running || starting) return { ok: false, error: 'batch masih berjalan' };
      starting = true;

      try {
        let list = shops;
        if (!list) {
          const answer = await fetchShops();
          if (!answer.ok) return { ok: false, error: answer.error };
          list = answer.shops || [];
        }
        if (!list.length) {
          return {
            ok: false,
            error:
              'daftar toko kosong — unduh stores.txt dari dashboard, simpan ke config/stores.txt',
          };
        }

        batch = {
          running: true,
          cancelled: false,
          target,
          shops: list,
          index: 0,
          results: [],
          useResumeOnce: false,
          startedAt: now(),
        };
        onChange();
        walk();
        return { ok: true, count: list.length };
      } finally {
        starting = false;
      }
    }

    /** Continue the sweep a torn-down worker left behind. */
    async function resume() {
      if (batch?.running || starting) return { ok: false, error: 'batch masih berjalan' };
      starting = true;
      try {
        return await resumeInner();
      } finally {
        starting = false;
      }
    }

    async function resumeInner() {
      const saved = await loadState();
      if (!saved || !saved.shops?.length) {
        return { ok: false, error: 'tidak ada batch yang bisa dilanjutkan' };
      }
      if (now() - (saved.savedAt || 0) > BATCH_MAX_AGE_MS) {
        await saveState(null);
        return { ok: false, error: 'batch terakhir sudah kedaluwarsa, mulai dari awal' };
      }
      if (saved.index >= saved.shops.length) {
        await saveState(null);
        return { ok: false, error: 'batch terakhir sudah selesai' };
      }

      batch = {
        running: true,
        cancelled: false,
        target: saved.target,
        shops: saved.shops,
        index: saved.index,
        results: saved.results || [],
        // The shop at `index` may be half-walked. Its pages are already in the
        // database, so continuing beats re-reading them.
        useResumeOnce: true,
        startedAt: now(),
      };
      onChange();
      walk();
      return { ok: true, from: saved.index };
    }

    /** Re-run only the shops that failed, keeping the ones that worked. */
    async function retryFailed() {
      if (batch?.running) return { ok: false, error: 'batch masih berjalan' };
      const failed = (batch?.results || []).filter((result) => !result.ok);
      if (!failed.length) return { ok: false, error: 'tidak ada toko yang gagal' };

      return start({
        target: batch.target,
        shops: failed.map((result) => ({
          marketplace: result.marketplace,
          slug: result.slug,
        })),
      });
    }

    /**
     * Stop after the shop in flight stops.
     *
     * Both halves are needed: the flag ends the queue, and `cancelShop` ends the
     * page walk that is running right now. Without the second, a cancel pressed
     * during a 1,600-product catalogue would appear to do nothing until that
     * shop finished on its own.
     */
    function cancel() {
      if (!batch?.running) return { ok: false, error: 'tidak ada batch berjalan' };
      batch.cancelled = true;
      cancelShop();
      onChange();
      return { ok: true };
    }

    /** What the popup should offer on open, if anything. */
    async function offer() {
      if (batch?.running) return null;
      const saved = await loadState();
      if (!saved || !saved.shops?.length) return null;
      if (now() - (saved.savedAt || 0) > BATCH_MAX_AGE_MS) return null;
      if (saved.index >= saved.shops.length) return null;
      return {
        index: saved.index,
        total: saved.shops.length,
        next: saved.shops[saved.index],
        target: saved.target,
      };
    }

    return {
      start,
      resume,
      retryFailed,
      cancel,
      offer,
      snapshot,
      isRunning: () => Boolean(batch?.running),
    };
  }

  globalThis.ecomCreateBatchRunner = createBatchRunner;
  globalThis.ECOM_BATCH_MAX_AGE_MS = BATCH_MAX_AGE_MS;
})();
