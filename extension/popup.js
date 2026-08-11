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

//: Labels for the two destinations, used in the totals caption. The buttons
//: carry their own text; this is the prose version.
const DESTINATION_LABEL = { local: 'lokal', neon: 'Neon' };

//: Loopback or not — the one distinction that changes what the popup can offer
//: and what advice is true.
const isLocal = (endpoint) =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(endpoint || ''));

let running = false;
//: One pairing attempt per popup. A refused window would otherwise be retried
//: on every re-render the pairing failure itself triggers.
let paired = false;
//: The last context the worker answered with. Kept so the plan line can be
//: redrawn as the user types without re-asking the server — that answer costs a
//: /health and a /stats round trip, and it does not change between keystrokes.
let lastContext = null;

function setResult(text, kind = 'muted') {
  $('result').textContent = text;
  $('result').className = kind;
}

/**
 * What pressing the button will do, said in words.
 *
 * The inputs are collapsed now, so the button carries arguments the reader
 * cannot see. This is the line that keeps that honest — and it reads off the
 * same three fields the run will use, not off what the tab looks like.
 */
function renderPlan(context) {
  const shop = $('shop').value.trim() || context.shop || '';
  const keyword = $('keyword').value.trim() || context.keyword || '';
  const target = Number($('target').value) || context.target;

  if (!context.marketplace) {
    $('plan').textContent = 'Buka halaman Shopee atau Tokopedia dulu.';
    return;
  }

  const what = shop
    ? `toko <b>${escapeHtml(shop)}</b>`
    : keyword
      ? `pencarian <b>${escapeHtml(keyword)}</b>`
      : 'halaman yang sedang terbuka';
  const filter = shop && keyword ? ` · kata kunci <b>${escapeHtml(keyword)}</b>` : '';
  const limit = shop || keyword ? ` · sampai <b>${target}</b> produk` : '';
  const where = isLocal(context.endpoint) ? 'server lokal' : 'server awan';
  $('plan').innerHTML = `Akan mengambil ${what}${filter}${limit}. <span class="muted">→ ${where}</span>`;
}

//: The three fields are user input rendered back as HTML, so they are escaped.
//: A shop name is not markup.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

//: What the primary button says. "Scrape toko ini" is the whole point of the
//: collapsed form: on a storefront the shop is already known, so the button can
//: name the thing rather than the mechanism.
function scrapeLabel(context) {
  if (running) return 'Batal';
  const shop = $('shop').value.trim() || context?.shop;
  if (shop) return 'Scrape toko ini';
  if ($('keyword').value.trim() || context?.keyword) return 'Cari & scrape';
  return 'Scrape halaman ini';
}

