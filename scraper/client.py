"""httpx wrapper around Shopee's internal JSON API — the fast half of the hybrid.

Once :class:`scraper.session.ShopeeSession` has minted cookies with a real
browser, everything else is plain HTTP: Shopee's own frontend talks to
``/api/v4/...`` endpoints that return JSON, and with a valid jar plus
browser-shaped headers httpx can walk them far faster than Playwright can render
pages.

Responsibilities of :class:`ShopeeClient`, in the order they apply to a request:

1. **Delay** — sleep ``uniform(min_delay, max_delay)`` before every request.
   Never burst. This is the primary anti-ban control (see docs/DESIGN.md).
2. **Headers** — send a browser-shaped header set including ``Referer``,
   ``X-Requested-With: XMLHttpRequest``, ``X-API-SOURCE: pc``, ``Accept-Language:
   id-ID``, the session's ``Cookie`` header and its ``X-CSRFToken``.
3. **Retry** — tenacity, exponential backoff with jitter, on transport errors
   and 429/5xx.
4. **Re-bootstrap** — on a 403 or a soft block (200 with an error envelope, or
   an HTML anti-bot interstitial where JSON was expected), call the
   ``on_blocked`` callback **at most once per request**, then retry once. A
   second block on the same request raises :class:`BlockedError`.

Concurrency decision (binding on all downstream agents): this package is
**synchronous**. The anti-ban posture mandates one session, no proxies and a
2-5 second gap between requests, so concurrency would buy nothing and only make
the delay accounting and the single-flight re-bootstrap harder to reason about.
``pytest-asyncio`` is installed and ``asyncio_mode = "auto"`` is configured only
so a future async adapter needs no test-harness change. Do not convert these
signatures to ``async def`` without changing the Protocol in
``scraper/adapters/__init__.py`` at the same time.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from types import TracebackType
from typing import Any

import httpx

from scraper.config import Settings
from scraper.session import ShopeeSession

__all__ = [
    "ShopeeClient",
    "ScraperHTTPError",
    "BlockedError",
    "SHOPEE_API_BASE",
    "DEFAULT_HEADERS",
]

SHOPEE_API_BASE = "https://shopee.co.id"

DEFAULT_HEADERS: Mapping[str, str] = {
    "Accept": "application/json",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "X-Requested-With": "XMLHttpRequest",
    "X-API-SOURCE": "pc",
    "X-Shopee-Language": "id",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


class ScraperHTTPError(RuntimeError):
    """A request failed in a way retries could not fix.

    Attributes:
        status_code: HTTP status, or None for a transport-level failure.
        url: The URL that failed.
        body_excerpt: First ~500 chars of the response body, for diagnosis.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        url: str | None = None,
        body_excerpt: str | None = None,
    ) -> None:
        """Store the diagnostic context alongside the message."""
        raise NotImplementedError


class BlockedError(ScraperHTTPError):
    """Shopee blocked us and a fresh cookie bootstrap did not clear it.

    The runner catches this per target: it aborts that target, records the
    ScrapeRun as FAILED, and moves on. Repeated BlockedErrors across targets are
    the signal that delays need raising or that proxies are finally warranted.
    """


