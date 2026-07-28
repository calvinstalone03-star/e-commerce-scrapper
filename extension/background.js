// Service worker: run a scrape job and post what it finds to the local ingest
// server.
//
// A job is one keyword walked across as many result pages as it takes to reach
// the requested number of products — navigate, wait for the grid to actually
// render, scroll it so the lazy rows exist, read it, POST it, next page. It
// stays user-triggered: nothing runs on a timer, nothing runs when the popup is
// closed except a job the user started, and the only requests made to the
// marketplace are the page loads a person clicking "next" would make anyway.
//
// Three things the previous version got wrong, all of which read as "the keyword
// box is broken":
//
//   1. It navigated and then slept a flat 6 seconds. Shopee's grid regularly
//      takes longer, so `tabs.sendMessage` hit a tab whose content script had
//      not loaded yet and the popup showed "could not reach the page".
//   2. It answered the popup only after the whole scrape finished. A job that
//      outlives the popup — which any multi-page job does — left the popup
//      waiting on a response that never came.
//   3. Clicking the button ignored whatever was typed in the keyword box; only
//      Enter used it.
//
// So the worker now owns a job object, answers 'start' immediately, and streams
// progress to whichever popup happens to be open.

importScripts('sites.js');

const ENDPOINT_KEY = 'endpoint';
const TOKEN_KEY = 'token';
const PREFS_KEY = 'prefs';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

//: How many products a job collects when the user does not say. One search page
//: is 60-ish cards on both sites, so this is "about one page" and keeps the
//: default behaviour close to what the button used to do.
const DEFAULT_TARGET = 60;

//: Hard ceiling on pages per job, whatever the target. Both sites stop returning
//: fresh results long before this; it exists so a bad stop condition cannot turn
//: a click into an unbounded crawl.
const MAX_PAGES = 30;

//: Pause between page loads. A person clicking through results does not do it in
//: 200ms, and neither should this.
const PAGE_DELAY_MS = 1_200;
const PAGE_JITTER_MS = 1_500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getConfig() {
  const stored = await chrome.storage.local.get([ENDPOINT_KEY, TOKEN_KEY]);
  return {
    endpoint: stored[ENDPOINT_KEY] || DEFAULT_ENDPOINT,
    token: stored[TOKEN_KEY] || '',
  };
}

async function getPrefs() {
  const stored = await chrome.storage.local.get([PREFS_KEY]);
  const prefs = stored[PREFS_KEY] || {};
  return {
    target: Number(prefs.target) > 0 ? Number(prefs.target) : DEFAULT_TARGET,
    shop: typeof prefs.shop === 'string' ? prefs.shop : '',
  };
}

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

//: The one running job, or null. Kept in memory on purpose: if the worker is
//: torn down the job is gone with it, and a job that reports itself as running
//: while nothing is running would be a worse lie than showing nothing.
let job = null;
let keepAlive = null;

function newJob(keyword, target, mode, shopInput) {
  return {
    running: true,
    cancelled: false,
    // 'search' — the site's keyword results, paginated.
    // 'shop'   — one shop's own product grid, paginated, keyword applied as a
    //            filter on the product name rather than trusted to the site.
    // 'page'   — whatever the tab already shows.
    mode,
    keyword,
    shopInput: shopInput || null,
    slug: null, // the storefront that actually answered
    filtered: 0, // products dropped for not matching the keyword
    target,
    page: 0, // 1-based, for display
    pagesDone: 0,
    unique: 0, // distinct products this job has sent
    stored: 0,
    unchanged: 0,
    skipped: 0,
    status: 'menyiapkan…',
    error: null,
  };
}

function snapshot() {
  return job ? { ...job } : null;
}

function broadcast() {
  // Fails when no popup is open, which is the normal case for a long job.
  chrome.runtime.sendMessage({ type: 'progress', job: snapshot() }).catch(() => {});
}

function setStatus(text) {
  if (!job) return;
  job.status = text;
  broadcast();
}

