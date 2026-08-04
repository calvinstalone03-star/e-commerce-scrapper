import type { Events, NewProduct, NewStore, PriceChange } from '@/lib/notify/events';
import { absolute, newProductLink, newStoreLink, priceChangeLink } from '@/lib/notify/links';
// `import type`, deliberately: positions.ts imports `server-only` at its top,
// and a value import would pull that into this module's runtime graph. This
// file is pure and stays that way — the type is erased at compile time, so
// nothing is imported at all.
import type { SetPosition } from '@/lib/notify/positions';

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

/**
 * How many entries a group prints before it says how many it left out.
 *
 * Promised by the design (spec lines 368-371) and, separately, needed: a group
 * is as long as the events allow, and the events allow a lot. 400 price changes
 * rendered in full are 22 messages; a shop whose 1,600 listings arrive after its
 * own row passed the store watermark — `ingest.py:372` commits one transaction
 * per captured page, so that split is the normal case rather than a race — are
 * 63. Telegram accepts roughly 20 messages a minute to one chat, so an
 * uncapped digest does not merely arrive slowly, it arrives as 429s.
 *
 * Twelve, measured rather than guessed: the widest entry this renders is a
 * price change with a full listing name, its two prices and its link, about 240
 * characters, and all four groups filled to twelve comes to 9,200 characters —
 * three messages, one clear of the cap below. Twenty would be around 15,000,
 * which is four or five, and at the cap the truncation stops being a count and
 * starts being a whole group vanishing: the reader would lose "Produk baru"
 * rather than see twelve of them and a remainder.
 */
export const MAX_ENTRIES_PER_GROUP = 12;

/**
 * How many messages one run may send, whatever the data does.
 *
 * The entry cap above already bounds the digest for realistic events; this
 * bounds it for unrealistic ones, because a single listing name can be
 * thousands of characters on its own and no per-entry count can see that.
 *
 * Four. Telegram's ceiling is about 20 messages a minute to one chat, and the
 * cost of touching it is out of all proportion to the benefit: `sendMessages`
 * would sleep off the 429 inside `sql.begin`, holding `FOR UPDATE` on
 * `notify_watermark`, and a run killed by the function time limit while holding
 * that lock rolls back — the watermark does not move, the next run rebuilds the
 * same oversized digest, and the backlog only grows. Four leaves the run at a
 * fifth of the ceiling even if the previous run's messages are still inside the
 * same minute.
 */
export const MAX_MESSAGES = 4;

/**
 * What a message says when the digest itself, not just one group, was cut.
 *
 * The per-group remainder lines are the ordinary case and say exactly how many
 * were dropped. This one cannot: what it truncates is whole groups, whose
 * headings may not have been rendered at all. It says the counts already shown
 * are still honest, and points at the place that has everything.
 */
const DIGEST_TRUNCATED = '<i>… sisanya dipotong. Angka di tiap judul tetap jumlah penuhnya.</i>';

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

/**
 * A shop, named and escaped.
 *
 * Escaping is this function's own job rather than each caller's. The four call
 * sites all wrapped it correctly, but the cost of the fifth one forgetting is
 * the worst failure in this module: an unescaped `<` in a username is a
 * Telegram 400 for the whole message, `sendMessages` throws, the transaction
 * rolls back, and the watermark never advances again — the digest is rebuilt
 * and rejected on every run after that, with no way out that does not involve a
 * human. A function that returns Telegram HTML should return Telegram HTML.
 */
function shopLabel(username: string | null, marketplace: string): string {
  const shop = username ?? 'toko tak dikenal';
  const channel = marketplace === 'tokopedia' ? 'Tokopedia' : 'Shopee';
  return escapeHtml(`${shop} · ${channel}`);
}

/**
 * The promised tail of a group that was cut (spec lines 368-371).
 *
 * Counts listings rather than printed entries, so that what is shown plus what
 * this names always adds back up to the number in the heading — a folded entry
 * stands for every listing folded into it.
 */