class ShopeeClient:
    """Cookie-injecting, delay-pacing, self-healing httpx client for Shopee's API.

    Use as a context manager so the underlying ``httpx.Client`` is closed::

        with ShopeeClient() as client:
            payload = client.get_json("/api/v4/search/search_items", {...})

    The client owns the transport and the pacing. It does **not** know anything
    about Shopee's payload shapes — parsing lives in
    :mod:`scraper.adapters.shopee`.
    """

    settings: Settings
    session: ShopeeSession
    base_url: str
    on_blocked: Callable[[], None]

    def __init__(
        self,
        session: ShopeeSession | None = None,
        settings: Settings | None = None,
        *,
        base_url: str = SHOPEE_API_BASE,
        on_blocked: Callable[[], None] | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        """Build the client and its underlying HTTP transport.

        The ``httpx.Client`` is created with ``http2=True``, ``timeout=30``,
        ``follow_redirects=True`` and the headers in :data:`DEFAULT_HEADERS`.

        Args:
            session: Cookie source. Defaults to a fresh :class:`ShopeeSession`.
            settings: Configuration. Defaults to ``config.get_settings()``.
            base_url: API origin. Overridable so tests can point respx at it.
            on_blocked: Called with no arguments when a 403/soft block is seen,
                to re-mint cookies. Defaults to
                ``lambda: session.bootstrap_cookies(force=True)``.
            client: Inject a pre-built ``httpx.Client`` (respx tests do this).
                When provided, the client is still closed by :meth:`close`.
        """
        raise NotImplementedError

    def __enter__(self) -> "ShopeeClient":
        """Enter the context manager.

        Ensures cookies exist: if :meth:`ShopeeSession.is_expired` is true, a
        bootstrap runs here so the first real request is never wasted on a block.

        Returns:
            ``self``.
        """
        raise NotImplementedError

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Close the underlying transport. Never suppresses exceptions."""
        raise NotImplementedError

    def get_json(
        self,
        path: str,
        params: Mapping[str, Any] | None = None,
        *,
        referer: str | None = None,
        allow_rebootstrap: bool = True,
    ) -> dict[str, Any]:
        """Perform one paced, retried, cookie-injected GET and decode JSON.

        Full sequence: sleep :meth:`_random_delay` -> build headers via
        :meth:`_build_headers` -> GET under the tenacity policy -> classify the
        response with :meth:`_is_blocked`. If blocked and ``allow_rebootstrap``,
        invoke ``on_blocked`` once and recurse **once** with
        ``allow_rebootstrap=False``.

        Args:
            path: API path beginning with ``/``, or an absolute URL.
            params: Query parameters. Values are urlencoded by httpx.
            referer: ``Referer`` header. Shopee rejects some endpoints without a
                plausible one; the adapter passes the page a human would have
                been on (e.g. the search results URL).
            allow_rebootstrap: Internal guard preventing an infinite
                block/bootstrap loop. Callers leave this True.

        Returns:
            The decoded JSON object.

        Raises:
            BlockedError: Blocked, and re-bootstrapping did not clear it.
            ScraperHTTPError: Non-retryable HTTP status, or a body that is not
                valid JSON.
        """
        raise NotImplementedError

    def _build_headers(self, *, referer: str | None = None) -> dict[str, str]:
        """Compose the outgoing header set for one request.

        Merges :data:`DEFAULT_HEADERS` with the session's ``Cookie`` header, its
        ``X-CSRFToken`` when present, the configured ``User-Agent`` and the
        supplied ``Referer`` (falling back to :attr:`base_url`).

        Args:
            referer: Page URL to claim as the referrer.

        Returns:
            A fresh mutable header dict — callers may modify it safely.
        """
        raise NotImplementedError

    def _random_delay(self) -> float:
        """Sleep a uniform random interval inside the configured bounds.

        Called before *every* outbound request, including retries and the retry
        that follows a re-bootstrap. Uses
        ``random.uniform(settings.min_delay, settings.max_delay)``.

        Returns:
            The number of seconds actually slept (returned for logging/tests).
        """
        raise NotImplementedError

    def _is_blocked(self, response: httpx.Response) -> bool:
        """Classify a response as an anti-bot block.

        True when any of these hold:

        * status is 403;
        * ``Content-Type`` is HTML on an endpoint that must return JSON;
        * the body decodes to JSON carrying a block envelope (Shopee uses a
          non-zero top-level ``error`` with an ``error_msg`` mentioning a
          blocked/forbidden condition).

        A 404 or an empty result set is **not** a block — those are legitimate
        answers and must propagate to the adapter unchanged.

        Args:
            response: The response to classify.

        Returns:
            True if the caller should re-bootstrap cookies and retry.
        """
        raise NotImplementedError

    def close(self) -> None:
        """Close the underlying ``httpx.Client``. Idempotent."""
        raise NotImplementedError
