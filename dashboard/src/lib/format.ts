/**
 * Display formatting. No business logic — the values arrive correct and this
 * only decides how they read.
 */

const rupiah = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});

const compact = new Intl.NumberFormat('id-ID', { notation: 'compact' });
const plain = new Intl.NumberFormat('id-ID');

/**
 * Format a NUMERIC price string as rupiah.
 *
 * Takes a string because that is how it travels: Postgres NUMERIC arrives as a
 * string and stays one so no float rounding creeps in. The conversion happens
 * here, at the last possible moment, where a rounding error can only affect
 * pixels.
 */
export function formatPrice(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? rupiah.format(numeric) : '–';
}

/** Compact rupiah for axis ticks, where the full string would not fit. */
export function formatPriceShort(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '–';
  return `Rp${compact.format(numeric)}`;
}

/** Units sold. Already an integer — the "5RB+" parsing happened in Python. */
export function formatSold(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return plain.format(value);
}

export function formatRating(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : '–';
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '–'
    : date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '–'
    : date.toLocaleString('id-ID', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * Percentage change between two prices, for the movers list.
 *
 * Returns null when there is no meaningful comparison rather than 0, so the UI
 * can distinguish "unchanged" from "nothing to compare against".
 */
export function priceDelta(
  from: string | null,
  to: string | null,
): { absolute: number; percent: number } | null {
  if (from === null || to === null) return null;
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return { absolute: b - a, percent: ((b - a) / a) * 100 };
}

export const MARKETPLACE_LABELS: Record<string, string> = {
  shopee: 'Shopee',
  tokopedia: 'Tokopedia',
};

/**
 * Shop usernames are a placeholder when the marketplace did not expose a slug.
 *
 * Shopee search cards carry only the numeric id, so the scraper stores
 * `shop-<id>`; Tokopedia's URL is the slug, so it is real. Showing the raw
 * placeholder in a table reads as a broken value, so it is labelled as what it
 * is.
 */
export function formatStoreName(username: string | null, name: string | null): string {
  if (name && name.trim()) return name;
  if (!username) return '–';
  return /^shop-\d+$/.test(username) ? `Toko #${username.slice(5)}` : username;
}

export function isPlaceholderStore(username: string | null): boolean {
  return Boolean(username && /^shop-\d+$/.test(username));
}
