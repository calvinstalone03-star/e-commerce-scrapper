// Per-marketplace configuration.
//
// Everything marketplace-specific lives here so adding a third site is one entry
// in SITES plus a manifest match — the extractor itself stays generic.
//
// Both supported sites render their results client-side (Shopee's search HTML is
// 157KB of app shell with zero listings in it; Tokopedia's is 598KB with no "Rp"
// anywhere), which is precisely why this reads the rendered DOM rather than the
// markup or an API.
//
// The only genuinely site-specific piece is how a product link identifies its
// shop and item:
//
//   Shopee     /<slug>-i.<shopId>.<itemId>   both ids sit in the URL
//   Tokopedia  /<shopSlug>/<productSlug>     no numeric ids anywhere
//
// So links yield string keys, and the server turns them into the integers the
// schema wants — numeric ones pass straight through, slugs get hashed. Doing
// that server-side keeps one implementation instead of two that drift.

const SITES = [
  {
    marketplace: 'shopee',
    label: 'Shopee',
    hosts: ['shopee.co.id'],
    searchUrl: (keyword) =>
      `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`,

    // `-i.<shopId>.<itemId>`, the shape Shopee has used for years. Class names
    // are hashed and change without notice; this does not.
    parseProductLink(url) {
      const match = /-i\.(\d+)\.(\d+)/.exec(url.pathname + url.search);
      if (!match) return null;
      return { shopKey: match[1], itemKey: match[2] };
    },
  },

  {
    marketplace: 'tokopedia',
    label: 'Tokopedia',
    hosts: ['tokopedia.com', 'www.tokopedia.com'],
    searchUrl: (keyword) =>
      `https://www.tokopedia.com/search?q=${encodeURIComponent(keyword)}`,

    // A product is `/<shopSlug>/<productSlug>` — exactly two path segments,
    // where the first is a real shop. Tokopedia hangs a lot of other things off
    // two-segment paths, so the first segment is checked against the routes that
    // are known not to be shops. Anything new that slips through still has to
    // survive the price check in the extractor before it becomes a row.
    NON_SHOP_SEGMENTS: new Set([
      'search', 'discovery', 'p', 'help', 'about', 'promo', 'deals', 'find',
      'blog', 'category', 'official-store', 'rewards', 'play', 'now', 'bills',
      'digital', 'events', 'kelaspenjual', 'seller', 'login', 'register', 'cart',
      'order-list', 'wishlist', 'contact-us', 'privacy', 'terms',
    ]),

    parseProductLink(url) {
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length !== 2) return null;
      const [shopSlug, productSlug] = segments;
      if (this.NON_SHOP_SEGMENTS.has(shopSlug.toLowerCase())) return null;
      // Product slugs are long and hyphenated; a two-segment path with a short
      // second part is almost always navigation.
      if (productSlug.length < 8) return null;
      return { shopKey: shopSlug, itemKey: `${shopSlug}/${productSlug}` };
    },
  },
];

function siteForHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    SITES.find((site) => site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null
  );
}

// Usable from a content script (plain script) and from the popup/service worker
// (module-ish contexts), without a bundler.
if (typeof globalThis !== 'undefined') {
  globalThis.ECOM_SITES = SITES;
  globalThis.ecomSiteForHost = siteForHost;
}
