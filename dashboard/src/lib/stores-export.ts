/**
 * Turn the shops the database has seen into a `config/stores.txt` a human edits.
 *
 * The database is the wrong place to decide which shops get scraped: it holds
 * every seller a keyword scrape happened to walk past, and a sweep driven off
 * that would grow without anyone choosing to grow it. The file is the decision,
 * and this is only the draft — the download lands in the browser, someone
 * deletes the lines they do not want, and saves it into the repository.
 *
 * The format is defined by the reader, `scraper/shops.py`. Kept as a pure
 * function so the agreement can be tested without a database.
 */

export const STORES_FILE_NAME = 'stores.txt';

export type ExportableStore = {
  marketplace: string;
  username: string;
};

/** Usernames the extension cannot navigate to. */
function isPlaceholder(username: string): boolean {
  // Written by keyword scrapes: a search grid states a shop id but no slug, so
  // the row is stored as `shop-<id>`. That is an id in slug's clothing, and
  // https://shopee.co.id/shop-490338801 is a 404.
  return /^shop-\d+$/.test(username);
}

export function formatStoresFile(
  rows: readonly ExportableStore[],
  { exportedAt }: { exportedAt: Date },
): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const row of rows) {
    const slug = row.username?.trim().toLowerCase();
    const marketplace = row.marketplace?.trim().toLowerCase();
    if (!slug || !marketplace || isPlaceholder(slug)) continue;

    const line = `${marketplace}/${slug}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  // Indonesian, like the rest of what a user reads, and dated because the file
  // is a snapshot of the database at one moment — a stores.txt found in a
  // checkout six months from now should say how old its draft was.
  const stamp = exportedAt.toISOString().slice(0, 10);
  const header = [
    `# Daftar toko, diekspor dari dashboard pada ${stamp}.`,
    `# ${lines.length} toko dari database.`,
    '#',
    '# Simpan file ini sebagai config/stores.txt di folder ecom-scraper.',
    '# Hapus baris toko yang tidak ingin dipantau — daftar inilah yang dijalankan',
    '# tombol "Scrape semua toko" di extension, dari atas ke bawah.',
    '#',
    '# Format: marketplace/slug. Baris tanpa marketplace dianggap Shopee.',
    '# Baris kosong dan baris diawali # diabaikan.',
  ];

  if (lines.length === 0) {
    header.push(
      '#',
      '# Database belum punya toko dengan slug yang bisa dibuka. Scrape satu toko',
      '# lewat extension dulu, lalu unduh lagi.',
    );
  }

  return `${[...header, ...lines].join('\n')}\n`;
}
