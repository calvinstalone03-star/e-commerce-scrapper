import { CHANNEL_PARAM } from '@/lib/channel';
import type { NewProduct, NewStore, PriceChange } from '@/lib/notify/events';

/**
 * Where a notification points.
 *
 * There is no uniform answer, because `/pricing/[id]` is scoped to our own
 * shops: `getPricePositionDetail` joins `AND s.is_own` (queries.ts:769) and a
 * rival's id 404s at `pricing/[id]/page.tsx:61`. Every price change observed so
 * far belongs to a rival, so the rival paths are the common case, not the
 * fallback.
 *
 * For a rival the useful destination is not their listing but ours: when a
 * competitor moves, the question is where that leaves us. `/pricing` searches
 * `set_code` by prefix (queries.ts:409), so a set number lands on exactly that
 * comparison.
 *
 * No `server-only` and no database access — pure string work, so the choices
 * here are testable without a Postgres.
 */

export function resolveBaseUrl(env: {
  NOTIFY_BASE_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}): string {
  // VERCEL_URL is deliberately not consulted: it names the individual
  // deployment and changes on every push, so links already sent to Telegram
  // would rot. VERCEL_PROJECT_PRODUCTION_URL is the stable production domain,
  // and follows a custom domain if one is ever attached.
  const explicit = env.NOTIFY_BASE_URL?.trim();
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();

  const chosen = explicit || (vercel ? `https://${vercel}` : '');
  if (!chosen) {
    throw new Error(
      'No base URL for notification links. Set NOTIFY_BASE_URL, or deploy where ' +
        'VERCEL_PROJECT_PRODUCTION_URL is set.',
    );
  }

  return chosen.replace(/\/+$/, '');
}

export function priceChangeLink(change: PriceChange): string {
  // Our own listing has a detail page, and it repairs its own `kanal` from the
  // database (pricing/[id]/page.tsx:68), so a bare path lands correctly.
  if (change.isOwn) return `/pricing/${change.productId}`;

  // A rival with a set number: our position on that set.
  if (change.setCode) {
    const params = new URLSearchParams({ [CHANNEL_PARAM]: change.marketplace, q: change.setCode });
    return `/pricing?${params.toString()}`;
  }

  // Accessories, bundles and knock-offs carry no set number, and `/pricing` has
  // nothing to match them on. `/products` searches names and spans both
  // marketplaces.
  if (change.name) {
    return `/products?${new URLSearchParams({ q: change.name }).toString()}`;
  }

  return '/products';
}

export function newStoreLink(store: NewStore): string {
  return `/stores/${store.storeId}`;
}

export function newProductLink(product: NewProduct): string {
  return `/products?${new URLSearchParams({ storeId: String(product.storeId) }).toString()}`;
}

export function absolute(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