function remainder(dropped: number): string[] {
  return dropped > 0 ? [`  … ${plain.format(dropped)} lainnya`] : [];
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
  // truncated for length. A count that shrinks with the message would be a lie
  // about how much moved.
  const lines = [`<b>${escapeHtml(heading)} — ${plain.format(changes.length)}</b>`, ''];

  const shown = foldPriceChanges(changes).slice(0, MAX_ENTRIES_PER_GROUP);
  let printed = 0;

  for (const entry of shown) {
    if (entry.kind === 'folded') {
      printed += entry.members.length;
      lines.push(`  <b>${shopLabel(entry.username, entry.marketplace)}</b>`);
      lines.push(
        `  ${escapeHtml(signedMoney(entry.delta))} serempak di ${plain.format(entry.members.length)} listing`,
      );
      lines.push(`  ${link(baseUrl, priceChangeLink(entry.members[0]), 'lihat listingnya')}`);
      lines.push('');
      continue;
    }

    printed += 1;
    const change = entry.change;
    const from = Number(change.previousPrice);
    const to = Number(change.price);
    lines.push(
      `  • ${escapeHtml(change.name ?? 'tanpa nama')} — ${shopLabel(change.username, change.marketplace)}`,
    );
    lines.push(`    ${escapeHtml(`${money(from)} → ${money(to)}`)}  (${escapeHtml(percent(from, to))})`);
    lines.push(
      `    ${link(baseUrl, priceChangeLink(change), change.setCode ? `posisi kita di ${change.setCode}` : 'lihat di dashboard')}`,
    );
    lines.push('');
  }

  const tail = remainder(changes.length - printed);
  if (tail.length > 0) lines.push(...tail, '');
  return lines;
}

function renderNewStores(stores: NewStore[], baseUrl: string): string[] {
  if (stores.length === 0) return [];
  const lines = [`<b>Toko baru — ${plain.format(stores.length)}</b>`, ''];
  const shown = stores.slice(0, MAX_ENTRIES_PER_GROUP);
  for (const store of shown) {
    lines.push(
      `  • ${escapeHtml(store.name ?? store.username)} — ${shopLabel(store.username, store.marketplace)}`,
    );
    lines.push(`    ${plain.format(store.products)} listing`);
    lines.push(`    ${link(baseUrl, newStoreLink(store), 'buka toko')}`);
    lines.push('');
  }
  const tail = remainder(stores.length - shown.length);
  if (tail.length > 0) lines.push(...tail, '');
  return lines;
}

function renderNewProducts(products: NewProduct[], baseUrl: string): string[] {
  if (products.length === 0) return [];
  const lines = [`<b>Produk baru di toko lama — ${plain.format(products.length)}</b>`, ''];
  const shown = products.slice(0, MAX_ENTRIES_PER_GROUP);
  for (const product of shown) {
    lines.push(
      `  • ${escapeHtml(product.name ?? 'tanpa nama')} — ${shopLabel(product.username, product.marketplace)}  ${link(baseUrl, newProductLink(product), 'lihat')}`,
    );
  }
  lines.push(...remainder(products.length - shown.length), '');
  return lines;
}

/**
 * Drop a trailing anchor a raw character cut left half-open.
 *
 * A cut at an arbitrary offset can land inside `<a href="...`, inside the
 * link text, or inside `</a>` itself — three different-looking cuts that are
 * the same problem: an `<a ` with no `</a>` in what got kept. Comparing the
 * two counts catches all three without needing to know which one happened,
 * and it is the same test an unbalanced result is judged by, so fixing it
 * this way cannot leave a case the check does not also see.
 */
function dropDanglingAnchor(sliced: string): string {
  const opened = (sliced.match(/<a /g) ?? []).length;
  const closed = (sliced.match(/<\/a>/g) ?? []).length;
  if (opened <= closed) return sliced;
  return sliced.slice(0, sliced.lastIndexOf('<a '));
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
 * the alternative to dropping the line entirely. The cut itself can still
 * land inside the line's trailing anchor, so `dropDanglingAnchor` backs it up
 * far enough to leave nothing but a closed `<a>` or none at all.
 */
function pack(lines: string[]): string[] {
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
    const line =
      raw.length > TELEGRAM_MAX_CHARS
        ? `${dropDanglingAnchor(raw.slice(0, TELEGRAM_MAX_CHARS - 1))}…`
        : raw;
    // +1 for the newline that will join it to the previous line.
    if (length + line.length + 1 > TELEGRAM_MAX_CHARS) flush();
    current.push(line);
    length += line.length + 1;
  }

  flush();
  return messages;
}

