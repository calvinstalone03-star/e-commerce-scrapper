// Popup. Deliberately thin: the service worker owns every decision, this only
// renders and dispatches.
//
// The marketplace is detected from the active tab rather than chosen from a
// dropdown — the tab already knows which site it is on, so asking would be
// asking the user to restate something visible. Server and token live behind
// the gear because they are set once and never touched again.

const $ = (id) => document.getElementById(id);

function setResult(text, kind = 'muted') {
  $('result').textContent = text;
  $('result').className = kind;
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
      setResult(`server tidak aktif — jalankan: ecom-scraper serve`, 'bad');
    }
  }
}

async function run(keyword) {
  $('scrape').disabled = true;
  setResult(keyword ? `mencari "${keyword}"…` : 'membaca halaman…');

  const result = await chrome.runtime.sendMessage({ type: 'scrape', keyword: keyword || null });

  if (result?.ok) {
    const parts = [`${result.found} produk`, `${result.stored} baru`];
    // Unchanged is not a failure — it is deduplication doing its job, and
    // hiding it would make a working repeat scrape look like it did nothing.
    if (result.unchanged) parts.push(`${result.unchanged} tidak berubah`);
    if (result.skipped) parts.push(`${result.skipped} dilewati`);
    setResult(parts.join(' · '), 'ok');
  } else {
    setResult(result?.error || 'gagal', 'bad');
  }

  $('scrape').disabled = false;
  refresh();
}

$('scrape').addEventListener('click', () => run(null));

$('keyword').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const keyword = $('keyword').value.trim();
  if (keyword) run(keyword);
});

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

refresh();