function startKeepAlive() {
  // MV3 tears an idle worker down after 30 seconds. Every extension API call
  // resets that timer, and a job spends most of its time awaiting page loads, so
  // a cheap periodic call is what keeps a multi-page job alive.
  if (keepAlive) return;
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
}

function stopKeepAlive() {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

// ---------------------------------------------------------------------------
// Tab plumbing
// ---------------------------------------------------------------------------

async function ensureScraper(tabId) {
  // The content scripts are declared in the manifest, but a tab opened before
  // the extension was loaded or reloaded has no copy of them. Injecting on
  // demand means the user never has to think about reload order — the single
  // most common way this looked broken. Both files guard against a second
  // injection, so doing this repeatedly is free.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['sites.js', 'dom-scraper.js'],
    });
  } catch (err) {
    /* already present, or the tab is not scriptable */
  }
}

async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch (err) {
    return null;
  }
}

function sameSearch(a, b) {
  // "Is the tab showing the page we asked for?" — compared on host, path and
  // the two parameters that matter, because both sites rewrite the rest of the
  // query string as the app boots.
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.hostname !== right.hostname || left.pathname !== right.pathname) return false;
    const term = (url) =>
      (globalThis.ecomKeywordFromUrl(url.href) || '').toLowerCase();
    if (term(left) !== term(right)) return false;
    return (left.searchParams.get('page') || '0') === (right.searchParams.get('page') || '0');
  } catch (err) {
    return false;
  }
}

async function waitForLoad(tabId, timeoutMs = 30_000) {
  // Resolve on the tab's own load event rather than on a timer. Best-effort:
  // an SPA can report complete before its grid exists, which is why the content
  // script waits for cards afterwards instead of trusting this.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function navigateAndWait(tabId, url) {
  const loaded = waitForLoad(tabId);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    return { ok: false, error: `tab tidak bisa dibuka: ${err.message || err}` };
  }
  await loaded;

  // The load event is not proof the content script is live — the tab may still
  // be swapping documents. Ping until it answers from the URL we asked for.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (job?.cancelled) return { ok: false, error: 'dibatalkan' };
    await ensureScraper(tabId);
    const pong = await ping(tabId);
    if (pong?.ok && sameSearch(pong.url, url)) return { ok: true };
    await sleep(500);
  }
  return { ok: false, error: 'halaman tidak siap — mungkin ada CAPTCHA atau login' };
}

