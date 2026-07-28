/**
 * Marketplace image URL handling.
 *
 * The scraper stores the CDN base URL. Shopee's CDN takes a size suffix and the
 * difference is not cosmetic:
 *
 *   <url>          467 KB  JPEG   full size
 *   <url>_tn        40 KB  JPEG
 *   <url>_tn.webp   28 KB  WebP
 *
 * A 60-product grid is ~28 MB at full size and ~1.7 MB thumbnailed. Storing the
 * base and appending here keeps full resolution one concatenation away, which is
 * why the suffix is not baked in at scrape time.
 */

export type ImageSize = 'thumb' | 'full';

const SHOPEE_CDN = /(?:susercontent\.com|shopee\.co\.id)\/file\//;

/**
 * Build a display URL at the requested size.
 *
 * Unknown hosts are returned untouched — guessing a suffix for a CDN whose
 * conventions are not known would turn a working image into a 404.
 *
 * @param url Stored image URL, or null.
 * @param size Thumbnail for grids and tables, full for detail views.
 */
export function imageUrl(url: string | null | undefined, size: ImageSize = 'thumb'): string | null {
  if (!url) return null;
  if (size === 'full') return url;
  if (SHOPEE_CDN.test(url)) return `${url}_tn.webp`;
  return url;
}

/**
 * Hosts `next/image` is allowed to optimise.
 *
 * Kept here rather than only in next.config.ts so the list has one home; the
 * config imports it.
 */
export const IMAGE_HOSTS = [
  'down-id.img.susercontent.com',
  'cf.shopee.co.id',
  'down-ws-id.img.susercontent.com',
  'images.tokopedia.net',
  'ecs7.tokopedia.net',
  'ecs7-p.tokopedia.net',
] as const;
