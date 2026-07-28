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
// It runs only when asked. It fetches nothing.

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

  function extractName(card, anchor) {
    // An image alt or a title attribute is the product name verbatim, without
    // the badge and promo noise the card's flattened text carries.
    const image = card.querySelector('img[alt]');
    const alt = image && image.getAttribute('alt');
    if (alt && alt.trim().length > 8) return alt.trim();

    const titled = anchor.getAttribute('title') || card.getAttribute('title');
    if (titled && titled.trim().length > 8) return titled.trim();

    const lines = (card.innerText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 8 && !PRICE.test(line) && !SOLD.test(line) && !RATING.test(line),
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

  function extractLocation(card) {
    const lines = (card.innerText || '').split('\n').map((line) => line.trim());
    // Location sits last on a card: short, no digits, not a sold count.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line.length >= 3 && line.length <= 30 && !/\d/.test(line) && !/terjual/i.test(line)) {
        return line;
      }
    }
    return null;
  }

  function scrape() {
    const config = site();
    if (!config) {
      return { ok: false, error: `${window.location.hostname} is not a supported marketplace` };
    }

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

    return {
      ok: true,
      marketplace: config.marketplace,
      items,
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString(),
      // Lets "0 items" be told apart from "the page had no links yet".
      anchorsSeen: anchors.length,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'scrapeDom') return false;
    try {
      sendResponse(scrape());
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  });
})();
