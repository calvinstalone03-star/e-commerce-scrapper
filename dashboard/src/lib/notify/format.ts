import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import { absolute, newProductLink, newStoreLink, priceChangeLink } from '@/lib/notify/links';

/**
 * The digest, as Telegram HTML.
 *
 * HTML rather than MarkdownV2: MarkdownV2 requires escaping some fifteen
 * characters, and these listing names are full of `(`, `)`, `-`, `.` and `–`.
 * One missed character is a 400 for the entire message. HTML needs three.
 *
 * Pure: no network, no database, no clock of its own. Everything that varies
 * arrives as an argument, so the cases that matter — folding, escaping,
 * splitting — are testable without any of it.
 */

export const TELEGRAM_MAX_CHARS = 4096;

/** Below this, listings that moved by the same amount are a coincidence. */
export const FOLD_MIN_GROUP = 3;

const rupiah = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});
const plain = new Intl.NumberFormat('id-ID');
const stamp = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Jakarta',
});

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value: number): string {
  return rupiah.format(value);
}

function signedMoney(value: number): string {
  return `${value > 0 ? '+' : '−'}${money(Math.abs(value))}`;
}

function percent(from: number, to: number): string {
  if (from === 0) return '';
  const pct = ((to - from) / from) * 100;
  const sign = pct > 0 ? '+' : '−';
  return `${sign}${Math.abs(pct).toFixed(1).replace('.', ',')}%`;
}

function link(baseUrl: string, path: string, label: string): string {
  // The href is escaped too: `/pricing?kanal=x&q=y` carries a bare `&`, which is
  // not valid inside an HTML attribute and which Telegram rejects.
  return `<a href="${escapeHtml(absolute(baseUrl, path))}">${escapeHtml(label)}</a>`;
}

function shopLabel(username: string | null, marketplace: string): string {
  const shop = username ?? 'toko tak dikenal';
  const channel = marketplace === 'tokopedia' ? 'Tokopedia' : 'Shopee';
  return `${shop} · ${channel}`;
}

export type FoldedGroup =
  | {
      kind: 'folded';
      username: string | null;
      marketplace: string;
      delta: number;
      members: PriceChange[];
    }
  | { kind: 'single'; change: PriceChange };

function delta(change: PriceChange): number {
  return Number(change.price) - Number(change.previousPrice);
}

/**
 * Collapse a store's simultaneous identical moves into one line.
 *
 * A shop that repriced its whole catalogue made one decision, and printing it
 * as 33 lines that each say the same thing buries everything else in the
 * digest. Keyed on store **and** signed delta, so a rise never folds into a
 * fall of the same size.
 */
