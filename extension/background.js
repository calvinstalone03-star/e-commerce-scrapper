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

importScripts('sites.js', 'batch.js');

const ENDPOINT_KEY = 'endpoint';
const TOKEN_KEY = 'token';
const PREFS_KEY = 'prefs';
//: Which database the ingest server files this run into: 'local' (Postgres on
//: the laptop) or 'neon' (the hosted one the deployed dashboard reads). Its own
//: storage key rather than a field in PREFS_KEY, because starting a job
//: overwrites that whole object and would take the choice with it.
const DESTINATION_KEY = 'destination';
//: Where a run files when nobody has chosen: the hosted database the deployed
//: dashboard reads. It used to be the laptop's Postgres, from when that was the
//: only one there was — but a scrape that lands somewhere the dashboard cannot
//: see is a scrape nobody asked for, and every browser this extension is
//: installed in now has a dashboard and may not have a Postgres at all.
const DEFAULT_DESTINATION = 'neon';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

//: Where a browser with no server of its own files what it reads. The same
//: application as DEFAULT_ENDPOINT, deployed once so that installing this needs
//: neither Python nor a terminal — see README section 9.
const HOSTED_ENDPOINT = 'https://ecom-ingest.vercel.app';

//: How long to wait for a local server before concluding there is none. Short,
//: because a loopback server either answers immediately or does not exist, and
//: this runs before the first popup can render.
const LOCAL_PROBE_MS = 1_200;

//: Which server this browser uses, decided once and then remembered.
//:
//: Asked rather than configured: the two audiences want opposite defaults — the
//: machine running the ingest server wants loopback (faster, no quota, token
//: never leaves the machine), and every other machine has nothing there at all.
//: A default that served one of them would make the other edit a settings field
//: before anything worked, and that field is the thing this release exists to
//: remove.
async function resolveEndpoint() {
  const stored = await chrome.storage.local.get([ENDPOINT_KEY]);
  if (stored[ENDPOINT_KEY]) return stored[ENDPOINT_KEY];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_MS);
  let endpoint = HOSTED_ENDPOINT;
  try {
    const response = await fetch(`${DEFAULT_ENDPOINT}/health`, { signal: controller.signal });
    if (response.ok) endpoint = DEFAULT_ENDPOINT;
  } catch (err) {
    /* nothing on loopback; the hosted one it is */
  } finally {
    clearTimeout(timer);
  }

  await chrome.storage.local.set({ [ENDPOINT_KEY]: endpoint });
  return endpoint;
}

//: How many products a job collects when the user does not say. Sized to a
//: whole storefront rather than to one page: the largest shop tracked here
//: holds ~1600 products, so a run that is not told otherwise walks the
//: catalogue and stops when the shop runs out — which is what both the daily
//: sweep and a hand-started shop run want. A page-sized default (60) meant
//: every such run had to retype the number first, and the number box is the one
//: control that is awkward to fill without a keyboard.
const DEFAULT_TARGET = 2_000;

//: Hard ceiling on pages per job, whatever the target. It exists so a bad stop
//: condition cannot turn a click into an unbounded crawl — not to decide how
//: much a job collects, which is what a flat 30 quietly did: a catalogue run
//: asking for 1600 products stopped at whatever 30 pages held, reported it as a
//: finished run, and looked for all the world like the shop had nothing more.
const MAX_PAGES_CEILING = 200;

//: Pages a job may walk, from what it was asked for. Twenty per page is the
//: pessimistic end of what both sites render, so this errs towards allowing the
//: run to finish rather than cutting it short.
function pageBudget(target) {
  if (!Number.isFinite(target) || target > 1e9) return MAX_PAGES_CEILING;
  return Math.min(MAX_PAGES_CEILING, Math.max(30, Math.ceil(target / 20)));
}

//: Pause between page loads. A person clicking through results does not do it in
//: 200ms, and neither should this.
const PAGE_DELAY_MS = 1_200;
const PAGE_JITTER_MS = 1_500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getConfig() {
  const endpoint = await resolveEndpoint();
  const stored = await chrome.storage.local.get([TOKEN_KEY, DESTINATION_KEY]);
  return {
    endpoint,
    token: stored[TOKEN_KEY] || '',
    // Both names honoured, not just one. Written as `=== 'neon' ? 'neon' :
    // DEFAULT` this quietly ignored a stored value once the default became
    // 'neon' — the Lokal button would set the key and the next read would hand
    // back 'neon' anyway, leaving a control that moved and changed nothing.
    destination: stored[DESTINATION_KEY] === 'local' || stored[DESTINATION_KEY] === 'neon'
      ? stored[DESTINATION_KEY]
      : DEFAULT_DESTINATION,
  };
}

/**
 * What the server says about itself: totals, which databases it can write to,
 * whether it will still pair, and whether it is running stale code.
 *
 * Both requests go out together rather than one after the other. They share
 * nothing and always both ran; awaiting them in sequence simply added one
 * round trip to every popup open, which is free on loopback and is not on a
 * deployment a thousand kilometres from its database.
 */
async function readServerState(endpoint, token, showing) {
  const [statsResult, healthResult] = await Promise.allSettled([
    fetch(`${endpoint}/stats`, {
      headers: { 'X-Ingest-Token': token, 'X-Ingest-Target': showing },
    }),
    fetch(`${endpoint}/health`),
  ]);

  let stats = null;
  //: Why the totals are missing, which is not the same question as whether they
  //: are. A 401 means the server answered and refused; a rejection means there
  //: was nothing there to answer.
  let statsStatus = 0;
  if (statsResult.status === 'fulfilled') {
    statsStatus = statsResult.value.status;
    if (statsResult.value.ok) stats = await statsResult.value.json().catch(() => null);
  }

  let serverUp = false;
  let stale = false;
  let pairing = false;
  let targets = { local: true, neon: false };
  if (healthResult.status === 'fulfilled' && healthResult.value.ok) {
    const health = await healthResult.value.json().catch(() => null);
    if (health) {
      serverUp = true;
      stale = Boolean(health.stale);
      pairing = Boolean(health.pairing);
      if (health.targets) targets = health.targets;
    }
  }

  return { stats, statsStatus, serverUp, stale, pairing, targets };
}