async function scrapeTab(tabId, options) {
  await ensureScraper(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'scrapeDom', options });
  } catch (err) {
    // One retry: an injection that lost its race with a navigation is the
    // common cause and re-injecting fixes it.
    await sleep(1_000);
    await ensureScraper(tabId);
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'scrapeDom', options });
    } catch (retryErr) {
      return { ok: false, error: 'tidak bisa menghubungi halaman — muat ulang tab lalu coba lagi' };
    }
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function keywordTokens(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesKeyword(name, tokens) {
  // Every word has to appear somewhere in the product name. A shop grid is not
  // a search engine — "lego technic" must not match every LEGO in the shop —
  // and the site's own in-shop search parameter is not something this can
  // depend on, so the filter runs here either way.
  const haystack = String(name || '').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

async function postItems(page, items) {
  const { endpoint, token } = await getConfig();
  if (!token) return { ok: false, error: 'belum ada token ingest — buka pengaturan dan tempel token' };

  let response;
  try {
    response = await fetch(`${endpoint}/ingest-dom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({
        marketplace: page.marketplace,
        pageUrl: page.pageUrl,
        scrapedAt: page.scrapedAt,
        // A shop grid's URL carries no search term, so the term the user asked
        // for is stated rather than left for the server to read back out of the
        // address — otherwise a shop-mode run would record no keyword at all.
        keyword: job?.keyword || null,
        items,
      }),
    });
  } catch (err) {
    return { ok: false, error: `tidak bisa menghubungi ${endpoint} — 'ecom-scraper serve' jalan?` };
  }

  if (response.status === 401) return { ok: false, error: 'token ingest ditolak' };
  if (!response.ok) return { ok: false, error: `server menjawab HTTP ${response.status}` };

  const body = await response.json().catch(() => ({}));
  return {
    ok: true,
    stored: body.stored || 0,
    unchanged: body.unchanged || 0,
    skipped: body.skipped || 0,
  };
}

// ---------------------------------------------------------------------------
// The job itself
// ---------------------------------------------------------------------------

async function resolveShop(tabId, site, slugs) {
  // A display name is a guess at a slug, so the storefront itself is the test:
  // whichever candidate answers with products is the shop. Its first page is
  // handed back rather than thrown away — it is exactly the page the job wants
  // to read next.
  for (const slug of slugs) {
    if (job.cancelled) return null;
    setStatus(`membuka toko ${slug}…`);
    const navigated = await navigateAndWait(tabId, site.shopUrl(slug, job.keyword, 0));
    if (!navigated.ok) continue;

    const page = await scrapeTab(tabId, { autoScroll: true });
    if (page?.ok && page.items.length) return { slug, page };
  }
  return null;
}

async function runJob(tabId, site) {
  const seen = new Set();
  const tokens = job.mode === 'shop' ? keywordTokens(job.keyword) : [];
  let barrenPages = 0;
  let pending = null; // a page already read during shop resolution

  if (job.mode === 'shop') {
    const slugs = globalThis.ecomShopSlugs(site, job.shopInput);
    const resolved = await resolveShop(tabId, site, slugs);
    if (!resolved) {
      job.error = job.cancelled
        ? null
        : `toko "${job.shopInput}" tidak ditemukan atau tidak punya produk — tempel URL tokonya`;
      return;
    }
    job.slug = resolved.slug;
    pending = resolved.page;
  }

  for (let index = 0; index < MAX_PAGES; index += 1) {
    if (job.cancelled) break;

    job.page = index + 1;
    let page = pending;
    pending = null;

    if (!page && job.mode !== 'page') {
      const wanted =
        job.mode === 'shop'
          ? site.shopUrl(job.slug, job.keyword, index)
          : site.searchUrl(job.keyword, index);
      let current = '';
      try {
        current = (await chrome.tabs.get(tabId)).url || '';
      } catch (err) {
        job.error = 'tab ditutup';
        break;
      }

      // Already showing exactly this page (the usual case for page 1 when the
      // user searched by hand): read it instead of reloading it.
      if (!sameSearch(current, wanted)) {
        setStatus(`membuka halaman ${index + 1}…`);
        const navigated = await navigateAndWait(tabId, wanted);
        if (!navigated.ok) {
          job.error = navigated.error;
          break;
        }
      }
    }

    if (!page) {
      setStatus(`membaca halaman ${job.page}…`);
      page = await scrapeTab(tabId, { autoScroll: true });
    }

    if (!page?.ok) {
      job.error = page?.error || 'halaman tidak mengembalikan apa-apa';
      break;
    }

    // Dedupe across pages: both sites repeat listings between pages and the
    // sponsored rows repeat everywhere, so "how many products do I have" only
    // means something if a repeat does not count twice.
    const fresh = page.items.filter((item) => {
      const key = `${page.marketplace}:${item.shopKey}/${item.itemKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // In shop mode the keyword is a filter over the shop's own grid, applied
    // here so it holds whether or not the site honoured the search parameter in
    // the URL. Counted, because "shop had 400 products, 12 matched" is the
    // difference between a working filter and a wrong one.
    const matching = tokens.length ? fresh.filter((item) => matchesKeyword(item.name, tokens)) : fresh;
    job.filtered += fresh.length - matching.length;

    // Never overshoot the requested count — "ambil 100" should file 100 rows,
    // not 120 because the last page happened to be full.
    const room = Math.max(0, job.target - job.unique);
    const batch = matching.slice(0, room);

    if (batch.length) {
      setStatus(`mengirim ${batch.length} produk dari halaman ${job.page}…`);
      const posted = await postItems(page, batch);
      if (!posted.ok) {
        job.error = posted.error;
        break;
      }
      job.unique += batch.length;
      job.stored += posted.stored;
      job.unchanged += posted.unchanged;
      job.skipped += posted.skipped;
    }

    job.pagesDone += 1;
    broadcast();

    if (job.mode === 'page') break; // a single page is the whole job
    if (job.unique >= job.target) break;

    // Nothing at all on the very first page is a broken run, not the end of the
    // results — say so rather than quietly walking further pages of the same
    // nothing.
    if (!page.items.length && job.pagesDone === 1) {
      job.error = `tidak ada kartu produk (${page.anchorsSeen} tautan) — halaman pencarian atau toko? sudah selesai memuat?`;
      break;
    }

    // A page with nothing new twice running is the end of the results: both
    // sites keep serving pages past the last real one, filled with the same
    // recommendations.
    barrenPages = fresh.length ? 0 : barrenPages + 1;
    if (barrenPages >= 2) break;

    await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);
  }
}

async function startJob({ keyword, shop, target }) {
  if (job?.running) return { ok: false, error: 'masih ada scrape yang berjalan' };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'tidak ada tab aktif' };

  let site = null;
  try {
    site = globalThis.ecomSiteForHost(new URL(tab.url).hostname);
  } catch (err) {
    /* not a marketplace tab; reported below */
  }
  if (!site) {
    return { ok: false, error: 'buka tab Shopee atau Tokopedia dulu, lalu cari dari sini' };
  }

  const typed = String(keyword || '').trim();
  const shopInput = String(shop || '').trim();

  // No keyword and no shop typed? Use the term already in the address bar, so a
  // search the user ran by hand can still be paginated. With a shop named, the
  // address bar is not what the user meant, so it is ignored.
  const fromTab = shopInput ? '' : globalThis.ecomKeywordFromUrl(tab.url || '');
  const term = typed || fromTab;

  // A named shop is the strongest instruction: walk that shop's grid, and treat
  // any keyword as a filter over it. Without one, a keyword is a site search,
  // and without either there is only the page already open.
  const mode = shopInput ? 'shop' : term ? 'search' : 'page';

  const wanted = Number(target);
  const capped = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), 5_000) : DEFAULT_TARGET;

  await chrome.storage.local.set({ [PREFS_KEY]: { target: capped, shop: shopInput } });

  job = newJob(term, mode === 'page' ? Number.MAX_SAFE_INTEGER : capped, mode, shopInput);
  broadcast();
  startKeepAlive();

  (async () => {
    try {
      await runJob(tab.id, site);
    } catch (err) {
      job.error = String(err?.message || err);
    } finally {
      job.running = false;
      job.status = job.cancelled ? 'dibatalkan' : 'selesai';
      stopKeepAlive();
      broadcast();
    }
  })();

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'start') {
    // Answer as soon as the job is accepted, not when it finishes. A job
    // outlives the popup; a response that waited for it would never arrive.
    startJob(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'cancel') {
    if (job?.running) {
      job.cancelled = true;
      setStatus('menghentikan…');
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'context') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const { endpoint, token } = await getConfig();
      const prefs = await getPrefs();

      let site = null;
      try {
        site = globalThis.ecomSiteForHost(new URL(tab?.url || '').hostname);
      } catch (err) {
        /* not a URL we recognise */
      }

      let stats = null;
      try {
        const response = await fetch(`${endpoint}/stats`, {
          headers: { 'X-Ingest-Token': token },
        });
        if (response.ok) stats = await response.json();
      } catch (err) {
        /* server down; the popup renders that state */
      }

      // A tab already sitting on a storefront pre-fills the shop box: that is
      // the shop the user is looking at, and retyping it would be busywork.
      let shopFromTab = '';
      try {
        shopFromTab = (site?.shopPage(new URL(tab.url)) || {}).username || '';
      } catch (err) {
        /* not a shop page */
      }

      sendResponse({
        endpoint,
        hasToken: Boolean(token),
        marketplace: site ? site.label : null,
        keyword: globalThis.ecomKeywordFromUrl(tab?.url || ''),
        shop: shopFromTab || prefs.shop,
        target: prefs.target,
        stats,
        job: snapshot(),
      });
    })();
    return true;
  }

  return false;
});
