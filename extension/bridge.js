// ISOLATED-world content script. Relays captures from the MAIN world (which
// cannot reach chrome.runtime) to the service worker.
//
// It is also the trust boundary: window.postMessage is visible to the page, so
// anything arriving here is untrusted input from shopee.co.id. Validate shape,
// pin the origin, and never eval or act on it — it is data being forwarded to a
// local parser, nothing more.

(() => {
  'use strict';

  const CHANNEL = 'ECOM_SCRAPER_CAPTURE';

  window.addEventListener('message', (event) => {
    // Only messages this page posted to itself. Rejects anything injected by an
    // iframe or another origin.
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || data.source !== CHANNEL) return;

    try {
      if (data.kind === 'injected') {
        chrome.runtime.sendMessage({ type: 'injected', href: String(data.href || '') });
        return;
      }

      if (data.kind === 'observed') {
        chrome.runtime.sendMessage({ type: 'observed', path: String(data.path || '') });
        return;
      }

      if (typeof data.url !== 'string' || !data.payload) return;
      chrome.runtime.sendMessage({
        type: 'capture',
        url: data.url,
        payload: data.payload,
        capturedAt: typeof data.capturedAt === 'string' ? data.capturedAt : null,
      });
    } catch (err) {
      // The service worker is asleep or the extension was reloaded mid-page.
      // Dropping one capture is fine — the user is browsing, more will come.
    }
  });
})();