async function getPrefs() {
  const stored = await chrome.storage.local.get([PREFS_KEY]);
  const prefs = stored[PREFS_KEY] || {};
  return {
    target: Number(prefs.target) > 0 ? Number(prefs.target) : DEFAULT_TARGET,
    shop: typeof prefs.shop === 'string' ? prefs.shop : '',
    // Remembered like the other two, and for the same reason: someone who
    // walks twenty storefronts looking for the same word should type it once,
    // not twenty times. The tab still wins when it names a search of its own.
    keyword: typeof prefs.keyword === 'string' ? prefs.keyword : '',
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
//: Counts context requests, so a popup can tell a stale answer from the one it
//: is waiting for. Server state arrives out of band and the requests are not
//: cancellable, so ordering has to be stated rather than assumed.
let contextSeq = 0;

function newJob(keyword, target, mode, shopInput) {
  return {
    running: true,
    cancelled: false,
    // 'search' — the site's keyword results, paginated.
    // 'shop'   — one shop's own product grid, paginated, keyword applied as a
    //            filter on the product name rather than trusted to the site.
    // 'page'   — whatever the tab already shows.
    mode,
    // Which database this run files into. Set by the 'start' handler from the
    // stored choice and never re-read, so the toggle cannot move a run that is
    // already under way.
    destination: DEFAULT_DESTINATION,
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
    // Why the walk stopped, once it has: 'target' (the number asked for was
    // reached), 'exhausted' (the shop ran out of products first), 'budget' (the
    // page ceiling was hit with neither of those true). Null while running, and
    // for a run that ended on `error` or a cancel — those say it themselves.
    //
    // The number alone cannot say this. A sweep asked for 2,000 products a shop
    // and a row reading "250 produk" is either a shop with 250 products or a
    // walk that stopped early for a reason nobody was told, and those want
    // different reactions from whoever reads the list.
    ended: null,
    error: null,
  };
}

function snapshot() {
  return job ? { ...job } : null;
}

function broadcast() {
  // Fails when no popup is open, which is the normal case for a long job.
  //
  // Both halves travel together: a sweep and the shop it is walking change on
  // the same events, and sending them separately let the popup paint "toko 7/20"
  // beside the page counter of shop 6.
  chrome.runtime
    .sendMessage({ type: 'progress', job: snapshot(), batch: batchRunner?.snapshot() ?? null })
    .catch(() => {});
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
    // Two terms that disagree are two different pages. A tab that states no
    // term at all is not: both sites rewrite their own query string as the app
    // boots, and treating that as "wrong page" is what made shop-mode runs sit
    // out the 25-second readiness loop and then report the shop as missing.
    const [here, wanted] = [term(left), term(right)];
    if (here && wanted && here !== wanted) return false;
    // Two shops' results share a path and a term on Shopee and differ only in
    // `shop`, so a page of one must never pass for a page of the other.
    if ((left.searchParams.get('shop') || '') !== (right.searchParams.get('shop') || '')) {
      return false;
    }
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
    // Ask before injecting. The manifest already put the content script in most
    // tabs, so an injection per half-second was two round-trips to learn what
    // one answers — and the injection is only ever needed for a tab that
    // predates the extension being loaded.
    let pong = await ping(tabId);
    if (!pong?.ok) {
      await ensureScraper(tabId);
      pong = await ping(tabId);
    }
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
  // Every word has to appear somewhere in the product name. A shop's catalogue
  // is not a search engine — "lego technic" must not match every LEGO in the
  // shop — so when this job is the one walking the catalogue, it does the
  // matching itself.
  //
  // Loosely at the end of a word, though. Indonesian borrows English nouns and
  // keeps both spellings in circulation: a shopper types "dinosaurus" and the
  // seller wrote "Dinosaur". Requiring the whole word matched neither, so a
  // shortened stem is accepted too — enough of the word to still be that word,
  // never fewer than five characters, which keeps "lego" exact and stops short
  // tokens from matching everything.
  const haystack = String(name || '').toLowerCase();
  return tokens.every((token) => {
    if (haystack.includes(token)) return true;
    if (token.length <= 5) return false;
    return haystack.includes(token.slice(0, Math.max(5, token.length - 2)));
  });
}

//: Collect the ingest token from the server instead of asking a person to copy
//: it out of a terminal. The server only answers while its pairing window is
//: open — see `pairing_open` in scraper/ingest.py — so this is an attempt, not
//: an entitlement, and the popup renders whichever answer comes back.
async function pairWithServer() {
  const { endpoint } = await getConfig();
  let response;
  try {
    response = await fetch(`${endpoint}/pair`);
  } catch (err) {
    return { ok: false, error: `tidak bisa menghubungi ${endpoint} — server ingest jalan?` };
  }

  if (response.status === 403) {
    const detail = await response.json().catch(() => null);
    return { ok: false, error: detail?.detail || 'pairing sedang ditutup' };
  }
  if (!response.ok) return { ok: false, error: `server menjawab HTTP ${response.status}` };

  const body = await response.json().catch(() => null);
  if (!body?.token) return { ok: false, error: 'server tidak mengirim token' };

  await chrome.storage.local.set({ [TOKEN_KEY]: body.token });
  return { ok: true };
}

async function postItems(page, items) {
  const { endpoint, token, destination } = await getConfig();
  if (!token) return { ok: false, error: 'belum ada token ingest — buka pengaturan dan tempel token' };

  // The running job's destination, not the stored one: switching the toggle
  // mid-walk must not split one run across two databases, which would leave
  // both holding half a shop and neither able to say so.
  const target = job?.destination || destination;

  let response;
  try {
    response = await fetch(`${endpoint}/ingest-dom`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Token': token,
        'X-Ingest-Target': target,
      },
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
  // 503 is the server saying the chosen database is not configured, and it says
  // which variable is missing. Passing that through beats "HTTP 503", which
  // would send the user looking at the network.
  if (response.status === 503) {
    const detail = await response.json().then((body) => body?.detail).catch(() => null);
    return { ok: false, error: detail || `tujuan "${target}" belum dikonfigurasi di server` };
  }
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

//: How much of a page has to belong to one shop before the page counts as that
//: shop's. A storefront renders other shops' recommendations alongside its own
//: grid, so a clear majority is the test rather than unanimity.
const SHOP_MAJORITY = 0.6;

//: How long to wait for cards while *probing* a shop-search route, as opposed
//: to reading a page the job has already committed to. Shopee serves one of two
//: search routes depending on whether the shop is a Mall shop, and there is
//: nothing on the storefront that reliably says which — so one of the two is
//: usually a wasted load, and the full 20-second card wait is spent finding out
//: what an empty grid already showed in a few seconds. A page slow enough to
//: miss this is not lost: the run falls back to the shop's full grid.
const PROBE_WAIT_MS = 9_000;

//: Cards enough to settle which shop a storefront is. The probe wants an
//: identity — a name, a username, and on Shopee a numeric id read off the
//: product links — and the first handful of cards carries all three.
const SHOP_PROBE_ENOUGH = 8;

//: How long the scrolling second pass over a storefront waits for its first
//: card. Short on purpose: the pass before it already spent the full card
//: timeout on the same page, so anything still missing is behind the scroll
//: rather than behind the network.
const SHOP_PROBE_WAIT_MS = 3_000;

//: Products read beyond the number asked for. Both sites repeat listings
//: between pages and sprinkle sponsored rows, so a page that holds exactly the
//: remaining count usually yields slightly fewer once deduplicated.
const SCROLL_SPARE = 6;

function dominantShopKey(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.shopKey, (counts.get(item.shopKey) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best && bestCount >= Math.max(2, items.length * SHOP_MAJORITY) ? best : null;
}

function belongsToShop(items, shopKey) {
  if (!items.length) return false;
  const mine = items.filter((item) => item.shopKey === shopKey).length;
  return mine >= Math.max(1, items.length * SHOP_MAJORITY);
}

async function openShopGrid(tabId, site, slug) {
  // Read, but do not walk. This visit exists to answer three questions — is
  // this slug a shop, what is its numeric id, what is it called — and all three
  // are settled by the first handful of cards and the page's own title. Every
  // row past that is scrolled into existence for nothing, and on a storefront
  // home tab those rows are recommendations that no run ever files.
  let url = site.shopUrl({ slug, shopKey: null }, null, 0);

  // The tab is often already on this shop — the popup pre-fills its box from
  // whatever storefront is open, so the usual flow is "look at a shop, press
  // scrape". Reloading the page the user is looking at buys nothing.
  let current = '';
  try {
    current = (await chrome.tabs.get(tabId)).url || '';
  } catch (err) {
    /* tab gone; the navigation below reports it */
  }
  let alreadyHere = false;
  try {
    alreadyHere = (site.shopPage(new URL(current)) || {}).username === slug;
  } catch (err) {
    /* not a URL, or not a storefront */
  }

  if (alreadyHere) {
    url = current;
  } else {
    const navigated = await navigateAndWait(tabId, url);
    if (!navigated.ok) return null;
  }

  let page = await scrapeTab(tabId, { autoScroll: false });

  // An empty first pass is not proof the slug is wrong. Shopee's storefront
  // opens on its home tab, where the shop's own grid sits under the banners and
  // vouchers and renders only once it is scrolled near — so a shop that is
  // plainly open reads as zero cards, `resolveShop` runs out of candidates, and
  // the run reports "toko tidak ditemukan" for a link that was correct all
  // along. Tokopedia does not show this: the same call lands on `/<slug>/product`,
  // which is the grid itself.
  //
  // So scroll once before believing it. Only the identity is wanted here, hence
  // the handful of cards rather than a catalogue, and only a short wait for the
  // first one: the pass above already spent the full card timeout on this very
  // page, and what this adds is the scrolling, not more waiting.
  if (page?.ok && !page.items.length) {
    setStatus(`menggulir toko ${slug}…`);
    page = await scrapeTab(tabId, {
      autoScroll: true,
      enough: SHOP_PROBE_ENOUGH,
      waitMs: SHOP_PROBE_WAIT_MS,
    });
  }

  return page?.ok && page.items.length ? { page, url } : null;
}

async function shopCatalogue(tabId, grid) {
  // The shop's catalogue, from the storefront page already visited. Used both
  // when there is no keyword at all and when no search route answered one — in
  // either case what the job walks is the full product list, filtered here on
  // the product name. Falls back to the storefront page as read: worse (it is
  // the home tab's recommendations) but never nothing.
  let current = '';
  try {
    current = (await chrome.tabs.get(tabId)).url || '';
  } catch (err) {
    return { page: grid.page, template: grid.url };
  }

  // A failed search left the tab elsewhere; the tab has to be back on the
  // storefront for its tabs to be there to click.
  if (!sameSearch(current, grid.url)) {
    const navigated = await navigateAndWait(tabId, grid.url);
    if (!navigated.ok) return { page: grid.page, template: grid.url };
  }

  const productsUrl = await openShopProducts(tabId);
  if (!productsUrl) return { page: grid.page, template: grid.url };

  // A catalogue read with a keyword still has to be filtered, and a filter needs
  // the whole page to filter; without one, the count asked for is the stopping
  // point.
  const products = await scrapeTab(tabId, {
    autoScroll: true,
    ...(job.keyword ? {} : { enough: job.target + SCROLL_SPARE }),
  });
  if (!products?.ok || !products.items.length) return { page: grid.page, template: grid.url };
  return { page: products, template: products.pageUrl || productsUrl };
}

async function openShopProducts(tabId) {
  // A storefront opens on its home tab: vouchers, banners, and a "kamu mungkin
  // suka" strip that is recommendations rather than the shop's catalogue. The
  // catalogue is the "Produk" tab, and clicking it is how the site itself gets
  // there — its address is not something to guess at, and once clicked it is the
  // address the rest of the run pages through.
  let before = '';
  try {
    before = (await chrome.tabs.get(tabId)).url || '';
  } catch (err) {
    return null;
  }

  await ensureScraper(tabId);
  let asked;
  try {
    asked = await chrome.tabs.sendMessage(tabId, { type: 'openProducts' });
  } catch (err) {
    return null;
  }
  if (!asked?.ok) return null;

  const deadline = Date.now() + SEARCH_NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (job?.cancelled) return null;
    await sleep(500);
    let current = '';
    try {
      current = (await chrome.tabs.get(tabId)).url || '';
    } catch (err) {
      return null;
    }
    if (current !== before) return current;
  }
  // Clicked, but the tab is rendered in place. The grid on screen is still the
  // catalogue — it just cannot be paged through by address.
  return before;
}

//: How long to give the site to act on a search typed into a shop's own box.
//: This is a click's worth of work, not a page load — if nothing has moved by
//: now the box was not the shop's, or nothing was listening to it.
const SEARCH_NAV_TIMEOUT_MS = 12_000;

async function searchInsideShop(tabId, keyword) {
  // Type the term into the storefront's own search box and let the site decide
  // where that goes. Shopee's answer depends on whether the shop is a Mall shop
  // — /mall/search for one, /search for the other, both filtered by a numeric
  // id — and building either by hand means guessing, then paginating the empty
  // results of a wrong guess. The address the site itself lands on is the right
  // one by construction, and it is also the template for pages 2..N.
  let before = '';
  try {
    before = (await chrome.tabs.get(tabId)).url || '';
  } catch (err) {
    return null;
  }

  await ensureScraper(tabId);
  let asked;
  try {
    asked = await chrome.tabs.sendMessage(tabId, { type: 'shopSearch', keyword });
  } catch (err) {
    return null;
  }
  if (!asked?.ok) return null;

  // The search is a navigation on Shopee and a route change on some layouts, so
  // the tab's own URL is what says it happened — not the load event, which a
  // client-side route change never fires.
  const deadline = Date.now() + SEARCH_NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (job?.cancelled) return null;
    await sleep(500);
    let current = '';
    try {
      current = (await chrome.tabs.get(tabId)).url || '';
    } catch (err) {
      return null;
    }
    if (current === before) continue;
    const term = (globalThis.ecomKeywordFromUrl(current) || '').toLowerCase();
    if (term !== keyword.toLowerCase()) continue; // still settling
    return current;
  }
  return null;
}

async function resolveShop(tabId, site, slugs) {
  // Two questions, in order: which storefront is this, and does that shop have
  // a searchable route.
  //
  // A display name is a guess at a slug, so the storefront itself is the test —
  // whichever candidate answers with products is the shop. It is also the only
  // place the shop states its own name, and on Shopee the only place its
  // numeric id can be read, since the id exists nowhere but in the product
  // links of its own grid. That id is what the in-shop search filters on.
  //
  // With the shop known and a keyword to apply, the search comes from the shop's
  // own box wherever the site has one: whatever address that lands on is a real
  // in-shop search, Mall or not, and it doubles as the template for pages 2..N.
  // Building the address by hand is the fallback, and it is a guess — asking the
  // wrong route returns nothing, which is indistinguishable from a shop that
  // does not stock the term, and paginating that emptiness is exactly what a run
  // used to do.
  //
  // Either way a result only counts when the ids come back matching. A route
  // that answers with *other* shops' products is worse than one that answers
  // with none, because it looks like success.
  //
  // When nothing answers, the storefront grid already in hand is the answer: the
  // shop is plainly there, and the keyword filter this job applies to every
  // product name works over the full grid just the same, only across more pages.
  // Reporting "shop not found" for a shop that is visibly open was the more
  // confusing of the two failures.
  for (const slug of slugs) {
    if (job.cancelled) return null;

    // Tokopedia keys its shop search on the slug the user already gave, so the
    // storefront visit is skipped there and the search is asked for directly —
    // and since that route *is* a shop page, the name and username come back
    // with it anyway. Only Shopee has to pay for the extra load.
    let shop = { slug, shopKey: null, name: null, username: slug };
    let grid = null;

    if (!job.keyword || site.shopSearchNeedsShopKey || site.searchInsideShopPage) {
      setStatus(`membuka toko ${slug}…`);
      grid = await openShopGrid(tabId, site, slug);
      if (!grid) continue;
      shop = {
        slug,
        shopKey: grid.page.shop?.shopKey || dominantShopKey(grid.page.items),
        name: grid.page.shop?.name || null,
        username: grid.page.shop?.username || slug,
        mall: Boolean(grid.page.mall),
      };

      if (!job.keyword) {
        // Without a term, the whole catalogue is the job — so leave the home
        // tab the storefront opened on and go to the one that lists it.
        setStatus(`membuka daftar produk ${slug}…`);
        const catalogue = await shopCatalogue(tabId, grid);
        return {
          shop: { ...shop, name: shop.name || catalogue.page.shop?.name || null },
          searched: false,
          ...catalogue,
        };
      }
    }

    const attempts = [
      ...(site.searchInsideShopPage ? ['in-page'] : []),
      ...site.shopUrlVariants(shop, job.keyword),
    ];
    if (!attempts.length) continue;

    for (const attempt of attempts) {
      if (job.cancelled) return null;
      setStatus(`mencari "${job.keyword}" di ${slug}…`);

      let url;
      if (attempt === 'in-page') {
        url = await searchInsideShop(tabId, job.keyword);
        if (!url) continue;
      } else {
        url = site.shopUrl(shop, job.keyword, 0, attempt);
        const navigated = await navigateAndWait(tabId, url);
        if (!navigated.ok) continue;
      }

      // Everything but the last attempt is a probe: an empty grid says the
      // answer already, and waiting the full card timeout for it is the bulk of
      // what a wrong guess costs.
      //
      // A search page needs no filtering afterwards, so the run can stop
      // scrolling as soon as the page holds what was asked for — with a few
      // spare, since repeats between pages are deduplicated away.
      const probing = attempt !== attempts[attempts.length - 1];
      const page = await scrapeTab(tabId, {
        autoScroll: true,
        enough: job.target + SCROLL_SPARE,
        ...(probing ? { waitMs: PROBE_WAIT_MS } : {}),
      });
      if (!page?.ok || !page.items.length) continue;
      if (shop.shopKey && !belongsToShop(page.items, shop.shopKey)) continue;

      // A search route that is itself a shop page — Tokopedia's — states the
      // shop, and that is better than the slug this started from.
      return {
        shop: {
          ...shop,
          shopKey: shop.shopKey || page.shop?.shopKey || dominantShopKey(page.items),
          name: shop.name || page.shop?.name || null,
          username: shop.username || page.shop?.username || slug,
        },
        page,
        template: page.pageUrl || url,
        searched: true,
      };
    }

    // No search answered. The shop's own catalogue is the fallback — read the
    // storefront now if this site let the search be tried without it.
    if (!grid) {
      setStatus(`membuka toko ${slug}…`);
      grid = await openShopGrid(tabId, site, slug);
      if (!grid) continue;
      shop = {
        slug,
        shopKey: grid.page.shop?.shopKey || dominantShopKey(grid.page.items),
        name: grid.page.shop?.name || null,
        username: grid.page.shop?.username || slug,
        mall: Boolean(grid.page.mall),
      };
    }
    setStatus(`membuka daftar produk ${slug}…`);
    const catalogue = await shopCatalogue(tabId, grid);
    return {
      shop: { ...shop, name: shop.name || catalogue.page.shop?.name || null },
      searched: false,
      ...catalogue,
    };
  }
  return null;
}

//: Where an interrupted job leaves its place. A run of 1600 products is the
//: better part of an hour, and until this existed all of it lived in a service
//: worker MV3 is free to tear down — one eviction and the whole walk started
//: over. What is stored is the address of the page it had reached and the keys
//: it had already filed, which is everything needed to carry on without
//: re-reading a single page.
const RESUME_KEY = 'resume';

//: How long a saved place is worth offering. Prices move, and continuing a
//: two-day-old walk would file today's page 40 next to Monday's page 1 as if
//: they were one reading.
const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function saveResume(state) {
  if (!job) return;
  try {
    await chrome.storage.local.set({
      [RESUME_KEY]: {
        keyword: job.keyword,
        shopInput: job.shopInput,
        mode: job.mode,
        target: job.target,
        slug: job.slug,
        shop: state.shop,
        template: state.template,
        tokens: state.tokens,
        // Pages finished, which is the index the next one starts at.
        page: job.pagesDone,
        unique: job.unique,
        stored: job.stored,
        unchanged: job.unchanged,
        skipped: job.skipped,
        filtered: job.filtered,
        seen: [...state.seen],
        savedAt: Date.now(),
      },
    });
  } catch (err) {
    /* storage full or unavailable: the run continues, it just cannot be resumed */
  }
}

async function clearResume() {
  try {
    await chrome.storage.local.remove(RESUME_KEY);
  } catch (err) {
    /* nothing stored */
  }
}

async function getResume() {
  try {
    const stored = await chrome.storage.local.get([RESUME_KEY]);
    const resume = stored[RESUME_KEY];
    if (!resume || !resume.template) return null;
    if (Date.now() - (resume.savedAt || 0) > RESUME_MAX_AGE_MS) return null;
    // A job that finished has nothing left to resume, and one that never got
    // past its first page is cheaper to restart than to explain.
    if (!resume.page || resume.unique >= resume.target) return null;
    return resume;
  } catch (err) {
    return null;
  }
}

async function runJob(tabId, site, resume = null) {
  const seen = new Set();
  // Words every product name has to contain, when this job is the one doing the
  // matching. It is not, when the site's own in-shop search answered: a search
  // for "dinosaurus" returns "LEGO Creator Fierce Dinosaur" and "Jurassic World
  // 76950 Triceratops", neither of which contains the word typed. Re-checking
  // the site's results against the literal term threw away every row and left
  // the run paging for more of what it had already discarded.
  let tokens = [];
  let barrenPages = 0;
  let pending = null; // a page already read during shop resolution
  let shop = null; // { slug, shopKey, name, username } once a storefront answered
  let template = null; // the URL page 1 came from, paged through for the rest

  // Carrying on where a torn-down worker stopped: the shop is already resolved
  // and the address already known, so the storefront walk that opens a shop run
  // is skipped entirely and the first page read is the one after the last one
  // filed.
  let startIndex = 0;
  if (resume) {
    shop = resume.shop || null;
    template = resume.template;
    tokens = resume.tokens || [];
    startIndex = resume.page;
    for (const key of resume.seen || []) seen.add(key);
  } else if (job.mode === 'shop') {
    const slugs = globalThis.ecomShopSlugs(site, job.shopInput);
    const resolved = await resolveShop(tabId, site, slugs);
    if (!resolved) {
      job.error = job.cancelled
        ? null
        : `toko "${job.shopInput}" tidak ditemukan atau tidak punya produk — tempel URL tokonya`;
      return;
    }
    shop = resolved.shop;
    job.slug = resolved.shop.slug;
    // The catalogue is the whole shop, so a keyword there is this job's filter.
    // A search the site ran already did the matching, and better.
    tokens = resolved.searched ? [] : keywordTokens(job.keyword);
    // The address page 1 actually came from. Pages 2..N are that same address
    // with the page number changed, so a run always walks the list it read
    // rather than one rebuilt from what it hoped the site would answer.
    template = resolved.template;
    pending = resolved.page;
  }

  const maxPages = pageBudget(job.target);

  for (let index = startIndex; index < startIndex + maxPages; index += 1) {
    if (job.cancelled) break;

    job.page = index + 1;
    let page = pending;
    pending = null;

    if (!page && job.mode !== 'page') {
      const wanted =
        job.mode === 'shop'
          ? site.pagedUrl(template, index)
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
      // Only what is still missing, plus a few for the repeats. Filtering pages
      // is the exception: what survives the filter is not known until the whole
      // page has been read.
      const missing = Math.max(0, job.target - job.unique);
      const bounded = !tokens.length && job.target < 1e9;
      page = await scrapeTab(tabId, {
        autoScroll: true,
        ...(bounded ? { enough: missing + SCROLL_SPARE } : {}),
      });
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

    // Shopee's in-shop search runs on /search, which is not a storefront and so
    // states no seller anywhere — the same reason a keyword scrape stores
    // `shop-<id>` with no name. The storefront that resolved this job did state
    // it, and every row here is that shop by construction, so it is carried
    // over. Only onto rows whose id matches: a search page can still slip a
    // sponsored listing from elsewhere into the grid, and naming it after this
    // shop would be worse than leaving it unnamed.
    if (shop && (shop.name || shop.username)) {
      for (const item of matching) {
        if (shop.shopKey && item.shopKey !== shop.shopKey) continue;
        if (shop.name && !item.shopName) item.shopName = shop.name;
        if (shop.username && !item.shopUsername) item.shopUsername = shop.username;
      }
    }

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

    // Written after the page is filed rather than before it is read, so a saved
    // place always points at work already in the database. Resuming can then
    // only ever re-read a page, never skip one.
    if (job.mode !== 'page') await saveResume({ shop, template, tokens, seen });

    if (job.mode === 'page') break; // a single page is the whole job
    if (job.unique >= job.target) {
      job.ended = 'target';
      break;
    }

    // Nothing at all on the very first page is a broken run, not the end of the
    // results — say so rather than quietly walking further pages of the same
    // nothing.
    if (!page.items.length && job.pagesDone === 1) {
      job.error = `tidak ada kartu produk (${page.anchorsSeen} tautan) — halaman pencarian atau toko? sudah selesai memuat?`;
      break;
    }

    // A page past the first with no cards on it at all is the end of the
    // catalogue, and one of them is proof enough: the content script does not
    // answer zero until it has waited the full card timeout, so this is an
    // empty page rather than a slow one. Confirming it with a second load —
    // another navigation, another scroll budget — is the better part of half a
    // minute spent per shop learning what this page already said.
    if (!page.items.length) {
      job.ended = 'exhausted';
      break;
    }

    // A page that has cards but nothing new needs the second look, because that
    // is what the far end of both sites looks like: they keep serving pages past
    // the last real one, filled with the same recommendations.
    barrenPages = fresh.length ? 0 : barrenPages + 1;
    if (barrenPages >= 2) {
      job.ended = 'exhausted';
      break;
    }

    await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);
  }

  // Ran to the page ceiling with the target unmet and nothing wrong: a shop
  // bigger than `pageBudget` allowed for. Worth distinguishing from a shop that
  // ran out, because the answer to it is a second run rather than a shrug.
  if (!job.ended && !job.error && !job.cancelled && job.mode !== 'page') {
    job.ended = 'budget';
  }
}

/**
 * Run one job to completion.
 *
 * Split out of `startJob` for the batch queue, which is the one caller that has
 * to know when a shop has *finished* — the popup never did, because a job
 * outlives it. Everything about how a shop is walked is unchanged; this is the
 * same body, awaited instead of abandoned.
 *
 * @param spec What to scrape. `keyword`/`shop`/`target`, as the popup sends.
 * @param context.site Which marketplace, already resolved. A single scrape reads
 *   it off the tab; a batch is told which site each shop lives on.
 * @param context.tabId The tab to drive.
 * @param context.resume A saved place, or null.
 * @returns The finished job snapshot — including `error`, which is how a caller
 *   learns the run failed. This never rejects for a scraping failure.
 */
async function beginJob({ keyword, shop, target }, { site, tabId, resume = null }) {
  if (job?.running) return { ok: false, error: 'masih ada scrape yang berjalan' };

  const typed = String(keyword || '').trim();
  const shopInput = String(shop || '').trim();

  // No keyword and no shop typed? Use the term already in the address bar, so a
  // search the user ran by hand can still be paginated. With a shop named, the
  // address bar is not what the user meant, so it is ignored.
  let tabUrl = '';
  try {
    tabUrl = (await chrome.tabs.get(tabId)).url || '';
  } catch (err) {
    return { ok: false, error: 'tab ditutup' };
  }
  const fromTab = shopInput ? '' : globalThis.ecomKeywordFromUrl(tabUrl);
  const term = typed || fromTab;

  // A named shop is the strongest instruction: walk that shop's grid, and treat
  // any keyword as a filter over it. Without one, a keyword is a site search,
  // and without either there is only the page already open.
  const mode = shopInput ? 'shop' : term ? 'search' : 'page';

  const wanted = Number(target);
  const capped = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), 5_000) : DEFAULT_TARGET;

  await chrome.storage.local.set({
    [PREFS_KEY]: { target: capped, shop: shopInput, keyword: typed },
  });

  job = newJob(term, mode === 'page' ? Number.MAX_SAFE_INTEGER : capped, mode, shopInput);
  // Fixed for the life of the run, and shown in the popup while it walks: a
  // half-hour catalogue job must end up in the database it started in.
  job.destination = (await getConfig()).destination;
  if (resume) {
    // Carry the counts across so the popup keeps reporting the run, not the
    // fragment of it that happens to be running now.
    job.slug = resume.slug || null;
    job.unique = resume.unique || 0;
    job.stored = resume.stored || 0;
    job.unchanged = resume.unchanged || 0;
    job.skipped = resume.skipped || 0;
    job.filtered = resume.filtered || 0;
    job.pagesDone = resume.page || 0;
  } else {
    // A new run replaces any saved place: two jobs sharing one is how a resume
    // ends up continuing the wrong walk.
    await clearResume();
  }
  broadcast();
  startKeepAlive();

  const done = (async () => {
    try {
      await runJob(tabId, site, resume);
    } catch (err) {
      job.error = String(err?.message || err);
    } finally {
      job.running = false;
      job.status = job.cancelled
        ? 'dibatalkan'
        : job.ended === 'exhausted'
          ? 'selesai — semua produk toko ini'
          : job.ended === 'budget'
            ? 'selesai — berhenti di batas halaman'
            : 'selesai';
      // A run that reached its target or ran out of results has nowhere left to
      // continue from. One that stopped on an error or a cancel does, and that
      // is exactly when the saved place earns its keep.
      if (!job.error && !job.cancelled) await clearResume();
      // A sweep is still going after one of its shops ends, and the worker has
      // to stay alive for the next one. Without this check the keep-alive died
      // between every pair of shops, which is where MV3 evicts.
      if (!batchRunner.isRunning()) stopKeepAlive();
      broadcast();
    }
    return snapshot();
  })();

  return { ok: true, done };
}

/**
 * Which tab a run should drive, and which marketplace it is on.
 *
 * @param marketplace Name a batch was handed, or null to read the active tab.
 */
async function resolveRunTab(marketplace = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (marketplace) {
    const site = globalThis.ecomSiteFor(marketplace);
    if (!site) return { ok: false, error: `marketplace tidak dikenal: ${marketplace}` };

    // The tab this sweep is already driving, before anything else is considered.
    // A sweep that opened its own tab opened it in the background, so from the
    // second shop on it is not the active tab any more — and without this the
    // check below found no marketplace tab under the user, opened another, and
    // a twenty-shop list left twenty tabs behind.
    if (batchTabId !== null) {
      try {
        await chrome.tabs.get(batchTabId);
        return { ok: true, site, tabId: batchTabId };
      } catch (err) {
        batchTabId = null; // closed mid-sweep: fall through and open a fresh one
      }
    }

    // Any tab will do — the storefront walk navigates to an absolute URL before
    // it reads anything, so the tab does not have to be on that site already.
    // Reusing the active marketplace tab keeps a sweep to one tab; anything else
    // gets a tab of its own rather than having the page under the user replaced.
    let current = null;
    try {
      current = globalThis.ecomSiteForHost(new URL(tab?.url || '').hostname);
    } catch (err) {
      /* not a marketplace tab */
    }
    if (tab?.id && current) return { ok: true, site, tabId: tab.id };

    const opened = await chrome.tabs.create({ url: site.homeUrl, active: false });
    return { ok: true, site, tabId: opened.id, opened: true };
  }

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
  return { ok: true, site, tabId: tab.id };
}

/**
 * Start a job and answer immediately. What the popup's button calls.
 *
 * The job outlives the popup, so waiting for it would mean answering a window
 * that has since closed. `beginJob` hands back the promise; this drops it.
 */
async function startJob({ keyword, shop, target }, resume = null) {
  const target_ = await resolveRunTab();
  if (!target_.ok) return { ok: false, error: target_.error };

  const started = await beginJob(
    { keyword, shop, target },
    { site: target_.site, tabId: target_.tabId, resume },
  );
  if (!started.ok) return started;
  started.done.catch(() => {}); // beginJob records failures on the job itself
  return { ok: true };
}

async function resumeJob() {
  const resume = await getResume();
  if (!resume) return { ok: false, error: 'tidak ada scrape yang bisa dilanjutkan' };
  return startJob(
    { keyword: resume.keyword, shop: resume.shopInput, target: resume.target },
    resume,
  );
}

// ---------------------------------------------------------------------------
// The batch: every shop on the server's list, one after another
// ---------------------------------------------------------------------------

//: Where a sweep's place is kept. Its own key, separate from RESUME_KEY: the two
//: answer different questions — "which shop" and "which page of it" — and a
//: sweep needs both to continue where it stopped.
const BATCH_KEY = 'batch';

//: The tab a sweep drives, held for its whole run so twenty shops share one tab
//: rather than opening twenty. Reset when the sweep ends; a tab the user closed
//: mid-sweep is reported by `beginJob` as "tab ditutup" and costs one shop.
let batchTabId = null;

/** Ask the ingest server which shops to walk. */
async function fetchShopList() {
  const { endpoint, token } = await getConfig();
  if (!token) return { ok: false, error: 'belum ada token — buka pengaturan dan pasangkan dulu' };

  let response;
  try {
    response = await fetch(`${endpoint}/shops`, { headers: { 'X-Ingest-Token': token } });
  } catch (err) {
    return { ok: false, error: `tidak bisa menghubungi ${endpoint} — server ingest jalan?` };
  }
  if (response.status === 401) return { ok: false, error: 'token ditolak server ingest' };
  if (response.status === 404) {
    // An older server. Said plainly, because the fix is on the machine running
    // it and nothing in the extension can do anything about it.
    return { ok: false, error: 'server ingest ini belum punya /shops — perbarui lalu restart' };
  }
  if (!response.ok) return { ok: false, error: `server menjawab HTTP ${response.status}` };

  const body = await response.json().catch(() => null);
  const shops = Array.isArray(body?.shops) ? body.shops : [];
  if (!shops.length && body?.detail) return { ok: false, error: body.detail };
  return { ok: true, shops };
}

const batchRunner = globalThis.ecomCreateBatchRunner({
  fetchShops: fetchShopList,

  //: One shop, start to finish. The queue awaits this; everything about *how* a
  //: storefront is walked is the same code a single scrape runs.
  runShop: async ({ marketplace, slug, target, useResume }) => {
    const tab = await resolveRunTab(marketplace);
    if (!tab.ok) throw new Error(tab.error);
    batchTabId = tab.tabId;

    const resume = useResume ? await getResume() : null;
    const started = await beginJob(
      { keyword: '', shop: slug, target },
      { site: tab.site, tabId: tab.tabId, resume },
    );
    if (!started.ok) throw new Error(started.error);
    return started.done;
  },

  cancelShop: () => {
    if (job?.running) {
      job.cancelled = true;
      setStatus('menghentikan…');
    }
  },

  saveState: async (state) => {
    try {
      if (state === null) {
        await chrome.storage.local.remove(BATCH_KEY);
        batchTabId = null;
      } else {
        await chrome.storage.local.set({ [BATCH_KEY]: state });
      }
    } catch (err) {
      /* storage full or unavailable: the sweep continues, it just cannot resume */
    }
  },

  loadState: async () => {
    try {
      return (await chrome.storage.local.get([BATCH_KEY]))[BATCH_KEY] || null;
    } catch (err) {
      return null;
    }
  },

  //: Whether `background.js` is holding a mid-shop place. The queue asks before
  //: handing one to the first shop of a resumed sweep — see `useResumeOnce`.
  hasShopResume: () => Boolean(pendingShopResume),

  onChange: () => broadcast(),
  sleep,
  now: () => Date.now(),
});

//: Read once when the popup asks to resume, because `hasShopResume` has to
//: answer synchronously and `getResume` does not. Refreshed on every resume
//: request, so it never outlives the run it describes.
let pendingShopResume = false;

async function startBatch({ target }) {
  const wanted = Number(target);
  const capped =
    Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), 5_000) : DEFAULT_TARGET;
  pendingShopResume = false;
  startKeepAlive();
  const answer = await batchRunner.start({ target: capped });
  if (!answer.ok) stopKeepAlive();
  return answer;
}

