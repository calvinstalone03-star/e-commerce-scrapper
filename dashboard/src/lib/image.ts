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
 *
 * `**.` matches any subdomain, the same syntax `remotePatterns.hostname` takes.
 * Both marketplaces shard their CDN across numbered hostnames that no one
 * enumerated up front — `p16-images-sign-sg`, `p19-images-sign-sg`, and however
 * many exist that this database has not seen — so those two families are matched
 * by pattern. Enumerating them is how the list fell behind the data: a host
 * missing here does not degrade, it throws.
 */
export const IMAGE_HOSTS = [
  'cf.shopee.co.id',
  '**.img.susercontent.com',
  '**.tokopedia.net',
  '**.tokopedia-static.net',
] as const;

/**
 * Whether `next/image` will accept this URL.
 *
 * `next/image` does not fail softly on a host outside `remotePatterns`: it
 * throws during render, which takes the whole route down rather than the one
 * thumbnail. Callers check first and fall back to their own placeholder, so an
 * unrecognised CDN costs a picture instead of a page.
 */
export function isAllowedImageHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return IMAGE_HOSTS.some((pattern) =>
    // `**.example.com` allows subdomains of example.com but not the bare domain,
    // which is how Next reads the same pattern.
    pattern.startsWith('**.') ? hostname.endsWith(pattern.slice(2)) : hostname === pattern,
  );
}
