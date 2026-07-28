// Popup: show counters, let the user point at the ingest server and paste the
// token, and surface diagnostics. Deliberately thin — the service worker owns
// all state, so the popup closing (which it does constantly) loses nothing.

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const node = $('status');
  node.textContent = text;
  node.className = kind || '';
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'state' });
  if (!state) return;

  $('captured').textContent = state.stats.captured ?? 0;
  $('stored').textContent = state.stats.stored ?? 0;
  $('queued').textContent = state.queued ?? 0;
  $('dropped').textContent = state.stats.dropped ?? 0;
  $('enabled').checked = state.enabled;
  $('endpoint').value = state.endpoint;
  // The token is never returned by the worker; show only whether one is set, so
  // the popup cannot become a place a token gets read off the screen.
  $('token').placeholder = state.hasToken
    ? '•••••••• (saved — type to replace)'
    : 'paste from: ecom-scraper serve';

  const diag = state.diag || {};
  $('injected').textContent = diag.injectedAt
    ? new Date(diag.injectedAt).toLocaleTimeString()
    : 'never — reload the Shopee tab';

  const paths = Object.entries(diag.paths || {}).sort(
    (a, b) => (b[1].max || 0) - (a[1].max || 0),
  );
  $('paths').textContent = paths.length
    ? paths
        .map(([path, v]) => {
          const kb = Math.round((v.max || 0) / 1024);
          return `${String(kb).padStart(5)}KB x${String(v.n).padEnd(3)} ${path}`;
        })
        .join('\n')
    : 'none seen yet';

  if (state.stats.lastError) {
    setStatus(state.stats.lastError, 'bad');
  } else if (state.stats.lastOk) {
    setStatus(`last sent ${new Date(state.stats.lastOk).toLocaleTimeString()}`, 'ok');
  } else {
    setStatus('Browse a Shopee search or shop page to start collecting.');
  }
}

$('save').addEventListener('click', async () => {
  const endpoint = $('endpoint').value.trim() || 'http://127.0.0.1:8787';
  const token = $('token').value.trim();

  const patch = { endpoint };
  if (token) patch.token = token; // empty means "keep the saved one"
  await chrome.storage.local.set(patch);
  $('token').value = '';

  try {
    const response = await fetch(`${endpoint}/health`);
    setStatus(
      response.ok
        ? 'Saved. Ingest server is reachable.'
        : `Saved, but the server answered HTTP ${response.status}.`,
      response.ok ? 'ok' : 'bad',
    );
  } catch (err) {
    setStatus(`Saved, but ${endpoint} is unreachable. Run: ecom-scraper serve`, 'bad');
  }
  refresh();
});

$('flush').addEventListener('click', async () => {
  setStatus('Sending…');
  await chrome.runtime.sendMessage({ type: 'flush' });
  refresh();
});

$('enabled').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ enabled: event.target.checked });
  refresh();
});

$('copydiag').addEventListener('click', async () => {
  const state = await chrome.runtime.sendMessage({ type: 'state' });
  const diag = state?.diag || {};
  const report = [
    `injectedAt: ${diag.injectedAt || 'never'}`,
    `lastHref:   ${diag.lastHref || '-'}`,
    `captured:   ${state?.stats?.captured ?? 0}`,
    `stored:     ${state?.stats?.stored ?? 0}`,
    `queued:     ${state?.queued ?? 0}`,
    `lastError:  ${state?.stats?.lastError || '-'}`,
    '',
    'paths:',
    ...Object.entries(diag.paths || {})
      .sort((a, b) => (b[1].max || 0) - (a[1].max || 0))
      .map(([path, v]) => `  ${Math.round((v.max || 0) / 1024)}KB x${v.n}  ${path}`),
  ].join('\n');
  await navigator.clipboard.writeText(report);
  setStatus('Diagnostics copied to clipboard.', 'ok');
});

$('resetdiag').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resetDiag' });
  refresh();
});

refresh();