export function foldPriceChanges(changes: PriceChange[]): FoldedGroup[] {
  const groups = new Map<string, PriceChange[]>();
  for (const change of changes) {
    const key = `${change.storeId ?? 'null'}|${delta(change)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(change);
    else groups.set(key, [change]);
  }

  const folded: FoldedGroup[] = [];
  for (const members of groups.values()) {
    if (members.length >= FOLD_MIN_GROUP) {
      folded.push({
        kind: 'folded',
        username: members[0].username,
        marketplace: members[0].marketplace,
        delta: delta(members[0]),
        members,
      });
    } else {
      for (const change of members) folded.push({ kind: 'single', change });
    }
  }

  // Biggest proportional move first, whether folded or not: a listing that
  // moved 66,7% deserves to be read before one that moved 1,3%.
  const weight = (entry: FoldedGroup): number =>
    entry.kind === 'folded'
      ? Math.abs(delta(entry.members[0]) / Number(entry.members[0].previousPrice))
      : Math.abs(delta(entry.change) / Number(entry.change.previousPrice));

  return folded.sort((left, right) => weight(right) - weight(left));
}

function renderPriceGroup(
  heading: string,
  changes: PriceChange[],
  baseUrl: string,
): string[] {
  if (changes.length === 0) return [];

  // The heading always states the true total, even when the body below it is
  // later truncated for length. A count that shrinks with the message would be
  // a lie about how much moved.
  const lines = [`<b>${escapeHtml(heading)} — ${plain.format(changes.length)}</b>`, ''];

  for (const entry of foldPriceChanges(changes)) {
    if (entry.kind === 'folded') {
      lines.push(`  <b>${escapeHtml(shopLabel(entry.username, entry.marketplace))}</b>`);
      lines.push(
        `  ${escapeHtml(signedMoney(entry.delta))} serempak di ${plain.format(entry.members.length)} listing`,
      );
      lines.push(`  ${link(baseUrl, priceChangeLink(entry.members[0]), 'lihat listingnya')}`);
      lines.push('');
      continue;
    }

    const change = entry.change;
    const from = Number(change.previousPrice);
    const to = Number(change.price);
    lines.push(
      `  • ${escapeHtml(change.name ?? 'tanpa nama')} — ${escapeHtml(shopLabel(change.username, change.marketplace))}`,
    );
    lines.push(`    ${escapeHtml(`${money(from)} → ${money(to)}`)}  (${escapeHtml(percent(from, to))})`);
    lines.push(
      `    ${link(baseUrl, priceChangeLink(change), change.setCode ? `posisi kita di ${change.setCode}` : 'lihat di dashboard')}`,
    );
    lines.push('');
  }

  return lines;
}

function renderNewStores(stores: NewStore[], baseUrl: string): string[] {
  if (stores.length === 0) return [];
  const lines = [`<b>Toko baru — ${plain.format(stores.length)}</b>`, ''];
  for (const store of stores) {
    lines.push(
      `  • ${escapeHtml(store.name ?? store.username)} — ${escapeHtml(shopLabel(store.username, store.marketplace))}`,
    );
    lines.push(`    ${plain.format(store.products)} listing`);
    lines.push(`    ${link(baseUrl, newStoreLink(store), 'buka toko')}`);
    lines.push('');
  }
  return lines;
}

function renderNewProducts(products: NewProduct[], baseUrl: string): string[] {
  if (products.length === 0) return [];
  const lines = [`<b>Produk baru di toko lama — ${plain.format(products.length)}</b>`, ''];
  for (const product of products) {
    lines.push(
      `  • ${escapeHtml(product.name ?? 'tanpa nama')} — ${escapeHtml(shopLabel(product.username, product.marketplace))}  ${link(baseUrl, newProductLink(product), 'lihat')}`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * Pack lines into messages, splitting only between lines.
 *
 * A split inside a line can land inside an `<a href=...>`, which leaves an
 * unbalanced tag and makes Telegram reject the message. Splitting on line
 * boundaries cannot.
 *
 * A single line longer than the whole limit cannot be placed anywhere, so it is
 * hard-truncated — the only case where a character boundary is cut, and it is
 * the alternative to dropping the line entirely.
 */
function paginate(lines: string[]): string[] {
  const messages: string[] = [];
  let current: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    messages.push(current.join('\n').trimEnd());
    current = [];
    length = 0;
  };

  for (const raw of lines) {
    const line = raw.length > TELEGRAM_MAX_CHARS ? `${raw.slice(0, TELEGRAM_MAX_CHARS - 1)}…` : raw;
    // +1 for the newline that will join it to the previous line.
    if (length + line.length + 1 > TELEGRAM_MAX_CHARS) flush();
    current.push(line);
    length += line.length + 1;
  }

  flush();
  return messages;
}

export function renderDigest(
  events: Events,
  options: { baseUrl: string; now: Date },
): string[] {
  const rises = events.priceChanges.filter((change) => Number(change.price) > Number(change.previousPrice));
  const falls = events.priceChanges.filter((change) => Number(change.price) < Number(change.previousPrice));

  const lines = [
    `<b>📊 ${escapeHtml(stamp.format(options.now))}</b>`,
    '',
    ...renderPriceGroup('📈 Naik harga', rises, options.baseUrl),
    ...renderPriceGroup('📉 Turun harga', falls, options.baseUrl),
    ...renderNewStores(events.newStores, options.baseUrl),
    ...renderNewProducts(events.newProducts, options.baseUrl),
  ];

  // Nothing but the timestamp means nothing happened, and a notification that
  // says only "here is the time" is worse than no notification.
  const hasBody = lines.slice(2).some((line) => line.trim() !== '');
  if (!hasBody) return [];

  return paginate(lines);
}

/**
 * The message sent when the database is not moving.
 *
 * Silence is the notifier's correct answer to "nothing changed" and its symptom
 * when nothing is being written. Without this, a scraper writing to one
 * database while the notifier reads another is indistinguishable from a quiet
 * week — which is precisely the failure README line 587 predicts.
 */
export function renderStaleWarning(options: { latest: Date | null; hours: number }): string {
  const when = options.latest
    ? `Snapshot terbaru: ${stamp.format(options.latest)} (${plain.format(Math.round(options.hours))} jam lalu).`
    : 'Database ini belum ada snapshot sama sekali.';

  return [
    '<b>⚠️ Data tidak bergerak</b>',
    '',
    escapeHtml(when),
    escapeHtml('Notifier membaca database ini, tapi tidak ada yang menulis ke sini.'),
    '',
    escapeHtml(
      'Periksa DATABASE_URL di .env root repo — kalau ia menunjuk 127.0.0.1, ' +
        'hasil scrape masuk ke laptop dan tidak pernah sampai ke sini.',
    ),
  ].join('\n');
}