/**
 * Close the last message this run is allowed to send with the notice.
 *
 * Whole lines are dropped to make room, never characters: every line here is
 * anchor-balanced already, so removing one cannot leave the unbalanced tag a
 * mid-line cut would.
 */
function closeWithNotice(message: string): string {
  const lines = [...message.split('\n'), DIGEST_TRUNCATED];
  while (lines.join('\n').length > TELEGRAM_MAX_CHARS && lines.length > 1) {
    lines.splice(lines.length - 2, 1);
  }
  return lines.join('\n');
}

/** Pack, then hold the result to `MAX_MESSAGES` — see the constant for why. */
function paginate(lines: string[]): string[] {
  const messages = pack(lines);
  if (messages.length <= MAX_MESSAGES) return messages;

  const kept = messages.slice(0, MAX_MESSAGES);
  kept[kept.length - 1] = closeWithNotice(kept[kept.length - 1]);
  return kept;
}

/**
 * Why some of these rows are here rather than in a message of their own.
 *
 * Without it the reader sees the cap as an inconsistency — a change on one of
 * our sets got its own message, an identical-looking one did not — and has no
 * way to tell that from the notifier having missed it.
 */
function spilledNotice(spilled: number): string[] {
  if (spilled <= 0) return [];
  return [
    `<i>${escapeHtml(
      `${plain.format(spilled)} perubahan di set kita melewati batas pesan per-produk dan ikut di sini.`,
    )}</i>`,
    '',
  ];
}

