// Popup. Deliberately thin: the service worker owns every decision, this only
// renders and dispatches.
//
// The marketplace is detected from the active tab rather than chosen from a
// dropdown — the tab already knows which site it is on, so asking would be
// asking the user to restate something visible. Server and token live behind
// the gear because they are set once and never touched again.
//
// A job outlives the popup: closing this window does not stop a scrape, and
// re-opening it re-attaches to the running job rather than starting a second
// one. That is why nothing here awaits a scrape's completion — it renders the
// progress the worker broadcasts, and asks for the current state on open.

const $ = (id) => document.getElementById(id);

let running = false;

function setResult(text, kind = 'muted') {
  $('result').textContent = text;
  $('result').className = kind;
}

function renderJob(job) {
  running = Boolean(job?.running);

  $('scrape').textContent = running ? 'Batal' : 'Mulai scrape';
  $('scrape').classList.toggle('stop', running);
  for (const id of ['keyword', 'shop', 'target']) $(id).disabled = running;

  if (!job) {
    $('progress').classList.remove('on');
    return;
  }

  $('progress').classList.add('on');

  // Re-opened mid-run: show the job's own inputs, not whatever this fresh popup
  // happened to default to.
  if (running) {
    $('keyword').value = job.keyword || '';
    $('shop').value = job.shopInput || '';
    if (Number.isFinite(job.target) && job.target < 1e9) $('target').value = job.target;
  }

  // A single-page scrape has no meaningful target, so it reports a count rather
  // than a fraction — a progress bar against MAX_SAFE_INTEGER would be a lie.
  const finite = Number.isFinite(job.target) && job.target < 1e9;
  const label = finite ? `${job.unique}/${job.target} produk` : `${job.unique} produk`;
  const where = job.slug ? ` · ${job.slug}` : '';
  $('ptext').textContent = `${label} · hal ${job.page}${where} · ${job.status}`;
  $('bar').firstElementChild.style.width = finite
    ? `${Math.min(100, Math.round((job.unique / job.target) * 100))}%`
    : running
      ? '100%'
      : '0%';

  if (job.running) return;

  if (job.error) {
    setResult(job.error, 'bad');
    return;
  }

  const parts = [`${job.unique} produk`, `${job.stored} baru`];
  // Unchanged is not a failure — it is deduplication doing its job, and hiding
  // it would make a working repeat scrape look like it did nothing.
  if (job.unchanged) parts.push(`${job.unchanged} tidak berubah`);
  if (job.skipped) parts.push(`${job.skipped} dilewati`);
  // In shop mode most of the grid is usually filtered out, and a run that says
  // "3 produk" without saying "412 tidak cocok" reads as a broken scrape.
  if (job.filtered) parts.push(`${job.filtered} tidak cocok`);
  parts.push(`${job.pagesDone} halaman`);
  setResult(parts.join(' · '), job.cancelled ? 'muted' : 'ok');
}

async function refresh() {
  const context = await chrome.runtime.sendMessage({ type: 'context' });
  if (!context) return;

  const site = $('site');
  if (context.marketplace) {
    site.textContent = context.marketplace;
    site.className = '';
    $('scrape').disabled = false;
  } else {
    site.textContent = 'buka tab Shopee / Tokopedia';
    site.className = 'off';
    $('scrape').disabled = true;
  }

  // Pre-fill from the tab: if the user is already looking at a search or a
  // storefront, that is what they mean, and retyping it would be busywork.
  if (!context.job?.running) {
    if (!$('keyword').value) $('keyword').value = context.keyword || '';
    if (!$('shop').value) $('shop').value = context.shop || '';
    $('target').value = context.target;
  }

  $('endpoint').value = context.endpoint;
  $('token').placeholder = context.hasToken
    ? '•••••••• tersimpan'
    : 'dari: ecom-scraper serve';

  if (context.stats) {
    $('tproducts').textContent = context.stats.products ?? '–';
    $('tsnapshots').textContent = context.stats.snapshots ?? '–';
    $('tstores').textContent = context.stats.stores ?? '–';
  } else {
    for (const id of ['tproducts', 'tsnapshots', 'tstores']) $(id).textContent = '–';
    if (!$('result').textContent) {
      setResult('server tidak aktif — jalankan: ecom-scraper serve', 'bad');
    }
  }

  renderJob(context.job);
}

async function start() {
  const keyword = $('keyword').value.trim();
  const shop = $('shop').value.trim();
  const target = Number($('target').value) || 60;

  const what = shop
    ? `toko "${shop}"${keyword ? ` · "${keyword}"` : ''}…`
    : keyword
      ? `mencari "${keyword}"…`
      : 'membaca halaman…';
  setResult(what);

  const answer = await chrome.runtime.sendMessage({ type: 'start', keyword, shop, target });
  if (!answer?.ok) setResult(answer?.error || 'gagal', 'bad');
}

// One button, two jobs: the same click that starts a scrape stops it. Anything
// else needs a second control that is disabled 95% of the time.
$('scrape').addEventListener('click', () => {
  if (running) {
    chrome.runtime.sendMessage({ type: 'cancel' });
  } else {
    start();
  }
});

// Enter in either field starts the run, because that is what Enter does in a
// search box.
for (const id of ['keyword', 'shop', 'target']) {
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !running) start();
  });
}

$('gear').addEventListener('click', () => {
  $('settings').classList.toggle('open');
});

$('save').addEventListener('click', async () => {
  const endpoint = $('endpoint').value.trim() || 'http://127.0.0.1:8787';
  const token = $('token').value.trim();

  const patch = { endpoint };
  if (token) patch.token = token; // blank means "keep what is stored"
  await chrome.storage.local.set(patch);
  $('token').value = '';

  try {
    const response = await fetch(`${endpoint}/health`);
    setResult(response.ok ? 'tersimpan, server terhubung' : `server balas HTTP ${response.status}`,
      response.ok ? 'ok' : 'bad');
  } catch (err) {
    setResult(`tersimpan, tapi ${endpoint} tidak bisa dihubungi`, 'bad');
  }
  refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'progress') return;
  renderJob(message.job);
  // The totals only move when a page has been filed, so refreshing them per
  // page is enough and keeps the popup off the server between pages.
  if (!message.job?.running) refresh();
});

refresh();
