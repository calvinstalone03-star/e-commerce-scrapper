"""Local ingest endpoint for the browser extension.

The Shopee web API is closed to this project's own HTTP client — four
hypotheses were tested and disproven (request signing, being logged out,
session credentials, an automation-flagged browser) before the actual gate was
identified as an anti-bot CAPTCHA, which this project does not solve. What is
*not* blocked is the user's own ordinary browsing: their real Chrome, real
profile, real session, fetching pages they are actually looking at.

So this module inverts the direction. Instead of the scraper reaching out for
pages, the browser extension hands over the JSON its page **already received**
while the user browsed, and this endpoint parses and stores it. The extension
issues no additional requests to Shopee; the marginal load on Shopee is zero.

Deliberately dumb on the wire, smart here: the extension forwards the raw
payload and the URL it came from, and every bit of parsing reuses
:func:`scraper.adapters.shopee.parse_item` and ``_extract_items`` — the same
functions the scraping path uses, with the same tests behind them. A second
parser written in JavaScript would drift from this one within a week.

Bound to loopback and gated behind a shared token: it is an unauthenticated
write path into the user's database otherwise.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from scraper.adapters.shopee import _extract_items, parse_item
from scraper.config import Settings, get_settings
from scraper.db import session_scope
from scraper.models import Marketplace, PriceSnapshot, Product, Store, parse_sold
from scraper.store import (
    insert_snapshot_if_changed,
    upsert_product,
    upsert_product_keyword,
    upsert_store,
)

__all__ = [
    "CAPTURED_PATHS",
    "IngestResult",
    "IngestService",
    "build_app",
    "deep_find_items",
    "is_captured",
    "resolve_token",
    "keyword_from_url",
    "resolve_keyword",
    "stable_id",
]

log = logging.getLogger(__name__)

#: Shopee API paths worth ingesting. Anything else the extension forwards is
#: acknowledged and dropped, so a Shopee front-end change that adds a new
#: telemetry endpoint cannot fill the database with junk.
CAPTURED_PATHS: tuple[str, ...] = (
    "/api/v4/search/search_items",
    "/api/v4/shop/rcmd_items",
    "/api/v4/shop/get_shop_seo",
    "/api/v4/recommend/recommend",
    "/api/v4/pdp/get_pc",
    "/api/v4/pdp/get_pc_v2",
)

#: Hosts a captured URL may come from. The extension already restricts itself to
#: shopee.co.id and bridge.js pins the message origin, but this endpoint writes
#: to the user's database, so it re-checks rather than trusting its caller —
#: otherwise any local process holding the token could file arbitrary payloads
#: under a plausible-looking path.
ALLOWED_HOSTS: tuple[str, ...] = ("shopee.co.id",)

#: Env var holding the shared token. Generated on first run if absent.
TOKEN_ENV = "INGEST_TOKEN"

#: Where the generated token is cached, so the extension and the server agree
#: across restarts without the user copying it every time.
TOKEN_FILENAME = ".ingest-token"


@dataclass
class IngestResult:
    """Outcome of one ingest call.

    Attributes:
        accepted: Whether the payload matched a captured path at all.
        seen: Raw item entries found in the payload.
        stored: Snapshots actually written.
        skipped: Entries that could not be parsed into a usable item.
        unchanged: Entries whose values repeated the previous snapshot, so no
            new row was written. Not an error — the product row's last_seen
            still advanced.
        shops: Distinct shop ids touched.
        reason: Why nothing was stored, when nothing was.
    """

    accepted: bool = True
    seen: int = 0
    stored: int = 0
    skipped: int = 0
    unchanged: int = 0
    shops: set[int] = field(default_factory=set)
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """JSON-safe view for the HTTP response."""
        return {
            "accepted": self.accepted,
            "seen": self.seen,
            "stored": self.stored,
            "skipped": self.skipped,
            "unchanged": self.unchanged,
            "shops": sorted(self.shops),
            "reason": self.reason,
        }


def resolve_token(settings: Settings | None = None) -> str:
    """Return the shared ingest token, generating and caching one if needed.

    Order: ``INGEST_TOKEN`` env var, then the cached file next to the cookie
    jar, then a freshly generated token written to that file at ``0600``.

    Args:
        settings: Settings to locate the cache file from.

    Returns:
        The token the extension must send.
    """
    from pathlib import Path

    existing = os.environ.get(TOKEN_ENV, "").strip()
    if existing:
        return existing

    settings = settings or get_settings()
    cache = Path(settings.cookies_path).parent / TOKEN_FILENAME
    try:
        cached = cache.read_text(encoding="utf-8").strip()
        if cached:
            return cached
    except OSError:
        pass

    token = secrets.token_urlsafe(24)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(token, encoding="utf-8")
    cache.chmod(0o600)
    log.info("generated a new ingest token at %s", cache)
    return token


#: Keys that identify a Shopee listing object wherever it is buried. ``itemid``
#: plus a name is the minimum ``parse_item`` needs; requiring both keeps the
#: walk from collecting every id-shaped dict on the page.
_ITEM_MARKERS = ("itemid", "item_id")
_NAME_MARKERS = ("name", "title")

#: Bounds for the structural walk. A page-state blob is deep and wide, and an
#: unbounded walk over a few MB of JSON would stall the request.
_MAX_DEPTH = 12
_MAX_NODES = 200_000


def deep_find_items(payload: Any) -> list[dict[str, Any]]:
    """Find Shopee listing objects anywhere inside a structure.

    Server-rendered pages embed listings in a page-state blob rather than in one
    of the API envelopes :func:`_extract_items` knows, and the path to them moves
    with the front end. Rather than chase it, look for the shape: a dict with an
    item id and a name, or one wrapping ``item_basic``.

    Deduplicates on item id, since page state routinely holds the same listing
    under several keys.

    Args:
        payload: Any decoded JSON.

    Returns:
        Candidate listing dicts, in discovery order.
    """
    found: dict[Any, dict[str, Any]] = {}
    nodes = 0

    def looks_like_item(node: dict[str, Any]) -> bool:
        if "item_basic" in node and isinstance(node["item_basic"], dict):
            return True
        has_id = any(key in node for key in _ITEM_MARKERS)
        has_name = any(key in node for key in _NAME_MARKERS)
        return has_id and has_name

    def identity(node: dict[str, Any]) -> Any:
        inner = node.get("item_basic") if isinstance(node.get("item_basic"), dict) else node
        for key in _ITEM_MARKERS:
            if key in inner:
                return inner[key]
        return id(node)

    def walk(node: Any, depth: int) -> None:
        nonlocal nodes
        if depth > _MAX_DEPTH or nodes > _MAX_NODES:
            return
        nodes += 1

        if isinstance(node, dict):
            if looks_like_item(node):
                key = identity(node)
                if key not in found:
                    found[key] = node
                # Do not descend into a matched item: its nested variation
                # models carry itemid too and would each become a phantom row.
                return
            for value in node.values():
                walk(value, depth + 1)
        elif isinstance(node, list):
            for value in node:
                walk(value, depth + 1)

    walk(payload, 0)
    if found:
        log.info("structural walk found %d listing(s) in an unrecognised envelope", len(found))
    return list(found.values())



#: Query parameters each marketplace puts the search term in. ``searchKeyword``
#: is Shopee's in-shop search, which a storefront run navigates to and which
#: names its term differently from the site-wide one. Same list as the
#: extension's ``SEARCH_PARAMS`` in sites.js.
#: When this process loaded its code, for the staleness check in /health. Taken
#: at import rather than at server start so it reflects the code, not the socket.
_STARTED_AT = time.time()


_SEARCH_PARAMS = ("keyword", "q", "search", "st", "searchKeyword")


def keyword_from_url(page_url: str) -> str:
    """Pull the search term out of the page the listings were read from.

    The extension already sends the page URL, and the term is right there in it
    — ``?keyword=lego`` on Shopee, ``?q=lego`` on Tokopedia. Reading it here
    means the extension does not have to track what the user typed, and a scrape
    of a search page the user navigated to by hand is captured just as well as
    one triggered from the popup.

    Shop pages have no search term; those return "" and simply record no
    keyword rather than inventing one.

    Args:
        page_url: URL the extension scraped.

    Returns:
        The raw search term, or "" when the page is not a search.
    """
    try:
        query = parse_qs(urlsplit(page_url).query)
    except ValueError:
        return ""
    for param in _SEARCH_PARAMS:
        values = query.get(param)
        if values and values[0].strip():
            return values[0].strip()
    return ""


def resolve_keyword(stated: str | None, page_url: str) -> str:
    """Decide which search term a batch of DOM items was collected under.

    Two sources, in order. A shop-mode run walks a shop's own product grid and
    filters it on a term the URL never carries, so it states the term outright.
    Everything else — a search page from the popup, or one the user navigated to
    by hand — carries it in the address, which stays the fallback so nothing has
    to be stated for the ordinary case.

    Args:
        stated: Term the caller filtered on, if any.
        page_url: URL the listings were read from.

    Returns:
        The term, or "" when neither source has one.
    """
    return str(stated or "").strip() or keyword_from_url(page_url)


def is_captured(url: str) -> bool:
    """Whether a captured URL is one this endpoint stores.

    Both the host and the path must match: a listing path on some other host is
    not Shopee data, and accepting it would let anything holding the token write
    arbitrary rows.

    Args:
        url: Full request URL the extension observed.

    Returns:
        True when the host is in :data:`ALLOWED_HOSTS` and the path is in
        :data:`CAPTURED_PATHS`.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return False

    host = (parts.hostname or "").lower()
    # Exact host or a subdomain of it — never a suffix match on the raw string,
    # which "notshopee.co.id" would satisfy.
    if not any(host == allowed or host.endswith(f".{allowed}") for allowed in ALLOWED_HOSTS):
        return False

    return any(parts.path.startswith(candidate) for candidate in CAPTURED_PATHS)