function renderJob(job) {
  running = Boolean(job?.running);

  $('scrape').textContent = running ? 'Batal' : 'Mulai scrape';
  $('scrape').classList.toggle('stop', running);
  for (const id of ['keyword', 'shop', 'target']) $(id).disabled = running;
  // Locked while a job runs, because the job's destination is fixed at its
  // start: a control that moved but changed nothing would be a lie.
  for (const id of ['dlocal', 'dneon']) $(id).disabled = running || $(id).dataset.off === '1';

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

// Which database this run files into, and which one the totals below are
// counted in. Availability comes from the server rather than from a guess here:
// the Neon destination exists only when the ingest server has NEON_DATABASE_URL,
// and a button that accepted the click and then failed the scrape would be worse
// than one that is visibly off.
function renderDestination(context) {
  const chosen = context.destination || 'local';
  // Null until the server answers, and that is not the same as "neon is not
  // configured". Assuming the pessimistic shape while the answer is in flight
  // greyed out the button the user was reaching for, and hid the switch
  // entirely for the moment before it arrived.
  const available = context.targets;

  // One configured database is not a choice. Hiding the switch is what lets a
  // fresh install have nothing to decide: the server already knows where its
  // rows go. Unknown is not one choice, so the switch stays.
  const configured = available ? Object.values(available).filter(Boolean).length : 2;
  $('dest').classList.toggle('solo', configured < 2);

  for (const [id, name] of [['dlocal', 'local'], ['dneon', 'neon']]) {
    const button = $(id);
    const off = available ? available[name] === false : false;
    button.classList.toggle('on', chosen === name);
    button.dataset.off = off ? '1' : '0';
    button.disabled = off || running;
    button.title = off
      ? 'server ingest belum punya NEON_DATABASE_URL di .env'
      : `simpan hasil scrape ke database ${DESTINATION_LABEL[name]}`;
  }

  $('tlabel').textContent = `isi database ${DESTINATION_LABEL[chosen] || chosen}`;
}

async function refresh() {
  const context = await chrome.runtime.sendMessage({ type: 'context' });
  if (!context) return;
  lastContext = context;

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

  renderDestination(context);
  renderPlan(context);
  // Not '–': that is what "the server said zero" looks like. A run of dots says
  // the answer is still in flight, which on a hosted server it will be for a
  // moment.
  for (const id of ['tproducts', 'tsnapshots', 'tstores']) {
    if (!$(id).dataset.filled) $(id).textContent = '…';
  }

  $('endpoint').value = context.endpoint;
  // Pairing fills this by itself; the box stays for the case pairing cannot
  // cover — a server on another machine, or a window that has closed.
  $('token').placeholder = context.hasToken
    ? '•••••••• tersimpan'
    : 'jalankan: ecom-scraper pair';

  // A run the worker lost — MV3 evicted it, or the tab went away mid-walk. The
  // database already holds every page it filed, so this offers the rest rather
  // than the whole thing again.
  if (context.resume && !context.job?.running) {
    const what = context.resume.shopInput
      ? `toko "${context.resume.shopInput}"`
      : `"${context.resume.keyword}"`;
    $('rtext').textContent =
      `Scrape ${what} berhenti di halaman ${context.resume.page} ` +
      `(${context.resume.unique}/${context.resume.target} produk).`;
    $('resume').classList.add('on');
  } else {
    $('resume').classList.remove('on');
  }

  renderJob(context.job);
  // After renderJob, which owns the running/cancel state and would otherwise
  // overwrite the label with the generic one.
  $('scrape').textContent = scrapeLabel(context);
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

// The plan line reads off these fields, so it has to follow them. Without this
// it would state the tab's shop while the box says something else. Redrawn from
// the cached context rather than by refreshing: no server round trip per key.
for (const id of ['keyword', 'shop', 'target']) {
  $(id).addEventListener('input', () => {
    if (!lastContext) return;
    renderPlan(lastContext);
    if (!running) $('scrape').textContent = scrapeLabel(lastContext);
  });
}

// Enter in either field starts the run, because that is what Enter does in a
// search box.
for (const id of ['keyword', 'shop', 'target']) {
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !running) start();
  });
}

$('rgo').addEventListener('click', async () => {
  $('resume').classList.remove('on');
  setResult('melanjutkan scrape…');
  const answer = await chrome.runtime.sendMessage({ type: 'resume' });
  if (!answer?.ok) setResult(answer?.error || 'gagal melanjutkan', 'bad');
});

