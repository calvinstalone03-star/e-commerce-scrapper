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
// The only genuinely site-specific pieces are how a product link identifies its
// shop and item, and how the site numbers its result pages:
//
//   Shopee     /<slug>-i.<shopId>.<itemId>   both ids sit in the URL, page=0 first
//   Tokopedia  /<shopSlug>/<productSlug>     no numeric ids anywhere, page=1 first
//
// So links yield string keys, and the server turns them into the integers the
// schema wants — numeric ones pass straight through, slugs get hashed. Doing
// that server-side keeps one implementation instead of two that drift.
//
// The whole file is an IIFE behind a re-injection guard. background.js injects
// it on demand into tabs that may already carry the manifest-declared copy, and
// a bare top-level `const SITES` would throw "Identifier 'SITES' has already
// been declared" on that second injection.

(() => {
  'use strict';

  if (globalThis.ECOM_SITES) return; // already injected into this world

  const SITES = [
    {
      marketplace: 'shopee',
      label: 'Shopee',
      hosts: ['shopee.co.id'],

      // Shopee numbers search pages from zero: page=0 is the first screen of
      // results, so an index maps straight through.
      searchUrl(keyword, page = 0) {
        const base = `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`;
        return page > 0 ? `${base}&page=${page}` : base;
      },

      // `-i.<shopId>.<itemId>`, the shape Shopee has used for years. Class names
      // are hashed and change without notice; this does not.
      parseProductLink(url) {
        const match = /-i\.(\d+)\.(\d+)/.exec(url.pathname + url.search);
        if (!match) return null;
        return { shopKey: match[1], itemKey: match[2] };
      },

      // Shopee hangs its own routes off single-segment paths too, so a shop
      // page is "one segment that is not one of those and is not a product".
      NON_SHOP_SEGMENTS: new Set([
        'search', 'mall', 'cart', 'user', 'buyer', 'seller', 'login', 'signup',
        'daily_discover', 'daily-discover', 'flash_sale', 'flash-sale', 'find',
        'all', 'product', 'shop', 'web', 'm', 'about', 'careers', 'help',
        'collections', 'official-brand', 'voucher', 'wallet', 'category',
      ]),

      // Where a page states which shop it belongs to. A search page never does
      // — its cards carry price, sold, rating and city, and no seller at all —
      // so shop identity on Shopee only exists on a shop page, where the URL
      // *is* the username.
      shopPage(url) {
        const segments = url.pathname.split('/').filter(Boolean);
        // /shop/<shopId>: the numeric id, no username to be had.
        if (segments.length === 2 && segments[0] === 'shop' && /^\d+$/.test(segments[1])) {
          return { shopKey: segments[1], username: null };
        }
        if (segments.length !== 1) return null;
        const [slug] = segments;
        if (this.NON_SHOP_SEGMENTS.has(slug.toLowerCase())) return null;
        if (/-i\.\d+\.\d+/.test(slug)) return null; // a product, not a shop
        return { shopKey: null, username: slug };
      },

      // A shop's own product grid. `keyword` rides along in the site's own
      // parameter name — if this front end ignores it the run is merely longer,
      // because the caller filters on the product name regardless.
      shopUrl(slug, keyword, page = 0) {
        const url = new URL(`https://shopee.co.id/${encodeURIComponent(slug)}`);
        url.searchParams.set('sortBy', 'pop');
        if (keyword) url.searchParams.set('keyword', keyword);
        if (page > 0) url.searchParams.set('page', String(page));
        return url.href;
      },

      // Shopee usernames are one token: "Toko Mainanku" is `tokomainanku` far
      // more often than `toko-mainanku`, but both get a try before giving up.
      slugCandidates(text) {
        const lower = text.toLowerCase();
        return [lower.replace(/\s+/g, ''), lower.replace(/\s+/g, '-')];
      },
    },

    {
      marketplace: 'tokopedia',
      label: 'Tokopedia',
      hosts: ['tokopedia.com', 'www.tokopedia.com'],

      // Tokopedia numbers from one, so index 0 is page=1. Sending page=0 there
      // returns the first page anyway, but the canonical URL is what the user
      // sees in the address bar and what the server reads the keyword back out
      // of, so build the one the site itself would.
      searchUrl(keyword, page = 0) {
        const base = `https://www.tokopedia.com/search?q=${encodeURIComponent(keyword)}`;
        return page > 0 ? `${base}&page=${page + 1}` : base;
      },

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

      //: A shop's own sections live one level under its slug. None of them is a
      //: product, and `/toko/product` is the shop grid this extension paginates.
      SHOP_SECTIONS: new Set(['product', 'review', 'etalase', 'note', 'info', 'home']),

      parseProductLink(url) {
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length !== 2) return null;
        const [shopSlug, productSlug] = segments;
        if (this.NON_SHOP_SEGMENTS.has(shopSlug.toLowerCase())) return null;
        if (this.SHOP_SECTIONS.has(productSlug.toLowerCase())) return null;
        // Product slugs are long and hyphenated; a two-segment path with a short
        // second part is almost always navigation.
        if (productSlug.length < 8) return null;
        return { shopKey: shopSlug, itemKey: `${shopSlug}/${productSlug}` };
      },

      // `/<shopSlug>` on its own is the shop's storefront, and the slug is the
      // same key its products carry — so items read there can be tied to it
      // without guessing. `/<shopSlug>/product` is the same shop's full grid.
      shopPage(url) {
        const segments = url.pathname.split('/').filter(Boolean);
        if (!segments.length || segments.length > 2) return null;
        const [slug, section] = segments;
        if (this.NON_SHOP_SEGMENTS.has(slug.toLowerCase())) return null;
        if (segments.length === 2 && !this.SHOP_SECTIONS.has(section.toLowerCase())) return null;
        return { shopKey: slug, username: slug };
      },

      // The shop's full product grid, which is paginated and searchable in a way
      // the storefront landing page is not.
      shopUrl(slug, keyword, page = 0) {
        const url = new URL(`https://www.tokopedia.com/${encodeURIComponent(slug)}/product`);
        if (keyword) url.searchParams.set('q', keyword);
        if (page > 0) url.searchParams.set('page', String(page + 1));
        return url.href;
      },

      // Tokopedia slugs are hyphenated far more often than not.
      slugCandidates(text) {
        const lower = text.toLowerCase();
        return [lower.replace(/\s+/g, '-'), lower.replace(/\s+/g, '')];
      },
    },
  ];

  function siteForHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return (
      SITES.find((site) => site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null
    );
  }

  //: Query parameters each marketplace puts the search term in. Same list as
  //: scraper/ingest.py's `_SEARCH_PARAMS` — the server is still the one that
  //: records the keyword, this copy only lets the popup pre-fill and lets a
  //: paginated run continue a search the user started by hand.
  const SEARCH_PARAMS = ['keyword', 'q', 'search', 'st'];

  function keywordFromUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (err) {
      return '';
    }
    for (const param of SEARCH_PARAMS) {
      const value = url.searchParams.get(param);
      if (value && value.trim()) return value.trim();
    }
    return '';
  }

  function shopSlugsFor(site, raw) {
    // What a person types into a "shop" box: a pasted storefront URL, a bare
    // username, "@username", or the shop's display name. The first three are
    // exact; a display name is a guess, so it yields the site's plausible slugs
    // in order and the caller tries them until one has products.
    const text = String(raw || '').trim().replace(/^@/, '');
    if (!text) return [];

    if (text.includes('/')) {
      // Something with a path in it is an address, not a name. If it is not a
      // storefront address, say so by returning nothing — treating a pasted
      // search URL as a slug would just navigate to a 404 and blame the shop.
      try {
        const url = new URL(/^https?:/i.test(text) ? text : `https://${text}`);
        const page = site.shopPage(url);
        return page && page.username ? [page.username] : [];
      } catch (err) {
        return [];
      }
    }

    if (!/\s/.test(text)) return [text.toLowerCase()];
    return site.slugCandidates(text);
  }

  // Usable from a content script (plain script) and from the popup/service worker
  // (module-ish contexts), without a bundler.
  globalThis.ecomShopSlugs = shopSlugsFor;
  globalThis.ECOM_SITES = SITES;
  globalThis.ecomSiteForHost = siteForHost;
  globalThis.ecomKeywordFromUrl = keywordFromUrl;
})();