class IngestService:
    """Parse captured payloads and persist them.

    Args:
        settings: Configuration; defaults to the process-wide instance.
        database_url: Override URL forwarded to :func:`session_scope`. Defaults
            to the one in settings.
    """

    def __init__(self, settings: Settings | None = None, database_url: str | None = None) -> None:
        self.settings = settings or get_settings()
        self.database_url = database_url or self.settings.database_url
        window = getattr(self.settings, "snapshot_dedupe_hours", 24.0)
        #: None disables deduplication entirely; 0 in config means the same.
        self._dedupe_window = window if window and window > 0 else None

    def ingest(self, url: str, payload: Any, captured_at: datetime | None = None) -> IngestResult:
        """Store every listing found in one captured payload.

        Args:
            url: URL the payload came from; decides whether it is captured.
            payload: Decoded JSON body exactly as the page received it.
            captured_at: When the browser saw it. Defaults to now. One value is
                shared by every snapshot in the payload so a page's listings
                form a single point in the time series rather than smearing
                across milliseconds.

        Returns:
            An :class:`IngestResult` describing what happened.
        """
        if not is_captured(url):
            return IngestResult(accepted=False, reason=f"path not captured: {url[:120]}")

        raw_items = _extract_items(payload)
        if not raw_items:
            # The known envelopes are the ones the *API* uses. Server-rendered
            # pages park the same listings somewhere inside a page-state blob
            # whose shape is not documented and changes with the front end, so
            # fall back to finding them structurally rather than by path.
            raw_items = deep_find_items(payload)
        if not raw_items:
            self._dump_unrecognized(url, payload)
            return IngestResult(seen=0, reason="payload carried no items")

        stamp = captured_at or datetime.now(timezone.utc)
        result = IngestResult(seen=len(raw_items))

        with session_scope(self.database_url) as session:
            store_refs: dict[int, int] = {}
            for raw in raw_items:
                try:
                    item = parse_item(raw)
                except Exception as exc:  # noqa: BLE001 - one bad entry must not lose the page
                    log.debug("skipping unparseable entry: %s", exc)
                    result.skipped += 1
                    continue

                try:
                    shop_ref: int | None = None
                    if item.store is not None:
                        shop_id = item.store.shop_id
                        if shop_id not in store_refs:
                            store_refs[shop_id] = upsert_store(
                                session,
                                item.store,
                                username_is_synthetic=_is_synthetic(item.store.username, shop_id),
                            )
                            result.shops.add(shop_id)
                        shop_ref = store_refs[shop_id]

                    product_ref = upsert_product(session, item.product, shop_ref, now=stamp)
                    written = insert_snapshot_if_changed(
                        session,
                        item.snapshot,
                        product_ref,
                        now=stamp,
                        window_hours=self._dedupe_window,
                    )
                    if written is None:
                        result.unchanged += 1
                    else:
                        result.stored += 1
                except Exception as exc:  # noqa: BLE001
                    log.warning("failed to persist item %s: %s", item.product.item_id, exc)
                    result.skipped += 1

        log.info(
            "ingested %s: %d seen, %d stored, %d skipped, %d shops",
            urlsplit(url).path,
            result.seen,
            result.stored,
            result.skipped,
            len(result.shops),
        )
        return result


    def ingest_dom(
        self,
        items: list[dict[str, Any]],
        page_url: str = "",
        scraped_at: datetime | None = None,
        marketplace: Marketplace | str = Marketplace.SHOPEE,
        keyword: str | None = None,
    ) -> IngestResult:
        """Store listings the extension read off the rendered page.

        The DOM path exists because the network path could not be made to work:
        Shopee's search XHR answers with an empty ``items`` array and the page
        HTML carries no listings, yet the products render fine. Rather than keep
        hunting for the endpoint, the extension reads what is on screen.

        Prices arrive already in whole rupiah — the page renders "Rp404.800", not
        micro-units — so no divisor applies here. ``sold`` arrives as the page's
        own text ("5RB+"), which :func:`scraper.models.parse_sold` normalises.

        Args:
            items: Entries from ``dom-scraper.js``: ``shopId``, ``itemId``,
                ``name``, ``price``, and optionally ``sold``, ``ratingStar``,
                ``location``, ``url``, ``image``.
            page_url: Page they were read from, for the log.
            scraped_at: One timestamp shared by the whole page, so a screenful
                forms a single point in the time series.
            keyword: Search term the caller filtered on. Overrides the one in
                ``page_url``, which a shop's own grid does not carry.

        Returns:
            An :class:`IngestResult`.
        """
        if not items:
            return IngestResult(seen=0, reason="no items supplied")

        market = Marketplace(marketplace) if not isinstance(marketplace, Marketplace) else marketplace
        keyword = resolve_keyword(keyword, page_url)
        stamp = scraped_at or datetime.now(timezone.utc)
        result = IngestResult(seen=len(items))

        with session_scope(self.database_url) as session:
            store_refs: dict[int, int] = {}
            for entry in items:
                parsed = _dom_entry_to_models(entry, market)
                if parsed is None:
                    result.skipped += 1
                    continue
                store, product, snapshot = parsed

                try:
                    if store.shop_id not in store_refs:
                        store_refs[store.shop_id] = upsert_store(
                            session,
                            store,
                            now=stamp,
                            # Only a placeholder is synthetic. Tokopedia's shop
                            # key IS the real slug, and flagging it would stop it
                            # ever being stored.
                            username_is_synthetic=_is_synthetic(
                                store.username, store.shop_id
                            ),
                        )
                        result.shops.add(store.shop_id)
                    product_ref = upsert_product(
                        session, product, store_refs[store.shop_id], now=stamp
                    )
                    if keyword:
                        upsert_product_keyword(
                            session, product_ref, keyword, market, now=stamp
                        )
                    written = insert_snapshot_if_changed(
                        session, snapshot, product_ref, now=stamp,
                        window_hours=self._dedupe_window,
                    )
                    if written is None:
                        result.unchanged += 1
                    else:
                        result.stored += 1
                except Exception as exc:  # noqa: BLE001
                    log.warning("failed to persist DOM item %s: %s", entry.get("itemId"), exc)
                    result.skipped += 1

        log.info(
            "DOM ingest from %s (keyword=%r): %d seen, %d stored, %d skipped",
            page_url[:120],
            keyword,
            result.seen,
            result.stored,
            result.skipped,
        )
        return result

    def _dump_unrecognized(self, url: str, payload: Any) -> None:
        """Save a payload nothing could be extracted from, for inspection.

        Shopee's page-state shape is undocumented and moves. When both the known
        envelopes and the structural walk come up empty, the only way to fix it
        is to look at the actual bytes — so keep them instead of discarding the
        one sample that would have explained the failure.

        Written under ``.recon/`` (gitignored, ``0600``), capped so a browsing
        session cannot fill the disk.
        """
        from pathlib import Path

        try:
            directory = Path(__file__).resolve().parent.parent / ".recon" / "unrecognized"
            directory.mkdir(parents=True, exist_ok=True)
            existing = sorted(directory.glob("*.json"))
            if len(existing) >= 20:
                return
            import json as jsonlib

            name = urlsplit(url).path.strip("/").replace("/", "_") or "payload"
            target = directory / f"{name}-{len(existing):02d}.json"
            target.write_text(
                jsonlib.dumps(payload, ensure_ascii=False)[:8_000_000], encoding="utf-8"
            )
            target.chmod(0o600)
            log.info("saved an unrecognised payload to %s for inspection", target)
        except Exception as exc:  # noqa: BLE001 - diagnostics must never break ingest
            log.debug("could not save unrecognised payload: %s", exc)


