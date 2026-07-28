// Reads listings straight off the rendered page.
//
// Why this rather than the network interceptor: Shopee's search XHR answers
// this project with an empty `{"items": []}`, and the search page HTML carries
// no listing data at all — yet the products are plainly on screen. Whatever
// delivers them is not an endpoint worth chasing, because the rendered DOM is
// right there and is the thing the user can actually see.
//
// The anchor for the whole extractor is Shopee's product URL, which encodes
// both ids: `/<slug>-i.<shopId>.<itemId>`. Everything else on a card is
// localised text that moves between builds, but that URL shape has been stable
// for years, so cards are found by link and read outward from there rather than
// by class name — Shopee's class names are hashed and change without notice.
//
// This runs only when the user asks for it. It reads what the page already
// rendered; it fetches nothing.

(() => {
  'use strict';

  if (window.__ecomScraperDomReady) return;
  window.__ecomScraperDomReady = true;

  // `-i.<shopId>.<itemId>`, optionally followed by a query string.
  const PRODUCT_HREF = /-i\.(\d+)\.(\d+)/;

  // "Rp404.800" / "Rp 404.800" / "404.800". Indonesian grouping uses dots.
  const PRICE = /rp\s*([\d][\d.,]*)/i;

  // "158 terjual", "5RB+ terjual", "10K+ terjual", "Terjual 5rb+"
  const SOLD = /(?:terjual\s*([\d][\d.,]*\s*(?:rb|jt|k|m)?\+?)|([\d][\d.,]*\s*(?:rb|jt|k|m)?\+?)\s*terjual)/i;

  // A rating is a bare 1-decimal number from 0.0 to 5.0 sitting alone in its
  // element. Requiring the decimal point avoids swallowing "158" from a sold
  // count or a stray badge number.
  const RATING = /^([0-5](?:[.,]\d)?)$/;

  // How far up from the link to look for the card. Deep enough to clear the
  // image/title wrappers, shallow enough not to swallow the whole grid.
  const MAX_CARD_DEPTH = 8;

  function toNumber(text) {
    // Indonesian: "404.800" is four hundred thousand; "4,8" is four point eight.
    const cleaned = String(text).replace(/\./g, '').replace(/,/g, '.');
    const value = Number.parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  function cardFor(anchor) {
    // Walk up until the subtree is big enough to hold the whole card. A card
    // has a price and usually a rating or a sold count; the anchor alone
    // typically wraps only the image or the title.
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
    // Prefer the anchor's own title attribute or alt text — those are the
    // product name verbatim, without the badge noise the card text carries.
    const image = card.querySelector('img[alt]');
    const altText = image && image.getAttribute('alt');
    if (altText && altText.trim().length > 8) return altText.trim();

    const titled = anchor.getAttribute('title') || card.getAttribute('title');
    if (titled && titled.trim().length > 8) return titled.trim();

    // Fall back to the longest text line that is not a price or a sold count.
    const lines = (card.innerText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 8 &&
          !PRICE.test(line) &&
          !SOLD.test(line) &&
          !RATING.test(line),
      );
    lines.sort((a, b) => b.length - a.length);
    return lines[0] || null;
  }

  function extractPrice(card) {
    // The first Rp on a card is the selling price; a struck-through original
    // price follows it. Discount badges ("-56%") carry no Rp, so they are out.
    const match = PRICE.exec(card.innerText || '');
    return match ? toNumber(match[1]) : null;
  }

  function extractSold(card) {
    const match = SOLD.exec(card.innerText || '');
    if (!match) return null;
    // Returned as text: scraper.models.parse_sold already understands
    // "5RB+" / "1,5RB" / "10K+" and is the single place that logic should live.
    return (match[1] || match[2] || '').trim() || null;
  }

  function extractRating(card) {
    for (const node of card.querySelectorAll('*')) {
      if (node.children.length) continue; // leaf elements only
      const text = (node.textContent || '').trim();
      const match = RATING.exec(text);
      if (match) {
        const value = toNumber(match[1]);
        // A lone "5" is far more likely to be a badge than a perfect rating;
        // require the decimal that Shopee always renders.
        if (value !== null && /[.,]/.test(match[1])) return value;
      }
    }
    return null;
  }

  function extractLocation(card) {
    const lines = (card.innerText || '').split('\n').map((line) => line.trim());
    // Location sits last on a Shopee card and is short, title-cased text with
    // no digits — "Tangerang", "KAB. TANGERANG", "Jakarta Utara".
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line.length >= 3 && line.length <= 30 && !/\d/.test(line) && !/terjual/i.test(line)) {
        return line;
      }
    }
    return null;
  }

  function scrape() {
    const seen = new Set();
    const items = [];

    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      const match = PRODUCT_HREF.exec(href);
      if (!match) continue;

      const shopId = Number(match[1]);
      const itemId = Number(match[2]);
      const key = `${shopId}.${itemId}`;
      if (seen.has(key)) continue;

      const card = cardFor(anchor);
      const price = extractPrice(card);
      // No price means this was a related-products link or a bare text link,
      // not a listing card. Skip rather than store half a row.
      if (price === null) continue;

      seen.add(key);
      items.push({
        shopId,
        itemId,
        name: extractName(card, anchor),
        price,
        sold: extractSold(card),
        ratingStar: extractRating(card),
        location: extractLocation(card),
        url: new URL(href, window.location.origin).href.split('?')[0],
        image: (card.querySelector('img[src]') || {}).src || null,
      });
    }

    return {
      items: items.filter((entry) => entry.name),
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString(),
      // Reported so a zero-item result can be told apart from a page that had
      // no product links at all.
      anchorsSeen: document.querySelectorAll('a[href]').length,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'scrapeDom') return false;
    try {
      sendResponse({ ok: true, ...scrape() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  });
})();
