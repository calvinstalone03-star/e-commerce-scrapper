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

import logging
import os
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from scraper.adapters.shopee import _extract_items, parse_item
from scraper.config import Settings, get_settings
from scraper.db import session_scope
from scraper.models import Marketplace
from scraper.store import insert_snapshot, upsert_product, upsert_store

__all__ = [
    "CAPTURED_PATHS",
    "IngestResult",
    "IngestService",
    "build_app",
    "resolve_token",
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
        shops: Distinct shop ids touched.
        reason: Why nothing was stored, when nothing was.
    """

    accepted: bool = True
    seen: int = 0
    stored: int = 0
    skipped: int = 0
    shops: set[int] = field(default_factory=set)
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """JSON-safe view for the HTTP response."""
        return {
            "accepted": self.accepted,
            "seen": self.seen,
            "stored": self.stored,
            "skipped": self.skipped,
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
                    insert_snapshot(session, item.snapshot, product_ref, now=stamp)
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


def _is_synthetic(username: str | None, shop_id: int) -> bool:
    """Whether a username is the placeholder the parser mints for shop-less rows.

    Keyword-search payloads carry ``shop_id`` but no slug, so the parser mints
    ``shop-<id>``. Marking it synthetic keeps ``upsert_store`` from overwriting
    a real slug that another path already stored.
    """
    return not username or username == f"shop-{shop_id}"


def build_app(settings: Settings | None = None, service: IngestService | None = None) -> Any:
    """Build the FastAPI application.

    Imported lazily so the rest of the package does not require FastAPI.

    Args:
        settings: Configuration.
        service: Pre-built service, for tests.

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
    service = service or IngestService(settings)

    app = FastAPI(title="ecom-scraper ingest", docs_url=None, redoc_url=None)

    def _authorise(supplied: str | None) -> None:
        # compare_digest, not ==: token comparison should not leak length or
        # prefix through timing, cheap to get right.
        if not supplied or not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="bad or missing X-Ingest-Token")

    @app.get("/health")
    def health() -> dict[str, Any]:
        """Liveness probe the extension popup uses to show connection state."""
        return {
            "ok": True,
            "marketplace": Marketplace.SHOPEE.value,
            "captured_paths": list(CAPTURED_PATHS),
        }

    @app.post("/ingest")
    def ingest(
        body: dict[str, Any] = Body(...),
        x_ingest_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        """Accept one captured payload from the extension.

        Body: ``{"url": str, "payload": object, "capturedAt": iso8601 | null}``.
        """
        _authorise(x_ingest_token)

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

        result = service.ingest(url, body.get("payload"), captured_at)
        return result.as_dict()

    return app
