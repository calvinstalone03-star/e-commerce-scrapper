// Service worker: run a scrape on demand and post the result to the local
// ingest server.
//
// There is no queue, no alarm and no buffering here any more. Those existed for
// a network interceptor that watched Shopee's XHR traffic — which turned out to
// be a dead end, because the search endpoint answers this project with an empty
// items array. Scraping is now user-triggered and synchronous: one click, one
// page, one POST. A worker that only wakes on a click has nothing to survive,
// so the state that used to guard against MV3 teardown is gone with it.

importScripts('sites.js');

const ENDPOINT_KEY = 'endpoint';
const TOKEN_KEY = 'token';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

async function getConfig() {
  const stored = await chrome.storage.local.get([ENDPOINT_KEY, TOKEN_KEY]);
  return {
    endpoint: stored[ENDPOINT_KEY] || DEFAULT_ENDPOINT,
    token: stored[TOKEN_KEY] || '',
  };
}

async function ensureScraper(tabId) {
  // The content scripts are declared in the manifest, but a tab opened before
  // the extension was loaded or reloaded has no copy of them. Injecting on
  // demand means the user never has to think about reload order — the single
  // most common way this looked broken.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['sites.js', 'dom-scraper.js'],
    });
  } catch (err) {
    /* already present, or the tab is not scriptable */
  }
}

async function scrapeTab(tabId) {
  await ensureScraper(tabId);

  let page;
  try {
    page = await chrome.tabs.sendMessage(tabId, { type: 'scrapeDom' });
  } catch (err) {
    return { ok: false, error: 'could not reach the page — reload the tab and retry' };
  }

  if (!page?.ok) return { ok: false, error: page?.error || 'the page returned nothing' };

  if (!page.items.length) {
    return {
      ok: false,
      error: `no product cards found (${page.anchorsSeen} links). Is this a search or shop page, and have the results finished loading?`,
    };
  }

  const { endpoint, token } = await getConfig();
  if (!token) return { ok: false, error: 'no ingest token — open settings and paste it' };

  let response;
  try {
    response = await fetch(`${endpoint}/ingest-dom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({
        marketplace: page.marketplace,
        pageUrl: page.pageUrl,
        scrapedAt: page.scrapedAt,
        items: page.items,
      }),
    });
  } catch (err) {
    return { ok: false, error: `cannot reach ${endpoint} — is 'ecom-scraper serve' running?` };
  }

  if (response.status === 401) return { ok: false, error: 'ingest token rejected' };
  if (!response.ok) return { ok: false, error: `server answered HTTP ${response.status}` };

  const body = await response.json().catch(() => ({}));
  return {
    ok: true,
    marketplace: page.marketplace,
    found: page.items.length,
    stored: body.stored || 0,
    unchanged: body.unchanged || 0,
    skipped: body.skipped || 0,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'scrape') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return sendResponse({ ok: false, error: 'no active tab' });

      if (message.keyword) {
        let site = null;
        try {
          site = globalThis.ecomSiteForHost(new URL(tab.url).hostname);
        } catch (err) {
          /* tab is not on a marketplace; handled below */
        }
        if (!site) {
          return sendResponse({
            ok: false,
            error: 'open a Shopee or Tokopedia tab first, then search from here',
          });
        }
        await chrome.tabs.update(tab.id, { url: site.searchUrl(message.keyword) });
        // No reliable "results are in" event exists from outside the page, so
        // this is a plain settle delay. Scrape again if it fires early.
        await new Promise((resolve) => setTimeout(resolve, message.waitMs || 6000));
      }

      sendResponse(await scrapeTab(tab.id));
    })();
    return true;
  }

  if (message?.type === 'context') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const { endpoint, token } = await getConfig();

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

      sendResponse({
        endpoint,
        hasToken: Boolean(token),
        marketplace: site ? site.label : null,
        stats,
      });
    })();
    return true;
  }

  return false;
});