// Switching destination re-reads the totals, because they are counted in the
// database that was just chosen — the fastest way to see that the two differ.
for (const id of ['dlocal', 'dneon']) {
  $(id).addEventListener('click', async () => {
    if (running) return;
    const destination = $(id).dataset.destination;
    // Drawn before it is stored, not after. Writing to chrome.storage and
    // re-asking the worker is fast, but it is not instant, and a toggle that
    // waits to move reads as a toggle that did not register — which is exactly
    // what it looked like while this also waited on the server.
    if (lastContext) renderDestination({ ...lastContext, destination });
    await chrome.storage.local.set({ destination });
    refresh();
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

  // Tested against `/stats`, which needs the token, rather than `/health`,
  // which does not. There are two servers now and they hold different tokens,
  // so "server terhubung" was true of a pairing that could never file a single
  // row: the token from one server pasted against the address of the other.
  // That combination stayed silent until the first scrape failed with a 401
  // naming nothing.
  setResult('menyimpan…', 'muted');
  const saved = token || (await chrome.storage.local.get(['token'])).token || '';
  try {
    const response = await fetch(`${endpoint}/stats`, { headers: { 'X-Ingest-Token': saved } });
    if (response.ok) {
      setResult('tersimpan — token diterima server ini', 'ok');
    } else if (response.status === 401) {
      setResult(`tersimpan, tapi ${endpoint} menolak token ini — token milik server lain?`, 'bad');
    } else {
      setResult(`tersimpan, server balas HTTP ${response.status}`, 'bad');
    }
  } catch (err) {
    setResult(`tersimpan, tapi ${endpoint} tidak bisa dihubungi`, 'bad');
  }
  refresh();
});

/**
 * The half of the popup that needs the server, applied when the server answers.
 *
 * Separated from `refresh` because the two have completely different costs. The
 * tab, the prefs and the destination are already on this machine and render in
 * a frame; totals, pairing and staleness are a round trip to an ingest server
 * that may be a continent away. Waiting for the second before drawing the first
 * made every click — Neon, Lokal, Simpan — look like it had not registered.
 */
async function applyServer(state) {
  if (!state || !lastContext) return;
  const context = { ...lastContext, ...state };
  lastContext = context;

  renderDestination(context);

  // No token yet: ask the server for one rather than showing a box only a
  // developer could fill. The server answers while its pairing window is open;
  // when it refuses it says why, and that sentence is more useful than an empty
  // field. Guarded so a closed window cannot loop: one attempt per popup.
  if (!state.hasToken && state.pairing && !paired) {
    paired = true;
    const answer = await chrome.runtime.sendMessage({ type: 'pair' });
    if (answer?.ok) return refresh();
    setResult(answer?.error || 'gagal mengambil token', 'bad');
  } else if (!state.hasToken && !state.pairing) {
    // Two different servers, two different answers. Loopback can hand the token
    // over by itself and just refused, so `pair` is the fix; a hosted server
    // never will, and telling that user to run a command they do not have is
    // how a working install looks broken.
    setResult(
      isLocal(state.endpoint)
        ? 'extension belum berpasangan — jalankan `ecom-scraper pair`, lalu buka popup ini lagi'
        : 'belum ada token — ambil di halaman Panduan dashboard, lalu tempel lewat ikon ⚙',
      'bad',
    );
  }


  $('token').placeholder = context.hasToken
    ? '•••••••• tersimpan'
    : isLocal(context.endpoint)
      ? 'jalankan: ecom-scraper pair'
      : 'ambil di halaman Panduan dashboard';

  // A server running code older than the file on disk will keep reproducing
  // bugs that are already fixed, and nothing else in this popup would say so.
  if (state.stale) {
    setResult(
      'server ingest memakai kode lama — jalankan: launchctl kickstart -k gui/$UID/com.ecomscraper.ingest',
      'bad',
    );
  }

  if (state.stats) {
    $('tproducts').textContent = state.stats.products ?? '–';
    $('tsnapshots').textContent = state.stats.snapshots ?? '–';
    $('tstores').textContent = state.stats.stores ?? '–';
    for (const id of ['tproducts', 'tsnapshots', 'tstores']) $(id).dataset.filled = '1';
  } else {
    for (const id of ['tproducts', 'tsnapshots', 'tstores']) $(id).textContent = '–';
    // Three different reasons the totals are blank, and they take three
    // different actions. Collapsing them into "server tidak aktif" was wrong
    // twice over: the server was answering, and the fix it named does not exist
    // on a machine with no Python.
    if (!$('result').textContent) {
      if (!state.serverUp) {
        setResult(
          isLocal(state.endpoint)
            ? 'server ingest tidak bisa dihubungi — jalankan: ecom-scraper serve'
            : `tidak bisa menghubungi ${state.endpoint}`,
          'bad',
        );
      } else if (state.statsStatus === 401) {
        setResult(
          isLocal(state.endpoint)
            ? 'token ingest belum ada atau ditolak — jalankan: ecom-scraper pair, lalu buka popup ini lagi'
            : 'token ingest belum ada atau ditolak — ambil di halaman Panduan dashboard, lalu tempel lewat ikon ⚙',
          'bad',
        );
      } else if (state.statsStatus) {
        setResult(`server menjawab HTTP ${state.statsStatus} untuk /stats`, 'bad');
      }
    }
  }

}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'server') {
    applyServer(message.server);
    return;
  }
  if (message?.type !== 'progress') return;
  renderJob(message.job);
  // The totals only move when a page has been filed, so refreshing them per
  // page is enough and keeps the popup off the server between pages.
  if (!message.job?.running) refresh();
});

refresh();
