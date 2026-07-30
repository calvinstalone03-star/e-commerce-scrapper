import { marketplaceSchema, type Marketplace } from '@/lib/schemas';

/**
 * Which of our shops the numbers on screen are about.
 *
 * Three screens — the overview, the price worklist, the analytics — answer
 * "where do we stand", and that question has no answer until it names one shop
 * of ours. Two shops merged into one pool double-counts the 1,174 sets listed in
 * both, so there is no combined view to fall back on: a channel is always
 * chosen, and it is chosen here.
 *
 * Deliberately free of `server-only` and of any database call: the pages resolve
 * it on the server, the shell resolves the same value on the client to decide
 * which switch is lit, and both must agree.
 */

export type Channel = Marketplace;

/** The query parameter, named once. Indonesian, like the rest of the UI. */
export const CHANNEL_PARAM = 'kanal';

/**
 * The channel this request is about, or null when no shop is marked ours.
 *
 * Never throws and never 404s. A hand-typed value, a value from before a
 * marketplace was added, or a bookmark that outlived `ecom-scraper own-shop`
 * all land on a shop that still exists — every scoped screen prints the channel
 * and the username in its heading, so the fallback is visible rather than
 * silent.
 */
export function resolveChannel(
  raw: string | null | undefined,
  shops: ReadonlyArray<{ marketplace: string }>,
): Channel | null {
  // Anything that is not one of our two marketplaces is not a channel, whatever
  // the database happens to hold.
  const available = shops
    .map((shop) => marketplaceSchema.safeParse(shop.marketplace))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .sort((left, right) => left.localeCompare(right));
  if (available.length === 0) return null;

  const asked = marketplaceSchema.safeParse(raw);
  if (asked.success && available.includes(asked.data)) return asked.data;

  return available[0];
}

/** The shop a channel belongs to, for headings that have to name it. */
export function channelShop<T extends { marketplace: string }>(
  channel: Channel | null,
  shops: readonly T[],
): T | null {
  if (!channel) return null;
  return shops.find((shop) => shop.marketplace === channel) ?? null;
}

/**
 * The same href, carrying the active channel.
 *
 * Navigation links are plain `href`s, so without this a click on "Analitik"
 * silently drops the channel and the page answers for the default shop instead.
 * Parsed rather than concatenated so a link that already carries a channel is
 * corrected instead of ending up with two.
 */
export function withChannel(href: string, channel: Channel | null): string {
  if (!channel) return href;

  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.set(CHANNEL_PARAM, channel);
  return `${path}?${params}`;
}