export function renderDigest(
  events: Events,
  options: { baseUrl: string; now: Date; spilled?: number },
): string[] {
  const rises = events.priceChanges.filter((change) => Number(change.price) > Number(change.previousPrice));
  const falls = events.priceChanges.filter((change) => Number(change.price) < Number(change.previousPrice));

  const lines = [
    `<b>📊 ${escapeHtml(stamp.format(options.now))}</b>`,
    '',
    ...spilledNotice(options.spilled ?? 0),
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
 * Which changes are worth a message of their own.
 *
 * Membership, not interest: a change joins the per-product stream when it
 * happened on a `set_code` one of our own shops carries, because that is
 * exactly the case where "what does this do to us" has an answer. Everything
 * else is news about a market we are not in, which is what the digest is for.
 *
 * A change with no `set_code` can never qualify — accessories, bundles and
 * knock-offs carry none, and there is no set for them to belong to.
 */
export function splitByOwnSets(
  changes: PriceChange[],
  ownSetCodes: ReadonlySet<string>,
): { perProduct: PriceChange[]; rest: PriceChange[] } {
  const perProduct: PriceChange[] = [];
  const rest: PriceChange[] = [];

  for (const change of changes) {
    if (change.setCode !== null && ownSetCodes.has(change.setCode)) perProduct.push(change);
    else rest.push(change);
  }

  // Biggest proportional move first. `run.ts` caps this list at
  // NOTIFY_PER_PRODUCT_MAX and spills the remainder into the digest, so this
  // order is not presentation — it decides which changes keep a message of
  // their own when the cap bites.
  perProduct.sort((left, right) => magnitude(right) - magnitude(left));
  return { perProduct, rest };
}

/**
 * How far a price moved, as a fraction of where it started.
 *
 * A previous price of zero is not an infinite rise, it is a listing whose old
 * price was never real. Dividing by it gives Infinity, which would put that row
 * at the head of the order and spend a capped per-product slot on it, so it
 * ranks as no movement instead — last, where a reader can still find it in the
 * digest if the cap pushed it there.
 */
function magnitude(change: PriceChange): number {
  const from = Number(change.previousPrice);
  if (from === 0) return 0;
  return Math.abs(delta(change) / from);
}

/** What the position block says when we have no price of our own on the set. */
const NO_OWN_PRICE = 'Kita belum berharga di set ini.';

/** And when we do, but nobody else does. */
const NO_RIVAL_PRICE = 'Belum ada rival berharga di set ini.';

/**
 * What replaces the position block when the two sides are not comparable.
 *
 * The message still goes out — a rival did move, and that is a fact — but the
 * position line does not, because on a `set_code` like `8827` it would read
 * "kita lebih mahal Rp 8,1 juta" comparing a sealed box of sixty against one
 * loose minifigure. Confidently wrong once costs the reader their trust in the
 * seventy-one messages that were right.
 */
const INCOMPARABLE = [
  'Pembanding tidak sebanding — set ini memuat',
  'barang berbeda di bawah satu nomor.',
];

/**
 * Where we stand on this set, in the three lines the design specifies.
 *
 * Every branch here ends with a link, because every branch is a claim the
 * reader may want to check, and the collapsed ones most of all.
 */
function positionBlock(
  change: PriceChange,
  position: SetPosition | undefined,
  baseUrl: string,
): string[] {
  const target = priceChangeLink(change);
  const label = change.setCode ? `posisi kita di ${change.setCode}` : 'lihat di dashboard';

  if (position?.extreme) {
    return [
      ...INCOMPARABLE.map(escapeHtml),
      link(baseUrl, target, 'periksa di dashboard'),
    ];
  }

  // A set missing from the map is a set no own shop carries a priced listing
  // on, which is the same thing the reader needs told as `ourPrice` null.
  if (position === undefined || position.ourPrice === null) {
    return [escapeHtml(NO_OWN_PRICE), '', link(baseUrl, target, label)];
  }

  const ours = Number(position.ourPrice);
  const lines = [
    escapeHtml(`Kita        ${money(ours)}  (${position.ourShop ?? 'toko kita'})`),
  ];

  if (position.cheapestRival === null) {
    lines.push(escapeHtml(NO_RIVAL_PRICE));
  } else {
    const rival = Number(position.cheapestRival);
    const shops = `${plain.format(position.rivalCount)} toko`;
    lines.push(escapeHtml(`Termurah    ${money(rival)}  dari ${shops}`));
    // At or below the cheapest rival is TERMURAH: a tie is not being beaten.
    const standing = ours <= rival ? 'TERMURAH' : 'TERMAHAL';
    lines.push(escapeHtml(`→ kita ${standing}, selisih ${money(Math.abs(ours - rival))}`));
  }

  return [...lines, '', link(baseUrl, target, label)];
}

/**
 * One change, one message.
 *
 * Never split: `pack()` exists because a digest is as long as the events make
 * it, but a single change has a bounded shape — except for the listing name,
 * which marketplaces let run to thousands of characters. That one unbounded
 * part is cut to fit rather than spilled into a second message.
 */
export function renderProductMessage(
  change: PriceChange,
  position: SetPosition | undefined,
  options: { baseUrl: string },
): string {
  const from = Number(change.previousPrice);
  const to = Number(change.price);
  const pct = percent(from, to);

  const build = (name: string): string =>
    [
      `${to > from ? '📈' : '📉'} <b>${escapeHtml(name)}</b>`,
      shopLabel(change.username, change.marketplace),
      '',
      `${escapeHtml(`${money(from)} → ${money(to)}`)}${pct ? `   (${escapeHtml(pct)})` : ''}`,
      '',
      ...positionBlock(change, position, options.baseUrl),
    ].join('\n');

  let name = change.name ?? 'tanpa nama';
  let message = build(name);

  // Cut the raw name, not the rendered message: a cut through the middle of
  // `&amp;` leaves `&am`, which Telegram rejects for the whole message, and a
  // cut through an `<a href=...>` leaves the unbalanced tag `pack()` goes to
  // such lengths to avoid. Escaping after the cut cannot produce either.
  //
  // Terminates: escaping only ever expands, so dropping one raw character
  // drops at least one rendered character. Removing `over + 1` of them makes
  // room for the ellipsis and the overflow both.
  while (message.length > TELEGRAM_MAX_CHARS && name.length > 0) {
    const over = message.length - TELEGRAM_MAX_CHARS;
    name = `${trimTail(name, name.length - over - 1)}…`;
    message = build(name);
  }

  return message;
}

/**
 * Cut to a length without leaving half a character behind.
 *
 * `slice` counts UTF-16 units, so a cut can land between the halves of an emoji
 * and leave a lone surrogate — which is not a character, renders as U+FFFD, and
 * is one more thing for Telegram to object to. Drop the orphan.
 */
function trimTail(value: string, length: number): string {
  const cut = value.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
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
