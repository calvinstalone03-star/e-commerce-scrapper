// Reads listings off the rendered page, for whichever marketplace the tab is on.
//
// Why the DOM rather than the network: both supported sites render results
// client-side and neither hands over usable JSON. Shopee's search_items XHR
// answers this project with an empty items array and its page HTML carries no
// listings at all; Tokopedia's search HTML is half a megabyte without a single
// "Rp" in it. The rendered page is the one place the data reliably exists, and
// it is also the thing the user can see, so a wrong result is visibly wrong.
//
// Everything marketplace-specific lives in sites.js. This file is generic: find
// product links, walk out to the enclosing card, read the text.
//
// It runs only when asked. It fetches nothing of its own — the only thing it
// makes the page do is scroll, which is what a reader does anyway and is the
// only way a lazily-rendered grid ever puts its lower half in the DOM.

(() => {
  'use strict';

  if (window.__ecomScraperDomReady) return;
  window.__ecomScraperDomReady = true;

  // "Rp404.800" / "Rp 404.800". Indonesian grouping uses dots for thousands.
  const PRICE = /rp\s*([\d][\d.,]*)/i;

  // "158 terjual", "5RB+ terjual", "10K+ terjual", "Terjual 5rb+"
  const SOLD =
    /(?:terjual\s*([\d][\d.,]*\s*(?:rb|jt|k|m)?\+?)|([\d][\d.,]*\s*(?:rb|jt|k|m)?\+?)\s*terjual)/i;

  // A rating is a bare number 0-5 with one decimal, alone in its element.
  // Requiring the decimal keeps a sold count or a badge number out.
  const RATING = /^([0-5](?:[.,]\d)?)$/;

  // Far enough up to clear the image and title wrappers, not so far that the
  // whole results grid counts as one card.
  const MAX_CARD_DEPTH = 8;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function site() {
    return globalThis.ecomSiteForHost
      ? globalThis.ecomSiteForHost(window.location.hostname)
      : null;
  }

  function toNumber(text) {
    // "404.800" is four hundred thousand; "4,8" is four point eight.
    const value = Number.parseFloat(String(text).replace(/\./g, '').replace(/,/g, '.'));
    return Number.isFinite(value) ? value : null;
  }

  function cardFor(anchor) {
    // Climb until the subtree holds a price and enough text to be a whole card.
    // The anchor itself usually wraps only the image or the title.
    let node = anchor;
    for (let depth = 0; depth < MAX_CARD_DEPTH; depth += 1) {
      const parent = node.parentElement;
      if (!parent) break;
      node = parent;
      const text = node.innerText || '';
      if (PRICE.test(text) && text.length > 20) return node;
    }
    return node;
  }

  // Alt text that names the element's role instead of the product. Tokopedia
  // ships every listing image as alt="product-image", which walked straight
  // through the old "an alt longer than 8 characters is the name" rule and
  // became the stored product name for 10 of 12 Tokopedia rows. Shopee's alt
  // really is the title, so the rule stays — it just has to be able to tell the
  // two apart.
  const GENERIC_LABEL =
    /^(product[-_ ]?image|product|produk|image|img|photo|foto|gambar|thumbnail|thumb|logo|banner|icon|avatar|shop|toko|store|iklan|ad|ads|sponsored)s?$/i;

  function usableTitle(text) {
    const value = String(text || '').trim();
    if (value.length <= 8) return null;
    if (GENERIC_LABEL.test(value)) return null;
    // A listing title is a phrase a seller typed. A single short token with no
    // whitespace is a slug or a role name — "product-image", "thumb_large" —
    // never a product.
    if (!/\s/.test(value) && value.length < 25) return null;
    return value;
  }

  function extractName(card, anchor) {
    // An image alt or a title attribute is the product name verbatim, without
    // the badge and promo noise the card's flattened text carries — when the
    // site actually puts it there.
    const image = card.querySelector('img[alt]');
    const alt = usableTitle(image && image.getAttribute('alt'));
    if (alt) return alt;

    const titled =
      usableTitle(anchor.getAttribute('title')) || usableTitle(card.getAttribute('title'));
    if (titled) return titled;

    const lines = (card.innerText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 8 &&
          !PRICE.test(line) &&
          !SOLD.test(line) &&
          !RATING.test(line) &&
          !GENERIC_LABEL.test(line),
      );
    lines.sort((a, b) => b.length - a.length);
    return lines[0] || null;
  }

  function extractPrice(card) {
    // The first Rp is the selling price; a struck-through original follows it.
    // Discount badges ("-56%") carry no Rp, so they never match.
    const match = PRICE.exec(card.innerText || '');
    return match ? toNumber(match[1]) : null;
  }

  function extractSold(card) {
    const match = SOLD.exec(card.innerText || '');
    if (!match) return null;
    // Forwarded as the page's own text. scraper.models.parse_sold already
    // understands "5RB+" / "1,5RB" / "10K+" and is the one place that belongs.
    return (match[1] || match[2] || '').trim() || null;
  }

  function extractRating(card) {
    for (const node of card.querySelectorAll('*')) {
      if (node.children.length) continue; // leaves only
      const match = RATING.exec((node.textContent || '').trim());
      if (match && /[.,]/.test(match[1])) return toNumber(match[1]);
    }
    return null;
  }

  // UI chrome that sits in the same position a location does and matched the
  // old "short line with no digits" rule. "Produk Serupa" was landing in
  // stores.location for real rows, which then fed the dashboard's location
  // filter — a wrong value is worse than a missing one, so this list exists.
  const NOT_A_LOCATION = new RegExp(
    [
      'produk serupa', 'lihat semua', 'lainnya', 'terlaris', 'termurah',
      'gratis ongkir', 'bebas ongkir', 'cashback', 'cicilan', 'promo',
      'star seller', 'mall', 'official', 'preorder', 'pre-order', 'stok',
      'beli', 'keranjang', 'wishlist', 'diskon', 'voucher', 'flash sale',
      'ad', 'iklan', 'sponsored', 'bergaransi', 'terjual',
    ].join('|'),
    'i',
  );

  // Indonesian place names: letters, spaces, dots and hyphens only. Rejects
  // anything with digits or punctuation a label would carry.
  const LOCATION_SHAPE = /^[A-Za-zÀ-ÿ.\-' ]{3,30}$/;

  function extractLocation(card) {
    const lines = (card.innerText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // Scanning from the end still makes sense — location renders last — but a
    // candidate now has to look like a place and not be known UI text.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!LOCATION_SHAPE.test(line)) continue;
      if (NOT_A_LOCATION.test(line)) continue;
      return line;
    }
    return null;
  }

  // A Shopee search card carries price, sold, rating and a city — and no seller
  // anywhere in it. That is why every Shopee store row so far is `shop-<id>`
  // with no name: the name was never on the page being read, so no extractor
  // could have found it. Where Shopee *does* state the shop is its storefront
  // page, and there the URL is the username and the title is the display name.
  //
  // Read from the document rather than from a card: class names are hashed and
  // rotate, `og:title` and `<title>` do not.
  function pageShopName() {
    const meta = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
    const candidates = [meta && meta.getAttribute('content'), document.title];

    for (const candidate of candidates) {
      const raw = String(candidate || '').trim();
      if (!raw) continue;
      // "Toko Saya | Shopee Indonesia", "Toko Saya - Tokopedia".
      const head = raw.split(/\s[|\-–—]\s/)[0].trim();
      if (head.length < 2 || head.length > 60) continue;
      if (/^(shopee|tokopedia)\b/i.test(head)) continue;
      if (GENERIC_LABEL.test(head)) continue;
      return head;
    }
    return null;
  }

  function shopIdentity(config, items) {
    const page = config.shopPage ? config.shopPage(new URL(window.location.href)) : null;
    if (!page) return null;

    let shopKey = page.shopKey;
    if (!shopKey) {
      // Shopee's storefront URL is the username, while its cards key on the
      // numeric shop id, so the two have to be joined through the grid itself.
      // A storefront also renders other shops' recommendations, so only a key
      // that dominates the page is the page's own shop.
      const counts = new Map();
      for (const item of items) counts.set(item.shopKey, (counts.get(item.shopKey) || 0) + 1);
      let best = null;
      let bestCount = 0;
      for (const [key, count] of counts) {
        if (count > bestCount) {
          best = key;
          bestCount = count;
        }
      }
      if (!best || bestCount < Math.max(2, items.length * 0.6)) return null;
      shopKey = best;
    }

    const name = pageShopName();
    if (!name && !page.username) return null;
    return { shopKey: String(shopKey), username: page.username, name };
  }

  /**
   * Whether a link's host is one this marketplace serves listings from.
   *
   * Exact match, deliberately: the site's `hosts` list matches subdomains too,
   * because deciding "is this a Tokopedia tab" should say yes for any of them.
   * Deciding "is this link a product" must not — the seller console and the
   * help centre share the domain and neither sells anything.
   */
  function isProductHost(config, hostname) {
    const host = String(hostname || '').toLowerCase();
    const allowed = config.productHosts || config.hosts || [];
    return allowed.some((candidate) => host === String(candidate).toLowerCase());
  }

  function collect(config) {
    const seen = new Set();
    const items = [];
    const anchors = document.querySelectorAll('a[href]');

    for (const anchor of anchors) {
      let url;
      try {
        url = new URL(anchor.getAttribute('href'), window.location.origin);
      } catch (err) {
        continue;
      }

      // A link has to be to this marketplace's own storefront before its path
      // means anything. Without this, `parseProductLink` reads the path of any
      // absolute link on the page — and a footer link to
      // `seller.tokopedia.com/edu/official-store/` is two segments of exactly
      // the shape a Tokopedia product has. Two such links were filed as
      // products, priced from whatever "Rp" the footer happened to contain,
      // and named after a paragraph of SEO copy. They also kept the run going:
      // a page of nothing but footer still counted as a page with new items.
      if (!isProductHost(config, url.hostname)) continue;

      const keys = config.parseProductLink(url);
      if (!keys) continue;

      const key = `${keys.shopKey}/${keys.itemKey}`;
      if (seen.has(key)) continue;

      const card = cardFor(anchor);
      const price = extractPrice(card);
      // No price means a related-products link or plain navigation, not a
      // listing card. Skip rather than store half a row.
      if (price === null) continue;

      const name = extractName(card, anchor);
      if (!name) continue;

      seen.add(key);
      items.push({
        shopKey: String(keys.shopKey),
        itemKey: String(keys.itemKey),
        shopName: keys.shopName || null,
        name,
        price,
        sold: extractSold(card),
        ratingStar: extractRating(card),
        location: extractLocation(card),
        url: `${url.origin}${url.pathname}`,
        image: (card.querySelector('img[src]') || {}).src || null,
      });
    }

    return { items, anchorsSeen: anchors.length };
  }

  // A storefront's own search box, and why typing into it beats building the
  // address by hand. Shopee answers an in-shop search on /search for an ordinary
  // shop and on /mall/search for a Mall one, filtered by a numeric shop id, and
  // nothing on the storefront says which it is. Asking for the wrong one returns
  // no results — indistinguishable from a shop that simply does not stock the
  // term — and paginating that emptiness is what a run did before this. The
  // shop's own box has neither problem: whatever route the shop uses is the one
  // the site navigates to, and the address it lands on is a template the caller
  // can page through.
  //
  // Which box is the shop's is the only judgement here. A marketplace header
  // also carries a site-wide box, and typing into that searches everything, so
  // a placeholder naming the shop is what qualifies — "Cari di toko ini",
  // "Search in shop". The caller checks the resulting address anyway.
  const SHOP_SEARCH_PLACEHOLDER = /(di\s*toko|dalam\s*toko|toko\s*ini|in\s*(this\s*)?shop|in\s*store)/i;

  function shopSearchInput() {
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
    for (const input of inputs) {
      if (input.disabled || input.readOnly) continue;
      const label = `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`;
      if (!SHOP_SEARCH_PLACEHOLDER.test(label)) continue;
      const box = input.getBoundingClientRect();
      if (!box.width || !box.height) continue; // rendered but hidden
      return input;
    }
    return null;
  }

  function typeInto(input, text) {
    // A React-controlled input ignores a plain `value =` assignment: the value
    // is set on the DOM node but React's own tracker still holds the old one and
    // reverts it on the next render. Going through the prototype's setter is
    // what makes the framework see the change.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function submitSearch(input) {
    // Enter is what a person presses, and on both sites the box listens for it.
    // The form submit and the adjacent button are there for the layout where it
    // does not — pressing Enter on a box with no handler does nothing at all,
    // and a silent no-op here reads downstream as "the shop has no results".
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    const form = input.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return true;
    }

    const button = input.parentElement?.querySelector('button, [role="button"]');
    if (button) button.click();
    return true;
  }

  // Shopee runs two storefront layouts. A Mall shop wears the "Shopee Mall"
  // wordmark and a `Mall | ORI` badge; an ordinary one wears plain "Shopee" and
  // whatever seller badge it has earned. The two answer in-shop search on
  // different routes — /mall/search and /search — so which layout this is
  // decides which route to try first when the search box cannot be used.
  //
  // Only the order. Nothing here is trusted to be right: the caller checks the
  // shop ids that come back either way, so a misread costs one extra page load
  // rather than a wrong shop's products.
  const MALL_MARKER = /shopee\s*mall/i;

  function isMallShop() {
    if (MALL_MARKER.test(document.title)) return true;

    const meta = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
    if (meta && MALL_MARKER.test(meta.getAttribute('content') || '')) return true;

    for (const image of document.querySelectorAll('img[alt]')) {
      const alt = (image.getAttribute('alt') || '').trim();
      if (MALL_MARKER.test(alt)) return true;
      // The badge on the shop card is its own image, labelled just "Mall".
      if (/^mall(\s*[|·-]\s*ori)?$/i.test(alt)) return true;
    }

    return false;
  }

  // The tab a storefront opens on is its home page — vouchers, banners and a
  // "kamu mungkin suka" strip — not the shop's catalogue. The catalogue is one
  // tab over, under "Produk", and reading the home page instead is how a
  // keyword-less shop run ended up filing recommendations.
  const PRODUCTS_TAB = /^(produk|semua\s*produk|all\s*products|products)$/i;

  function productsTab() {
    for (const node of document.querySelectorAll('a, [role="tab"], [role="button"], button, div')) {
      if (node.children.length) continue; // the leaf holding the label
      if (!PRODUCTS_TAB.test((node.textContent || '').trim())) continue;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      return node;
    }
    return null;
  }

  function openProducts() {
    const tab = productsTab();
    if (!tab) return { ok: false, error: 'tab Produk tidak ditemukan' };
    // The label is usually a span inside the real control, so the click is aimed
    // at the nearest thing that looks clickable and allowed to bubble.
    const target = tab.closest('a, button, [role="tab"], [role="button"]') || tab;
    target.click();
    return { ok: true };
  }

  function searchInShop(keyword) {
    const input = shopSearchInput();
    if (!input) return { ok: false, error: 'kotak cari di toko tidak ditemukan' };
    typeInto(input, keyword);
    submitSearch(input);
    // The navigation this starts is watched from the service worker: it owns the
    // tab, and this world is about to be replaced by the one the search lands on.
    return { ok: true, placeholder: input.placeholder || null };
  }

  //: How long to keep waiting for the first card to render. Shopee's search
  //: grid routinely takes several seconds on a cold cache, and the old fixed
  //: delay in the service worker was the single biggest source of "no product
  //: cards found" on a page that was merely still loading.
  const FIRST_CARD_TIMEOUT_MS = 20_000;

  //: A grid renders its lower rows only once they are near the viewport, so a
  //: scrape without scrolling captures roughly the top third of a page.
  const SCROLL_STEPS = 40;
  const SCROLL_PAUSE_MS = 350;
  //: Stop scrolling once this many consecutive steps add no new cards — the end
  //: of the grid, rather than a slow one.
  const SCROLL_IDLE_STEPS = 4;

  async function waitForFirstCard(config, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { items } = collect(config);
      if (items.length) return items.length;
      await sleep(400);
    }
    return 0;
  }

  async function scrollThroughGrid(config, budgetMs, enough) {
    // Scroll a viewport at a time rather than jumping to the bottom: lazy grids
    // render what passes through the viewport, and a single jump skips most of
    // it. Counting cards (not scrollHeight) is what decides when to stop, since
    // footers and skeleton placeholders grow the page without adding listings.
    const deadline = Date.now() + budgetMs;
    let best = collect(config).items.length;
    let idle = 0;

    for (let step = 0; step < SCROLL_STEPS; step += 1) {
      if (Date.now() > deadline) break;
      // The caller asked for a number of products, and this page already holds
      // it. Scrolling out the rest of a 60-card grid to file five of them is
      // the longest part of a short run.
      if (enough && best >= enough) break;
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(SCROLL_PAUSE_MS);

      const count = collect(config).items.length;
      if (count > best) {
        best = count;
        idle = 0;
      } else {
        idle += 1;
        if (idle >= SCROLL_IDLE_STEPS) break;
      }

      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
      if (atBottom && idle >= 1) break;
    }

    window.scrollTo(0, 0);
    await sleep(200);
    return best;
  }

  async function scrape(options = {}) {
    const config = site();
    if (!config) {
      return { ok: false, error: `${window.location.hostname} is not a supported marketplace` };
    }

    const waitMs = options.waitMs ?? FIRST_CARD_TIMEOUT_MS;
    const found = await waitForFirstCard(config, waitMs);

    // Nothing at all after the full wait: either the page is not a listing page
    // or the grid never rendered. Either way, scrolling an empty page is a waste
    // of the caller's time — report and let it decide.
    const enough = Number(options.enough) > 0 ? Number(options.enough) : 0;
    if (found && options.autoScroll !== false && !(enough && found >= enough)) {
      await scrollThroughGrid(config, options.scrollBudgetMs ?? 25_000, enough);
    }

    const { items, anchorsSeen } = collect(config);

    // On a storefront every card in the main grid belongs to that shop, so the
    // name and username the page states apply to them — and only to them, which
    // is what the key check is for.
    const shop = shopIdentity(config, items);
    if (shop) {
      for (const item of items) {
        if (item.shopKey !== shop.shopKey) continue;
        if (shop.name) item.shopName = shop.name;
        if (shop.username) item.shopUsername = shop.username;
      }
    }

    return {
      ok: true,
      marketplace: config.marketplace,
      items,
      shop,
      // Which storefront layout this is, for the caller's route ordering.
      mall: config.marketplace === 'shopee' ? isMallShop() : false,
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString(),
      // Lets "0 items" be told apart from "the page had no links yet".
      anchorsSeen,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // A ping is how the service worker learns this world is live before it
    // starts a scrape. Cheaper and far more reliable than guessing with a timer.
    if (message?.type === 'ping') {
      sendResponse({ ok: true, url: window.location.href, ready: document.readyState });
      return true;
    }

    if (message?.type === 'shopSearch' || message?.type === 'openProducts') {
      try {
        sendResponse(
          message.type === 'shopSearch'
            ? searchInShop(String(message.keyword || ''))
            : openProducts(),
        );
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }

    if (message?.type !== 'scrapeDom') return false;

    scrape(message.options || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // response arrives after the awaits above
  });
})();