async function resumeBatch() {
  pendingShopResume = Boolean(await getResume());
  startKeepAlive();
  const answer = await batchRunner.resume();
  if (!answer.ok) stopKeepAlive();
  return answer;
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

  if (message?.type === 'resume') {
    resumeJob().then(sendResponse);
    return true;
  }

  if (message?.type === 'pair') {
    pairWithServer().then(sendResponse);
    return true;
  }

  if (message?.type === 'startBatch') {
    startBatch(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'resumeBatch') {
    resumeBatch().then(sendResponse);
    return true;
  }

  if (message?.type === 'retryFailed') {
    batchRunner.retryFailed().then((answer) => {
      if (answer.ok) startKeepAlive();
      sendResponse(answer);
    });
    return true;
  }

  if (message?.type === 'cancel') {
    // One button, and it means "stop what is running". During a sweep that is
    // the sweep — cancelling only the shop would have the queue start the next
    // one a second later, which reads as a cancel that did not work.
    if (batchRunner.isRunning()) {
      batchRunner.cancel();
    } else if (job?.running) {
      job.cancelled = true;
      setStatus('menghentikan…');
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'context') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const { endpoint, token, destination } = await getConfig();
      const prefs = await getPrefs();
      // A run under way owns the destination: showing the stored one next to
      // its progress would name a database the run is not writing to.
      const showing = job?.running ? job.destination : destination;

      let site = null;
      try {
        site = globalThis.ecomSiteForHost(new URL(tab?.url || '').hostname);
      } catch (err) {
        /* not a URL we recognise */
      }

      // Everything that needs the server is gone from this reply. It used to be
      // fetched here — `/stats`, then `/health`, awaited in that order — and the
      // popup could not paint until both had answered. On loopback that was
      // invisible; against a deployment it is seconds, and it was seconds on
      // *every* click, because pressing Neon or Save re-asks for context.
      //
      // So the reply is now what this machine already knows, and the two
      // requests are fired without being awaited: whichever popup is open gets
      // a `server` message when they land, and one that has since closed simply
      // does not.
      // Stamped with the request it answers. Saving a token triggers a fresh
      // context, and the reply to the *previous* one — taken before the token
      // existed — was still in flight: it landed afterwards and overwrote
      // "tersimpan" with "belum ada token", which was true when it was asked
      // and false by the time it arrived.
      contextSeq += 1;
      const seq = contextSeq;
      readServerState(endpoint, token, showing).then((server) => {
        chrome.runtime.sendMessage({ type: 'server', seq, server }).catch(() => {});
      });

      // A tab already sitting on a storefront pre-fills the shop box: that is
      // the shop the user is looking at, and retyping it would be busywork.
      let shopFromTab = '';
      try {
        shopFromTab = (site?.shopPage(new URL(tab.url)) || {}).username || '';
      } catch (err) {
        /* not a shop page */
      }

      // An interrupted run is offered rather than restarted: the tab it walked
      // may be showing something else entirely by now, and continuing is the
      // user's call, not a decision to make on their behalf while they were
      // away.
      const resume = job?.running ? null : await getResume();

      sendResponse({
        endpoint,
        hasToken: Boolean(token),
        marketplace: site ? site.label : null,
        // The tab first — a search the user is looking at is what they mean —
        // then the last word they searched for. Same shape as `shop` below.
        keyword: globalThis.ecomKeywordFromUrl(tab?.url || '') || prefs.keyword,
        shop: shopFromTab || prefs.shop,
        target: prefs.target,
        destination: showing,
        seq,
        job: snapshot(),
        batch: batchRunner.snapshot(),
        // An interrupted sweep, offered the same way an interrupted shop is:
        // continuing navigates twenty storefronts, and that is not something to
        // start on someone's behalf because they happened to open the popup.
        batchResume: await batchRunner.offer(),
        resume: resume
          ? {
              shopInput: resume.shopInput,
              keyword: resume.keyword,
              unique: resume.unique,
              target: resume.target,
              page: resume.page,
            }
          : null,
      });
    })();
    return true;
  }

  return false;
});
