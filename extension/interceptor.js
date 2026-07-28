// Runs in the page's MAIN world at document_start, before Shopee's own bundle.
//
// Its entire job is to *observe*. It wraps fetch and XMLHttpRequest so that when
// the page fetches its own listing data — which it does anyway, as you browse —
// a copy of the response body is handed to the extension. It never issues a
// request, never changes a request, never changes what the page receives.
//
// That "no extra requests" property is the whole design. The scraper's own HTTP
// client is refused by Shopee's anti-bot layer; an ordinary person browsing in
// their own Chrome is not. So the collector rides along with real browsing
// instead of generating traffic of its own, and Shopee sees exactly the load it
// would have seen anyway.
//
// MAIN world cannot use chrome.runtime, so results go out via window.postMessage
// and bridge.js relays them.

(() => {
  'use strict';

  const CHANNEL = 'ECOM_SCRAPER_CAPTURE';

  // Paths worth forwarding. Keep this in step with CAPTURED_PATHS in
  // scraper/ingest.py — the server drops anything else, this just avoids
  // shipping obvious noise across the bridge.
  const WANTED = [
    '/api/v4/search/search_items',
    '/api/v4/shop/rcmd_items',
    '/api/v4/shop/get_shop_seo',
    '/api/v4/recommend/recommend',
    '/api/v4/pdp/get_pc',
  ];

  // Bodies get big; a search page is a few hundred KB. Anything wildly beyond
  // that is not a listing payload and is not worth relaying.
  const MAX_BODY_BYTES = 4 * 1024 * 1024;

  function isWanted(url) {
    if (typeof url !== 'string') return false;
    return WANTED.some((path) => url.includes(path));
  }

  // Diagnostics. When nothing is captured, the question is always the same:
  // did this script run at all, and what API paths did the page actually call?
  // Guessing at that from outside costs a round trip per guess, so report it.
  function observe(url) {
    if (typeof url !== 'string' || !url.includes('/api/')) return;
    try {
      const path = new URL(url, window.location.origin).pathname;
      window.postMessage(
        { source: CHANNEL, kind: 'observed', path },
        window.location.origin,
      );
    } catch (err) {
      /* not a parseable URL; nothing to report */
    }
  }

  // Announce injection immediately, so "captured 0" can be told apart from
  // "the content script never ran".
  window.postMessage(
    { source: CHANNEL, kind: 'injected', href: window.location.href },
    window.location.origin,
  );

  // Shopee renders the first page of results server-side: the listing JSON is
  // embedded in the HTML, and no XHR carries it. Only later pages and scroll
  // loads go over the network. Sweep the inline state once the DOM is parsed so
  // the first screenful is not silently missed.
  function sweepInlineState() {
    const KEYS = ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__STORE__'];
    for (const key of KEYS) {
      const blob = window[key];
      if (!blob) continue;
      try {
        window.postMessage(
          {
            source: CHANNEL,
            kind: 'capture',
            url: `${window.location.origin}/api/v4/search/search_items#inline:${key}`,
            payload: blob,
            capturedAt: new Date().toISOString(),
          },
          window.location.origin,
        );
      } catch (err) {
        /* not structured-cloneable */
      }
    }

    // Also scan JSON <script> blocks, which is where Shopee has historically
    // parked the SSR payload.
    for (const node of document.querySelectorAll('script[type="application/json"]')) {
      const text = node.textContent || '';
      if (text.length < 200 || text.length > MAX_BODY_BYTES) continue;
      if (!text.includes('itemid') && !text.includes('item_basic')) continue;
      try {
        window.postMessage(
          {
            source: CHANNEL,
            kind: 'capture',
            url: `${window.location.origin}/api/v4/search/search_items#inline:script`,
            payload: JSON.parse(text),
            capturedAt: new Date().toISOString(),
          },
          window.location.origin,
        );
      } catch (err) {
        /* not JSON we can use */
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(sweepInlineState, 1500));
  } else {
    setTimeout(sweepInlineState, 1500);
  }

  function publish(url, bodyText) {
    if (!bodyText || bodyText.length > MAX_BODY_BYTES) return;
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (err) {
      return; // not JSON: a challenge page or an HTML error, nothing to store
    }
    // Shopee answers a refusal with HTTP 200 and a tiny {"error": 90309999}
    // envelope. Forwarding those would fill the log with non-data.
    if (payload && typeof payload === 'object' && payload.error) return;

    try {
      window.postMessage(
        {
          source: CHANNEL,
          kind: 'capture',
          url: String(url),
          payload,
          capturedAt: new Date().toISOString(),
        },
        window.location.origin,
      );
    } catch (err) {
      /* postMessage can throw on payloads that will not structured-clone */
    }
  }

  // --- fetch -------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const request = args[0];
      const url =
        typeof request === 'string'
          ? request
          : request && typeof request.url === 'string'
            ? request.url
            : '';

      observe(url);
      const pending = nativeFetch.apply(this, args);
      if (!isWanted(url)) return pending;

      return pending.then((response) => {
        // clone() so the page still gets an unread, untouched body. Reading the
        // original would break Shopee's own rendering.
        try {
          response
            .clone()
            .text()
            .then((text) => publish(url, text))
            .catch(() => {});
        } catch (err) {
          /* opaque or already-consumed responses cannot be cloned */
        }
        return response;
      });
    };
  }

  // --- XMLHttpRequest ----------------------------------------------------
  // Shopee's SDK patches both fetch and XHR, and different builds use different
  // ones. Wrapping only fetch silently misses half the traffic.
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__ecomScraperUrl = url;
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    const url = this.__ecomScraperUrl;
    observe(url);
    if (isWanted(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            publish(url, this.responseText);
          } else if (this.responseType === 'json' && this.response) {
            publish(url, JSON.stringify(this.response));
          }
        } catch (err) {
          /* never let observation break the page */
        }
      });
    }
    return nativeSend.apply(this, args);
  };
})();