#: Mask keeping a derived id inside PostgreSQL's signed BIGINT range.
_ID_MASK = (1 << 62) - 1


def stable_id(key: str) -> int:
    """Derive a stable positive integer id from a string key.

    Shopee puts both ids in its product URL, so its keys arrive numeric and pass
    straight through. Tokopedia's URLs are ``/<shopSlug>/<productSlug>`` with no
    numeric id anywhere, so its keys are slugs — but the schema's natural key is
    ``(marketplace, item_id) BIGINT``, and price history depends on the same
    listing resolving to the same id every time.

    BLAKE2b truncated to 62 bits gives that: deterministic across processes and
    restarts (unlike :func:`hash`, which is salted per process and would mint a
    fresh id — and therefore a fresh product row — on every server restart).

    Args:
        key: Marketplace-scoped key, e.g. ``"tokosaya/lego-technic-42115"``.

    Returns:
        A positive int that fits a signed BIGINT.
    """
    digest = hashlib.blake2b(key.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") & _ID_MASK


def _resolve_key(value: Any) -> int | None:
    """Turn a marketplace key into an integer id.

    Numeric keys are used as-is so Shopee ids stay recognisable in the database
    and continue to match rows written by the API and scraping paths. Anything
    else is hashed.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)
    return stable_id(text)


#: Hosts a listing can legitimately live on, per marketplace. Exact matches, not
#: suffixes: ``seller.tokopedia.com`` and ``help.tokopedia.com`` are the same
#: domain and neither sells anything.
_LISTING_HOSTS: dict[Marketplace, frozenset[str]] = {
    Marketplace.SHOPEE: frozenset({"shopee.co.id", "www.shopee.co.id"}),
    Marketplace.TOKOPEDIA: frozenset({"tokopedia.com", "www.tokopedia.com"}),
}


def _is_listing_url(raw_url: object, marketplace: Marketplace) -> bool:
    """Whether a scraped URL points at a listing on the marketplace it claims.

    The extension already refuses to read a link that leaves the storefront, so
    this is the second wall rather than the first. It exists because the first
    one was missing for a while and the cost landed in the database: a footer
    link to ``seller.tokopedia.com/edu/official-store/`` has the exact shape of
    a Tokopedia product path, and it was stored as a product — with a price
    lifted from the footer and a name lifted from a paragraph of SEO copy.
    Cleaning that out afterwards is manual; refusing it here is not.

    A missing URL is allowed through: keyword-mode entries can arrive without
    one, and the model builds it from the ids.

    Args:
        raw_url: ``entry["url"]`` as the extension sent it, if anything.
        marketplace: The site the page belonged to.

    Returns:
        True when the URL is absent, or on one of that marketplace's own hosts.
    """
    if not raw_url:
        return True
    try:
        host = urlsplit(str(raw_url)).hostname
    except ValueError:
        return False
    if not host:
        return False
    return host.lower() in _LISTING_HOSTS.get(marketplace, frozenset())


def _dom_entry_to_models(
    entry: dict[str, Any],
    marketplace: Marketplace = Marketplace.SHOPEE,
) -> tuple[Store, Product, PriceSnapshot] | None:
    """Convert one DOM-scraped card into domain models.

    Returns None for an entry missing anything load-bearing, so one unreadable
    card cannot lose the rest of the page.

    Args:
        entry: One item from ``dom-scraper.js``. Ids arrive as ``shopKey`` /
            ``itemKey`` strings; the older numeric ``shopId`` / ``itemId`` names
            are still accepted. ``shopUsername`` and ``shopName`` are present
            only when the page stated them — a storefront does, a search page
            does not.
        marketplace: Which site the page belonged to.

    Returns:
        ``(store, product, snapshot)``, or None when unusable.
    """
    try:
        shop_id = _resolve_key(entry.get("shopKey", entry.get("shopId")))
        item_id = _resolve_key(entry.get("itemKey", entry.get("itemId")))
        name = str(entry.get("name") or "").strip()
        raw_price = entry.get("price")
        if shop_id is None or item_id is None or not name or raw_price is None:
            return None
        # Rendered prices are whole rupiah. Going through str() keeps the
        # Decimal exact instead of inheriting a float's artefacts.
        price = Decimal(str(raw_price))
        if price < 0:
            return None
        if not _is_listing_url(entry.get("url"), marketplace):
            return None
    except (TypeError, ValueError, InvalidOperation):
        return None

    rating = entry.get("ratingStar")
    try:
        rating_star = Decimal(str(rating)) if rating is not None else None
    except (InvalidOperation, ValueError):
        rating_star = None

    # Shopee search cards expose no shop slug, only the numeric id from the URL,
    # so the username is a placeholder there. Two things can beat the
    # placeholder: a username the page itself stated — a Shopee storefront URL
    # is the shop's username, and the extension forwards it as ``shopUsername``
    # — or a non-numeric key, since Tokopedia's URL *is* the slug. Either is the
    # real thing and must not be flagged synthetic.
    stated_username = str(entry.get("shopUsername") or "").strip()
    raw_shop_key = str(entry.get("shopKey", entry.get("shopId", ""))).strip()
    username = stated_username or (
        raw_shop_key if raw_shop_key and not raw_shop_key.isdigit() else f"shop-{shop_id}"
    )

    store = Store(
        marketplace=marketplace,
        shop_id=shop_id,
        username=username,
        name=(str(entry["shopName"]).strip() or None) if entry.get("shopName") else None,
        location=(str(entry["location"]).strip() or None) if entry.get("location") else None,
    )
    product = Product(
        marketplace=marketplace,
        item_id=item_id,
        shop_id=shop_id,
        name=name,
        url=(str(entry["url"]) or None) if entry.get("url") else None,
        image=(str(entry["image"]) or None) if entry.get("image") else None,
    )
    snapshot = PriceSnapshot(
        item_id=item_id,
        price=price,
        # parse_sold owns every "5RB+" / "1,5RB" / "10K+" spelling; the
        # extension deliberately forwards the page's raw text rather than
        # growing a second copy of that logic in JavaScript.
        sold=parse_sold(entry.get("sold")),
        rating_star=rating_star,
    )
    return store, product, snapshot


def _is_synthetic(username: str | None, shop_id: int) -> bool:
    """Whether a username is the placeholder the parser mints for shop-less rows.

    Keyword-search payloads carry ``shop_id`` but no slug, so the parser mints
    ``shop-<id>``. Marking it synthetic keeps ``upsert_store`` from overwriting
    a real slug that another path already stored.
    """
    return not username or username == f"shop-{shop_id}"


def build_app(
    settings: Settings | None = None,
    service: IngestService | None = None,
    neon_service: IngestService | None = None,
) -> Any:
    """Build the FastAPI application.

    Imported lazily so the rest of the package does not require FastAPI.

    The server writes to one of two databases, chosen per request by the
    ``X-Ingest-Target`` header — ``local`` (the default, and what every build of
    the extension before this sent) or ``neon``. Both destinations run the same
    parser and the same upserts; only the engine underneath differs, which is
    the whole reason the choice can live in a header instead of in a second
    implementation.

    Args:
        settings: Configuration.
        service: Pre-built local service, for tests.
        neon_service: Pre-built hosted service, for tests. Omitted, one is built
            when ``NEON_DATABASE_URL`` is set, and the target is unavailable
            when it is not.

    Returns:
        A FastAPI app exposing ``GET /health`` and ``POST /ingest``.

    Raises:
        RuntimeError: If FastAPI is not installed.
    """
    try:
        from fastapi import Body, FastAPI, Header, HTTPException
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "the ingest server needs FastAPI. Install it with:\n"
            "  uv pip install --python .venv/bin/python fastapi uvicorn"
        ) from exc

    settings = settings or get_settings()
    token = resolve_token(settings)

    if neon_service is None and settings.neon_database_url:
        neon_service = IngestService(settings, database_url=settings.neon_database_url)

    services: dict[str, IngestService | None] = {
        "local": service or IngestService(settings),
        "neon": neon_service,
    }

    app = FastAPI(title="ecom-scraper ingest", docs_url=None, redoc_url=None)
    # Published so `serve` can say at startup which targets exist.
    app.state.services = services

    def _resolve(target: str | None) -> tuple[str, IngestService]:
        """Pick the database this request writes to.

        Args:
            target: The ``X-Ingest-Target`` header, or None for the default.

        Returns:
            The resolved target name and its service.

        Raises:
            HTTPException: 422 for a target that does not exist, 503 for one
                that exists but has no database configured. Different codes on
                purpose: the first is a bug in the caller, the second is a
                missing line in `.env`, and the popup shows them differently.
        """
        name = (target or "local").strip().lower()
        if name not in services:
            raise HTTPException(
                status_code=422,
                detail=f"unknown target {name!r}; expected one of {', '.join(services)}",
            )
        chosen = services[name]
        if chosen is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"the {name} target has no database configured. Set "
                    "NEON_DATABASE_URL in .env and restart the ingest server "
                    "(launchctl kickstart -k gui/$(id -u)/com.ecomscraper.ingest)."
                ),
            )
        return name, chosen

    def _authorise(supplied: str | None) -> None:
        # compare_digest, not ==: token comparison should not leak length or
        # prefix through timing, cheap to get right.
        if not supplied or not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="bad or missing X-Ingest-Token")

    @app.get("/health")
    def health() -> dict[str, Any]:
        """Liveness probe the extension popup uses to show connection state.

        It also answers "is this process running the code on disk?", which is
        not a theoretical question: this server runs under launchd and survives
        edits, so twice now a fix landed in the source, the extension kept
        posting to a process that predated it, and the bug went on happening in
        a way that looked like the fix had not worked. `stale` compares the
        newest source file against the moment this process imported it.
        """
        newest = 0.0
        for path in Path(__file__).parent.glob("**/*.py"):
            try:
                newest = max(newest, path.stat().st_mtime)
            except OSError:  # pragma: no cover - a file vanishing mid-glob
                continue

        return {
            "ok": True,
            "marketplace": Marketplace.SHOPEE.value,
            "captured_paths": list(CAPTURED_PATHS),
            # Which destinations the popup may offer. Sent unauthenticated like
            # the rest of this route: it is a list of two names and whether each
            # is configured, not what they point at.
            "targets": {name: chosen is not None for name, chosen in services.items()},
            "started_at": datetime.fromtimestamp(_STARTED_AT, tz=timezone.utc).isoformat(),
            "source_changed_at": datetime.fromtimestamp(newest, tz=timezone.utc).isoformat(),
            # True means: restart me. `launchctl kickstart -k
            # gui/$UID/com.ecomscraper.ingest`
            "stale": newest > _STARTED_AT,
        }

    @app.post("/ingest")
    def ingest(
        body: dict[str, Any] = Body(...),
        x_ingest_token: str | None = Header(default=None),
        x_ingest_target: str | None = Header(default=None),
    ) -> dict[str, Any]:
        """Accept one captured payload from the extension.

        Body: ``{"url": str, "payload": object, "capturedAt": iso8601 | null}``.
        """
        _authorise(x_ingest_token)
        target, chosen = _resolve(x_ingest_target)

        url = str(body.get("url") or "")
        if not url:
            raise HTTPException(status_code=422, detail="url is required")

        captured_at = None
        raw_stamp = body.get("capturedAt")
        if isinstance(raw_stamp, str) and raw_stamp:
            try:
                captured_at = datetime.fromisoformat(raw_stamp.replace("Z", "+00:00"))
            except ValueError:
                captured_at = None

        result = chosen.ingest(url, body.get("payload"), captured_at)
        return {**result.as_dict(), "target": target}

    @app.post("/ingest-dom")
    def ingest_dom(
        body: dict[str, Any] = Body(...),
        x_ingest_token: str | None = Header(default=None),
        x_ingest_target: str | None = Header(default=None),
    ) -> dict[str, Any]:
        """Accept listings the extension read off a rendered page.

        Body: ``{"items": [...], "pageUrl": str, "scrapedAt": iso8601 | null}``.
        """
        _authorise(x_ingest_token)
        target, chosen = _resolve(x_ingest_target)

        items = body.get("items")
        if not isinstance(items, list):
            raise HTTPException(status_code=422, detail="items must be a list")

        scraped_at = None
        raw_stamp = body.get("scrapedAt")
        if isinstance(raw_stamp, str) and raw_stamp:
            try:
                scraped_at = datetime.fromisoformat(raw_stamp.replace("Z", "+00:00"))
            except ValueError:
                scraped_at = None

        raw_market = str(body.get("marketplace") or Marketplace.SHOPEE.value).lower()
        try:
            market = Marketplace(raw_market)
        except ValueError:
            raise HTTPException(
                status_code=422, detail=f"unknown marketplace {raw_market!r}"
            ) from None

        entries = [entry for entry in items if isinstance(entry, dict)]
        result = chosen.ingest_dom(
            entries,
            str(body.get("pageUrl") or ""),
            scraped_at,
            marketplace=market,
            keyword=str(body.get("keyword") or "") or None,
        )
        return {**result.as_dict(), "target": target}

    @app.get("/stats")
    def stats(
        x_ingest_token: str | None = Header(default=None),
        x_ingest_target: str | None = Header(default=None),
    ) -> dict[str, Any]:
        """Row counts for the extension popup, so it can show progress.

        Counted in the same database the popup is about to write to. Showing the
        laptop's totals next to a Neon destination would read as "18,256
        products are already there" when the answer is whatever Neon holds.
        """
        _authorise(x_ingest_token)
        target, chosen = _resolve(x_ingest_target)
        from scraper.db import session_scope as _scope
        from scraper.store import get_stats

        with _scope(chosen.database_url) as session:
            counts = {
                key: value
                for key, value in get_stats(session).items()
                if isinstance(value, int)
            }
        return {**counts, "target": target}

    return app
