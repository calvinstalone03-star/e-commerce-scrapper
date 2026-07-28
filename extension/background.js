// MV3 service worker: buffer captures and POST them to the local ingest server.
//
// The awkward constraint here is that an MV3 service worker is killed whenever
// Chrome feels like it — often within 30 seconds of going idle. Anything held
// only in a module-level variable is gone. So the queue lives in
// chrome.storage.local and every handler treats itself as possibly the first
// code to run after a cold start. An alarm re-drives the flush so a queue that
// built up while the server was down is not stranded.

const ENDPOINT_KEY = 'endpoint';
const TOKEN_KEY = 'token';
const QUEUE_KEY = 'queue';
const STATS_KEY = 'stats';
const ENABLED_KEY = 'enabled';
// Diagnostics: proof the content script ran, and every /api/ path the page
// actually called. Without these, "captured 0" is indistinguishable from "the
// script never injected" and every fix is a guess.
const DIAG_KEY = 'diag';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';
const FLUSH_ALARM = 'flush';

// Bound the queue. If the server is down for an hour of browsing this stops the
// extension quietly eating the storage quota; oldest entries are dropped first
// because newer prices are the ones worth having.
const MAX_QUEUE = 200;

async function getState() {
  const stored = await chrome.storage.local.get([
    ENDPOINT_KEY,
    TOKEN_KEY,
    QUEUE_KEY,
    STATS_KEY,
    ENABLED_KEY,
    DIAG_KEY,
  ]);
  return {
    endpoint: stored[ENDPOINT_KEY] || DEFAULT_ENDPOINT,
    token: stored[TOKEN_KEY] || '',
    queue: Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [],
    enabled: stored[ENABLED_KEY] !== false,
    diag: stored[DIAG_KEY] || { injectedAt: null, lastHref: null, paths: {} },
    stats: stored[STATS_KEY] || {
      captured: 0,
      stored: 0,
      dropped: 0,
      lastError: null,
      lastOk: null,
    },
  };
}

async function setStats(patch) {
  const { stats } = await getState();
  await chrome.storage.local.set({ [STATS_KEY]: { ...stats, ...patch } });
}

async function enqueue(entry) {
  const { queue, stats } = await getState();
  queue.push(entry);
  let dropped = stats.dropped || 0;
  while (queue.length > MAX_QUEUE) {
    queue.shift();
    dropped += 1;
  }
  await chrome.storage.local.set({
    [QUEUE_KEY]: queue,
    [STATS_KEY]: { ...stats, captured: (stats.captured || 0) + 1, dropped },
  });
}

// Single-flight guard. Two flushes racing would double-post the same entries,
// and every duplicate becomes a spurious extra row in price_snapshots.
let flushing = false;

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const { endpoint, token, queue } = await getState();
    if (!queue.length) return;
    if (!token) {
      await setStats({ lastError: 'no ingest token set — open the popup and paste it' });
      return;
    }

    const remaining = [...queue];
    let storedTotal = 0;

    while (remaining.length) {
      const entry = remaining[0];
      let response;
      try {
        response = await fetch(`${endpoint}/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Ingest-Token': token,
          },
          body: JSON.stringify(entry),
        });
      } catch (err) {
        // Server down. Keep everything still queued and try again on the alarm.
        await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
        await setStats({ lastError: `cannot reach ${endpoint} — is 'ecom-scraper serve' running?` });
        return;
      }

      if (response.status === 401) {
        await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
        await setStats({ lastError: 'ingest token rejected — re-copy it from the server' });
        return;
      }

      // Any other non-OK is about this specific payload, not the connection.
      // Drop it rather than blocking the queue behind one bad entry forever.
      remaining.shift();
      if (response.ok) {
        try {
          const body = await response.json();
          storedTotal += body.stored || 0;
        } catch (err) {
          /* server said OK; body shape is not critical */
        }
      }
      await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
    }

    const { stats } = await getState();
    await chrome.storage.local.set({
      [STATS_KEY]: {
        ...stats,
        stored: (stats.stored || 0) + storedTotal,
        lastError: null,
        lastOk: new Date().toISOString(),
      },
    });
  } finally {
    flushing = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'capture') {
    (async () => {
      const { enabled } = await getState();
      if (!enabled) return;
      await enqueue({
        url: message.url,
        payload: message.payload,
        capturedAt: message.capturedAt,
      });
      await flush();
    })();
    return false;
  }

  if (message?.type === 'injected') {
    (async () => {
      const { diag } = await getState();
      await chrome.storage.local.set({
        [DIAG_KEY]: {
          ...diag,
          injectedAt: new Date().toISOString(),
          lastHref: message.href || null,
        },
      });
    })();
    return false;
  }

  if (message?.type === 'observed') {
    (async () => {
      const { diag } = await getState();
      const paths = { ...(diag.paths || {}) };
      const path = message.path || '';
      if (path) paths[path] = (paths[path] || 0) + 1;
      // Bound it: a long session touches a lot of telemetry endpoints.
      const trimmed = Object.fromEntries(
        Object.entries(paths)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40),
      );
      await chrome.storage.local.set({ [DIAG_KEY]: { ...diag, paths: trimmed } });
    })();
    return false;
  }

  if (message?.type === 'resetDiag') {
    chrome.storage.local
      .set({ [DIAG_KEY]: { injectedAt: null, lastHref: null, paths: {} } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'flush') {
    flush().then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for the async response
  }

  if (message?.type === 'state') {
    getState().then((state) =>
      // Never hand the queue contents or the token back to the popup; it only
      // needs counts.
      sendResponse({
        endpoint: state.endpoint,
        hasToken: Boolean(state.token),
        enabled: state.enabled,
        queued: state.queue.length,
        stats: state.stats,
        diag: state.diag,
      }),
    );
    return true;
  }

  return false;
});

chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flush();
});
