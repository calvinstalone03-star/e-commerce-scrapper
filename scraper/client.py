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
4. **Re-bootstrap** — on a 403 or a soft block (200 with a refusal envelope, or
   an HTML anti-bot interstitial where JSON was expected), call the
   ``on_blocked`` callback **at most once per request**, then retry once. A
   second block on the same request raises :class:`BlockedError`.

   A soft block is not a lesser event than a 403: Shopee answers a refused
   ``/api/v4/search/search_items`` with **HTTP 200 and a 119-byte body that says
   denied** (``.recon/browser_capture.json`` request #6). Both therefore take the
   *same* path here — :meth:`ShopeeClient._is_blocked` classifies them
   identically and :meth:`ShopeeClient._on_block` handles them identically — so
   there is exactly one recovery policy, one circuit breaker and one way for a
   blocked target to be recorded as FAILED rather than as an empty success.

Concurrency decision (binding on all downstream agents): this package is
**synchronous**. The anti-ban posture mandates one session, no proxies and a
2-5 second gap between requests, so concurrency would buy nothing and only make
the delay accounting and the single-flight re-bootstrap harder to reason about.
``pytest-asyncio`` is installed and ``asyncio_mode = "auto"`` is configured only
so a future async adapter needs no test-harness change. Do not convert these
signatures to ``async def`` without changing the Protocol in
``scraper/adapters/__init__.py`` at the same time.

Tuning knobs live at module scope (:data:`DEFAULT_HEADERS`,
:data:`RETRYABLE_STATUS_CODES`, :data:`BLOCK_ERROR_CODES`, ...) precisely because
Shopee changes them without notice; updating this file's constants should never
require touching a method body.
"""

from __future__ import annotations

import logging
import random
import re
import time
from collections.abc import Callable, Mapping
from types import TracebackType
from typing import Any

import httpx
from tenacity import (
    Retrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from scraper.config import Settings, get_settings
from scraper.session import DEFAULT_USER_AGENT, ShopeeSession

__all__ = [
    "ShopeeClient",
    "ScraperHTTPError",
    "BlockedError",
    "SHOPEE_API_BASE",
    "DEFAULT_HEADERS",
    "BLOCK_ERROR_CODES",
    "has_v4_error",
    "is_block_envelope",
    "is_soft_block",
]

log = logging.getLogger(__name__)

SHOPEE_API_BASE = "https://shopee.co.id"

#: Static, browser-shaped headers sent on every request. The dynamic parts
#: (``User-Agent``, ``Cookie``, ``X-CSRFToken``, ``Referer``, ``sec-ch-ua*``) are
#: layered on per request by :meth:`ShopeeClient._build_headers`. Keep this dict
#: in sync with a real Chrome devtools capture — see ``.recon/`` in the repo.
DEFAULT_HEADERS: Mapping[str, str] = {
    "Accept": "application/json",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "X-Requested-With": "XMLHttpRequest",
    "X-API-SOURCE": "pc",
    "X-Shopee-Language": "id",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-CH-UA-Mobile": "?0",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

#: Chromium major version claimed in ``sec-ch-ua`` when the User-Agent carries no
#: recognisable ``Chrome/<n>`` token.
DEFAULT_CHROME_MAJOR = "131"

#: httpx timeout (seconds) for connect/read/write/pool.
REQUEST_TIMEOUT = 30.0

#: Total attempts per request under the tenacity policy (1 initial + 3 retries).
MAX_ATTEMPTS = 4
RETRY_INITIAL_WAIT = 1.0
RETRY_MAX_WAIT = 30.0
RETRY_JITTER = 1.0

#: Statuses worth retrying: transient server/edge failures.
#:
#: 429 is deliberately **not** here. It used to be in both this set and
#: :data:`BLOCK_STATUS_CODES`, which meant one rate-limited request fired four
#: retried attempts, escalated to the block path, launched Chromium for fresh
#: cookies, and replayed for four more — eight requests and a headless browser
#: aimed at the endpoint that had just asked us to slow down, with the server's
#: own ``Retry-After`` never read. A soft rate limit is the last warning before a
#: hard ban; it gets a single request and an immediate stop.
RETRYABLE_STATUS_CODES = frozenset({408, 425, 500, 502, 503, 504, 520, 522, 524})

#: Statuses that mean "anti-bot", not "server had a bad day".
BLOCK_STATUS_CODES = frozenset({403, 429})

#: Statuses fresh cookies cannot fix. A rate limit is about request volume, not
#: about who we are, so :meth:`ShopeeClient._on_block` refuses to spend a browser
#: bootstrap on one.
NO_REBOOTSTRAP_STATUS_CODES = frozenset({429})

#: Minimum seconds between two forced cookie bootstraps on one client. A
#: structural block (Shopee simply refusing logged-out API traffic) is not
#: cleared by new cookies, and without this floor every blocked request bought
#: another real Chromium launch — the scraper hit Shopee harder the harder
#: Shopee pushed back.
MIN_REBOOTSTRAP_INTERVAL = 600.0

#: How many forced bootstraps may fail to clear a block before this client stops
#: trying for the rest of its life and fails fast instead.
MAX_INEFFECTIVE_REBOOTSTRAPS = 2

#: How often to re-check cookie freshness. The jar goes stale after ~12h but one
#: client lives for a whole invocation, so checking once at construction meant
#: mid-run expiry was only ever discovered by getting blocked — one wasted
#: request and one browser launch per discovery.
SESSION_RECHECK_INTERVAL = 1800.0

#: Shopee's own block codes, as *evidence*, not as the whole rule.
#:
#: ``90309999`` is the only code observed live (recon of 2026-07-27, logged out,
#: residential IP). It arrives two ways, and the second is why this module cannot
#: trust the status line:
#:
#: * as a **403** body from plain httpx — ``.recon/A_search_kaos_polos.json``,
#:   ``.recon/C_shop_search_items.json``, ``.recon/D_rcmd_items.json``,
#:   ``.recon/E_pdp_get_pc.json``;
#: * as a **HTTP 200** body, 119 bytes, from inside a real logged-out browser
#:   page — ``.recon/browser_capture.json`` request #6
#:   (``/api/v4/search/search_items``) and #27 (``/api/v4/shop/get_shop_tab``):
#:   ``{"5":false,"2":false,"4":2,"0":3,"3":90309999,"error":90309999,
#:   "1":"9880b6c7939-...","9":true}``. Same refusal, ``200 OK`` on the wire.
#:
#: Note the second shape repeats the code under an obfuscated numeric key as well
#: as under ``error``; :func:`is_block_envelope` therefore scans *values*, not
#: only the ``error`` key. Because a new code inside that key-shuffled envelope
#: would be unrecognisable by name, the general rules in
#: :func:`is_block_envelope` / :func:`is_soft_block` — not this set — are what
#: keeps detection working when Shopee changes the number.
BLOCK_ERROR_CODES = frozenset({90309999})

#: Substrings that mark an ``error_msg`` as an anti-bot refusal rather than a
#: legitimate application error such as "shop not found".
BLOCK_ERROR_MARKERS = (
    "block",
    "forbid",
    "denied",
    "not allowed",
    "captcha",
    "verify",
    "risk",
    "too many request",
    "rate limit",
)

#: Keys that ride along with the refusal envelope and appear on nothing else.
#: From ``.recon/A_search_kaos_polos.json`` (all five present) — they describe
#: the *interstitial* Shopee wants the SPA to render, which is why a data
#: endpoint's own error envelope never carries them. Two or more alongside a
#: non-zero ``error`` identify the refusal without knowing its code.
BLOCK_ENVELOPE_MARKER_KEYS = frozenset(
    {"redirect_to_error_page", "tracking_id", "is_login", "action_type", "is_customized"}
)

#: Keys that make a body a *v4 application-error envelope* — an endpoint saying
#: "your request was fine, the answer is no" (``{"error": 4, "error_msg": "shop
#: not found", "data": null}``). Their absence next to a non-zero ``error`` is
#: what marks a body as a refusal instead: the live block envelope carries
#: neither an ``error_msg`` nor a ``data`` key.
V4_ENVELOPE_KEYS = ("error_msg", "data")

#: How much of a failing body is carried on the exception, for diagnosis.
BODY_EXCERPT_CHARS = 500


def has_v4_error(payload: Mapping[str, Any]) -> bool:
    """Whether a decoded v4 body reports a non-zero ``error``.

    Shopee's success envelope is ``"error": 0``; anything else means the body
    carries no usable data, whatever the HTTP status said. Two shapes are
    deliberately *not* errors, because misreading either would fail healthy runs:

    * ``error`` absent entirely — ``{"data":"OK"}`` from ``/api/v4/web/subcart``
      (``.recon/browser_capture.json`` #5) is a perfectly good answer;
    * ``"error": null`` — ``/api/v4/abtest/traffic/get_web_experiments`` answers
      ``{"data":[],"error":null,"error_msg":null,"debug":null,"retcode":0}``
      (same capture, #3). A **null** error with an empty list is success with no
      rows, which is exactly the state this module must not confuse with a block.

    Args:
        payload: Decoded top-level JSON object.

    Returns:
        True when the body reports an error code that is not zero.
    """
    if not isinstance(payload, Mapping) or "error" not in payload:
        return False
    error = payload["error"]
    if error is None:
        return False
    if isinstance(error, bool):
        return error
    if isinstance(error, (int, float)):
        return error != 0
    if isinstance(error, str):
        text = error.strip()
        if not text:
            return False
        try:
            return float(text) != 0.0
        except ValueError:
            # A non-numeric error string ("RISK_CONTROL") is still an error.
            return True
    return bool(error)


def _looks_like_application_error(payload: Mapping[str, Any]) -> bool:
    """Whether a non-zero error is an endpoint's own answer rather than a refusal.

    An application error speaks the standard v4 envelope — it explains itself
    with an ``error_msg`` that says something, and/or carries the ``data`` it
    was able to fill. The anti-bot envelope has neither; it is a routing
    instruction for the SPA that happens to reuse the ``error`` key.

    The *substance* of those keys is what counts, not their presence. Accepting a
    bare ``"error_msg": ""`` or ``"data": null`` as an explanation handed the
    refusal a one-key escape hatch: a renumbered block carrying an empty
    ``error_msg`` was downgraded to :attr:`PageVerdict.ERROR`, which means no
    re-bootstrap, no :class:`BlockedError`, and no credit toward the runner's
    consecutive-block abort — a fully blocked invocation would walk every
    remaining target at full request volume.

    Args:
        payload: Decoded top-level JSON object with a non-zero ``error``.

    Returns:
        True when the body is shaped like a normal endpoint error.
    """
    message = payload.get("error_msg")
    if isinstance(message, str) and message.strip():
        return True
    if message is not None and not isinstance(message, str):
        # A structured error_msg (list/dict of validation problems) is still the
        # endpoint explaining itself.
        return bool(message)
    return payload.get("data") is not None


def is_block_envelope(payload: Mapping[str, Any]) -> bool:
    """Detect Shopee's anti-bot JSON envelope in a decoded body.

    Recognises, in order:

    1. ``"redirect_to_error_page": true`` — the flag that sends the SPA to
       ``/verify/traffic/error``;
    2. any top-level integer matching :data:`BLOCK_ERROR_CODES`, which is what
       catches the key-shuffled variant (``{"3": 90309999, "9": true, ...}``)
       where no key is named ``error`` at all;
    3. a non-zero ``error`` whose ``error_msg`` contains a
       :data:`BLOCK_ERROR_MARKERS` substring;
    4. a non-zero ``error`` sitting in an envelope carrying two or more
       :data:`BLOCK_ENVELOPE_MARKER_KEYS` — the code-independent fingerprint, so
       a renumbered refusal is still recognised.

    This is status-independent: the same envelope arrives as a 403 body and as a
    200 body, and the whole point is that it means the same thing either way.

    Args:
        payload: Decoded top-level JSON object.

    Returns:
        True when the payload is a block envelope.
    """
    if not isinstance(payload, Mapping):
        return False

    if payload.get("redirect_to_error_page") is True:
        return True

    for value in payload.values():
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value in BLOCK_ERROR_CODES:
            return True

    if not has_v4_error(payload):
        return False

    message = str(payload.get("error_msg") or "").lower()
    if any(marker in message for marker in BLOCK_ERROR_MARKERS):
        return True

    return len(BLOCK_ENVELOPE_MARKER_KEYS & set(payload)) >= 2


def is_soft_block(payload: Mapping[str, Any]) -> bool:
    """Classify a body that arrived under a *success* status as a block or not.

    The soft block is the whole problem this function exists for: the status line
    says 200, the payload says denied, and a caller that trusts the status
    records a refused scrape as a successful run with zero items.

    True when the body is a recognisable :func:`is_block_envelope`, **or** when
    it reports a non-zero ``error`` (:func:`has_v4_error`) that it does not
    explain as an application error (:func:`_looks_like_application_error`). The
    second clause is the general rule: an unexplained non-zero error is not
    usable data, and on a 200 the only thing that produces one is a refusal.

    Callers must only apply this to bodies the transport delivered with a
    non-error status. On a 404 the status is the honest answer — ``{"error": 4}``
    there means "no such shop", not anti-bot — and treating it as a block would
    spend a browser bootstrap on a page that simply does not exist.

    Args:
        payload: Decoded top-level JSON object from a sub-400 response.

    Returns:
        True when the response is a block despite its status.
    """
    if not isinstance(payload, Mapping):
        return False
    if is_block_envelope(payload):
        return True
    return has_v4_error(payload) and not _looks_like_application_error(payload)


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
        super().__init__(message)
        self.status_code = status_code
        self.url = url
        self.body_excerpt = body_excerpt


class BlockedError(ScraperHTTPError):
    """Shopee blocked us and a fresh cookie bootstrap did not clear it.

    The runner catches this per target: it aborts that target, records the
    ScrapeRun as FAILED, and moves on. Repeated BlockedErrors across targets are
    the signal that delays need raising or that proxies are finally warranted.
    """


class _TransientHTTPError(RuntimeError):
    """Internal-only signal that tenacity should retry this attempt.

    Never escapes :meth:`ShopeeClient.get_json`: it is either retried away, or
    translated into :class:`ScraperHTTPError` / :class:`BlockedError`.
    """

    def __init__(self, message: str, *, response: httpx.Response | None = None) -> None:
        super().__init__(message)
        self.response = response


def _sec_ch_ua(user_agent: str) -> str:
    """Build a ``sec-ch-ua`` value consistent with the given User-Agent.

    Derived rather than hardcoded so a UA bump in the session cannot silently
    leave a mismatched client-hint behind — a mismatch is exactly the kind of
    inconsistency fingerprinting looks for.

    Args:
        user_agent: The User-Agent string that will be sent alongside.

    Returns:
        A brand list claiming the same Chromium major version as the UA.
    """
    match = re.search(r"Chrome/(\d+)", user_agent)
    major = match.group(1) if match else DEFAULT_CHROME_MAJOR
    return f'"Google Chrome";v="{major}", "Chromium";v="{major}", "Not_A Brand";v="24"'


def _sec_ch_ua_platform(user_agent: str) -> str:
    """Map a User-Agent onto the platform token Chrome would send.

    Args:
        user_agent: The User-Agent string that will be sent alongside.

    Returns:
        A quoted platform name, e.g. ``'"macOS"'``.
    """
    if "Windows" in user_agent:
        platform = "Windows"
    elif "Android" in user_agent:
        platform = "Android"
    elif "Macintosh" in user_agent or "Mac OS X" in user_agent:
        platform = "macOS"
    elif "Linux" in user_agent or "X11" in user_agent:
        platform = "Linux"
    else:
        platform = "macOS"
    return f'"{platform}"'


def _body_excerpt(response: httpx.Response) -> str:
    """Collapse a response body to a single-line excerpt for logs/exceptions.

    Args:
        response: Response whose body should be summarised.

    Returns:
        Whitespace-collapsed text truncated to :data:`BODY_EXCERPT_CHARS`.
    """
    try:
        text = response.text
    except Exception:  # pragma: no cover - defensive, body already consumed
        return "<unreadable body>"
    return " ".join(text.split())[:BODY_EXCERPT_CHARS]


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
        self.settings = settings if settings is not None else get_settings()
        self.session = session if session is not None else ShopeeSession(self.settings)
        self.base_url = base_url.rstrip("/")
        self.on_blocked = (
            on_blocked
            if on_blocked is not None
            else (lambda: self.session.bootstrap_cookies(force=True))
        )

        # Retry policy knobs live on the instance so a test (or a future
        # settings field) can tune them without monkeypatching tenacity.
        self.max_attempts = MAX_ATTEMPTS
        self.retry_initial_wait = RETRY_INITIAL_WAIT
        self.retry_max_wait = RETRY_MAX_WAIT
        self.retry_jitter = RETRY_JITTER

        self._client = (
            client
            if client is not None
            else httpx.Client(
                base_url=self.base_url,
                http2=True,
                timeout=REQUEST_TIMEOUT,
                follow_redirects=True,
                headers=dict(DEFAULT_HEADERS),
            )
        )
        self._closed = False
        #: ``time.monotonic()`` of the last cookie-freshness check, or None when
        #: it has never run. Re-armed every :data:`SESSION_RECHECK_INTERVAL`.
        self._session_checked_at: float | None = None
        #: ``time.monotonic()`` of the last cookie bootstrap of any kind.
        self._last_bootstrap_at: float | None = None
        #: Forced bootstraps that did not clear the block that triggered them.
        self._ineffective_rebootstraps = 0

    # ------------------------------------------------------------------
    # context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "ShopeeClient":
        """Enter the context manager.

        Ensures cookies exist: if :meth:`ShopeeSession.is_expired` is true, a
        bootstrap runs here so the first real request is never wasted on a block.

        Returns:
            ``self``.
        """
        self._ensure_session()
        return self

    def _ensure_session(self) -> None:
        """Guarantee a usable cookie jar exists before an outbound request.

        ``__enter__`` calls it, but the client is not always used as a context
        manager: :class:`scraper.adapters.shopee.ShopeeAdapter` constructs a
        ``ShopeeClient`` itself and holds it for the life of the adapter. Without
        this hook a whole run would go out with an empty ``Cookie`` header and
        only recover via the much more expensive block -> forced-rebootstrap ->
        replay path, burning one request (and one block on Shopee's ledger) per
        client.

        The check re-arms every :data:`SESSION_RECHECK_INTERVAL` rather than
        running exactly once. A jar goes stale after ~12h and one client serves a
        whole invocation, so a once-only check meant a long run discovered
        expiry only by being blocked — paying a wasted request and a Chromium
        launch per discovery instead of one cheap proactive refresh.
        """
        now = time.monotonic()
        if (
            self._session_checked_at is not None
            and now - self._session_checked_at < SESSION_RECHECK_INTERVAL
        ):
            return
        # Set before the call, not after: a bootstrap that raises must not leave
        # the marker clear and have every subsequent request retry the browser.
        self._session_checked_at = now
        try:
            expired = self.session.is_expired()
        except Exception as exc:  # noqa: BLE001 - a broken jar must not kill the run
            log.warning("could not check cookie freshness (%s); continuing without", exc)
            return
        if not expired:
            return
        log.info("cookie jar missing or stale; bootstrapping before first request")
        try:
            self.session.bootstrap_cookies()
        except Exception as exc:  # noqa: BLE001
            # A failed bootstrap is not fatal here: some endpoints answer without
            # cookies at all, and the block path can still re-mint later.
            log.warning("cookie bootstrap failed (%s); continuing without cookies", exc)
        finally:
            # Recorded even on failure: a bootstrap that just ran and did not help
            # is precisely the one _on_block must not immediately repeat.
            self._last_bootstrap_at = time.monotonic()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Close the underlying transport. Never suppresses exceptions."""
        self.close()
        return None

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

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
            The decoded JSON object. A returned payload is *not* a promise that
            it carries data: an application error that explains itself
            (``{"error": 4, "error_msg": "shop not found"}``) comes back
            unchanged, because fresh cookies cannot fix it. Any non-zero
            ``error`` still means "no usable rows", and the caller must never
            read one as an empty-but-successful page — see
            :func:`scraper.adapters.shopee.classify_payload`.

        Raises:
            BlockedError: Blocked — by status, by interstitial, or by a soft
                block (HTTP 200 carrying a refusal envelope) — and
                re-bootstrapping did not clear it.
            ScraperHTTPError: Non-retryable HTTP status, or a body that is not
                valid JSON.
        """
        self._ensure_session()
        url = self._absolute_url(path)
        headers = self._build_headers(referer=referer)

        block_response: httpx.Response | None = None
        try:
            response = self._send_with_retries("GET", url, params=params, headers=headers)
        except _TransientHTTPError as exc:
            failed = exc.response
            if failed is not None and failed.status_code in BLOCK_STATUS_CODES:
                # A 429 that outlived every retry is rate-limit-shaped blocking,
                # not a flaky upstream — hand it to the re-bootstrap path.
                block_response = failed
            elif failed is None:
                raise ScraperHTTPError(
                    f"transport failure after {self.max_attempts} attempts: {exc}",
                    url=url,
                ) from exc
            else:
                raise ScraperHTTPError(
                    f"HTTP {failed.status_code} after {self.max_attempts} attempts",
                    status_code=failed.status_code,
                    url=url,
                    body_excerpt=_body_excerpt(failed),
                ) from exc
        else:
            if self._is_blocked(response):
                block_response = response

        if block_response is not None:
            return self._on_block(
                block_response,
                path,
                params,
                referer=referer,
                allow_rebootstrap=allow_rebootstrap,
                url=url,
            )

        if response.status_code >= 400:
            # Not a block (404s and friends are legitimate answers) but still not
            # something the adapter can parse — surface it with context.
            raise ScraperHTTPError(
                f"HTTP {response.status_code} for {url}",
                status_code=response.status_code,
                url=url,
                body_excerpt=_body_excerpt(response),
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ScraperHTTPError(
                f"response body was not valid JSON: {exc}",
                status_code=response.status_code,
                url=url,
                body_excerpt=_body_excerpt(response),
            ) from exc

        if not isinstance(payload, dict):
            raise ScraperHTTPError(
                f"expected a JSON object, got {type(payload).__name__}",
                status_code=response.status_code,
                url=url,
                body_excerpt=_body_excerpt(response),
            )
        return payload

    def close(self) -> None:
        """Close the underlying ``httpx.Client``. Idempotent."""
        if self._closed:
            return
        self._closed = True
        self._client.close()

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _on_block(
        self,
        response: httpx.Response,
        path: str,
        params: Mapping[str, Any] | None,
        *,
        referer: str | None,
        allow_rebootstrap: bool,
        url: str,
    ) -> dict[str, Any]:
        """React to a classified block: re-bootstrap once, or give up.

        Args:
            response: The blocked response, used for the error context.
            path: Original path, replayed verbatim.
            params: Original query parameters.
            referer: Original referer.
            allow_rebootstrap: False once we have already re-bootstrapped for
                this logical request.
            url: Absolute URL, for logging and the raised exception.

        Returns:
            The payload from the successful replay.

        Raises:
            BlockedError: When we have already replayed once, when the status is
                one fresh cookies cannot fix, when the bootstrap breaker is open,
                or when the ``on_blocked`` callback itself failed.
        """
        status = response.status_code
        excerpt = _body_excerpt(response)

        if not allow_rebootstrap:
            self._ineffective_rebootstraps += 1
            log.error(
                "blocked again after re-bootstrap: %s (status=%s)",
                url,
                status,
                extra={"path": path, "status": status},
            )
            raise BlockedError(
                f"blocked by Shopee at {url} (HTTP {status}) and a fresh cookie "
                f"bootstrap did not clear it",
                status_code=status,
                url=url,
                body_excerpt=excerpt,
            )

        if status in NO_REBOOTSTRAP_STATUS_CODES:
            # Rate limiting is about how much we asked for, not about who we
            # look like. Re-minting cookies cannot clear it and the browser
            # launch is itself more traffic; stop on the first one and carry the
            # server's own Retry-After up to the caller.
            retry_after = response.headers.get("Retry-After")
            suffix = f"; server asked for Retry-After: {retry_after}" if retry_after else ""
            log.warning(
                "rate limited on %s (status=%s)%s; not re-bootstrapping",
                url,
                status,
                suffix,
                extra={"path": path, "status": status},
            )
            raise BlockedError(
                f"rate limited by Shopee at {url} (HTTP {status}){suffix}",
                status_code=status,
                url=url,
                body_excerpt=excerpt,
            )

        breaker = self._rebootstrap_refusal()
        if breaker is not None:
            log.error(
                "block detected on %s (status=%s); %s",
                url,
                status,
                breaker,
                extra={"path": path, "status": status},
            )
            raise BlockedError(
                f"blocked by Shopee at {url} (HTTP {status}); {breaker}",
                status_code=status,
                url=url,
                body_excerpt=excerpt,
            )

        log.warning(
            "block detected on %s (status=%s); re-bootstrapping cookies once",
            url,
            status,
            extra={"path": path, "status": status},
        )
        self._last_bootstrap_at = time.monotonic()
        try:
            self.on_blocked()
        except Exception as exc:
            raise BlockedError(
                f"blocked by Shopee at {url} (HTTP {status}) and the cookie "
                f"re-bootstrap failed: {exc}",
                status_code=status,
                url=url,
                body_excerpt=excerpt,
            ) from exc

        return self.get_json(path, params, referer=referer, allow_rebootstrap=False)

    def _rebootstrap_refusal(self) -> str | None:
        """Whether the bootstrap circuit breaker is open, and why.

        Two independent brakes on the "block -> launch Chromium" reflex:

        * a minimum interval, which also covers the cold-start double launch —
          :meth:`_ensure_session` mints a jar, the very first request is refused
          anyway, and the old code immediately minted a second one seconds later;
        * a cap on bootstraps that demonstrably failed to clear a block, because
          a structural block (Shopee refusing logged-out API traffic outright)
          never clears and every attempt is another real browser hitting the site
          that is already refusing us.

        Returns:
            A reason string when the call must be refused, else None.
        """
        if self._ineffective_rebootstraps >= MAX_INEFFECTIVE_REBOOTSTRAPS:
            return (
                f"{self._ineffective_rebootstraps} cookie re-bootstraps have already "
                "failed to clear a block on this client; refusing to launch another "
                "browser and failing fast"
            )
        if self._last_bootstrap_at is not None:
            elapsed = time.monotonic() - self._last_bootstrap_at
            if elapsed < MIN_REBOOTSTRAP_INTERVAL:
                return (
                    f"cookies were already bootstrapped {elapsed:.0f}s ago (minimum "
                    f"interval {MIN_REBOOTSTRAP_INTERVAL:.0f}s); refusing to launch "
                    "another browser"
                )
        return None

    def _send_with_retries(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None,
        headers: Mapping[str, str],
    ) -> httpx.Response:
        """Run one request under the tenacity retry policy.

        Args:
            method: HTTP method.
            url: Absolute URL.
            params: Query parameters.
            headers: Fully-built header set.

        Returns:
            The final response, whose status is neither retryable nor a
            transport failure.

        Raises:
            _TransientHTTPError: When every attempt failed transiently.
        """
        retrying = Retrying(
            stop=stop_after_attempt(self.max_attempts),
            wait=wait_exponential_jitter(
                initial=self.retry_initial_wait,
                max=self.retry_max_wait,
                jitter=self.retry_jitter,
            ),
            retry=retry_if_exception_type(_TransientHTTPError),
            reraise=True,
        )

        def _attempt() -> httpx.Response:
            return self._request_once(
                method,
                url,
                params=params,
                headers=headers,
                attempt=int(retrying.statistics.get("attempt_number", 1)),
            )

        return retrying(_attempt)

    def _request_once(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None,
        headers: Mapping[str, str],
        attempt: int,
    ) -> httpx.Response:
        """Pace, send, log and triage exactly one HTTP attempt.

        Args:
            method: HTTP method.
            url: Absolute URL.
            params: Query parameters.
            headers: Fully-built header set. Never logged — it carries cookies.
            attempt: 1-based attempt number, for logging only.

        Returns:
            The response, when its status is not retryable.

        Raises:
            _TransientHTTPError: On a transport error or a retryable status.
        """
        self._random_delay()
        path = httpx.URL(url).path
        started = time.perf_counter()
        try:
            response = self._client.request(method, url, params=params, headers=headers)
        except httpx.TransportError as exc:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            log.warning(
                "%s %s -> transport error %s in %.0fms (attempt %d/%d)",
                method,
                path,
                type(exc).__name__,
                elapsed_ms,
                attempt,
                self.max_attempts,
                extra={
                    "method": method,
                    "path": path,
                    "status": None,
                    "elapsed_ms": round(elapsed_ms, 1),
                    "attempt": attempt,
                },
            )
            raise _TransientHTTPError(f"{type(exc).__name__}: {exc}") from exc

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        log.info(
            "%s %s -> %d in %.0fms (attempt %d/%d)",
            method,
            path,
            response.status_code,
            elapsed_ms,
            attempt,
            self.max_attempts,
            extra={
                "method": method,
                "path": path,
                "status": response.status_code,
                "elapsed_ms": round(elapsed_ms, 1),
                "attempt": attempt,
            },
        )

        if response.status_code in RETRYABLE_STATUS_CODES:
            raise _TransientHTTPError(
                f"retryable HTTP {response.status_code}", response=response
            )
        return response

    def _absolute_url(self, path: str) -> str:
        """Resolve a path against :attr:`base_url`, passing absolute URLs through.

        Args:
            path: API path beginning with ``/``, or an absolute URL.

        Returns:
            An absolute URL string.
        """
        if path.startswith(("http://", "https://")):
            return path
        return f"{self.base_url}/{path.lstrip('/')}"

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
        user_agent = self._user_agent()
        headers: dict[str, str] = dict(DEFAULT_HEADERS)
        headers["User-Agent"] = user_agent
        headers["Sec-CH-UA"] = _sec_ch_ua(user_agent)
        headers["Sec-CH-UA-Platform"] = _sec_ch_ua_platform(user_agent)
        headers["Referer"] = referer or f"{self.base_url}/"

        cookie_header = self.session.as_cookie_header()
        if cookie_header:
            headers["Cookie"] = cookie_header

        token = self.session.csrf_token()
        if token:
            headers["X-CSRFToken"] = token

        return headers

    def _user_agent(self) -> str:
        """Resolve the User-Agent to send.

        Prefers the UA the session actually drove the browser with, so the httpx
        loop and the Playwright bootstrap present one identity. Falls back to a
        settings override and finally to
        :data:`scraper.session.DEFAULT_USER_AGENT`.

        Returns:
            The User-Agent string.
        """
        for source in (self.session, self.settings):
            candidate = getattr(source, "user_agent", None)
            if isinstance(candidate, str) and candidate:
                return candidate
        return DEFAULT_USER_AGENT

    def _random_delay(self) -> float:
        """Sleep a uniform random interval inside the configured bounds.

        Called before *every* outbound request, including retries and the retry
        that follows a re-bootstrap. Uses
        ``random.uniform(settings.min_delay, settings.max_delay)``.

        Returns:
            The number of seconds actually slept (returned for logging/tests).
        """
        delay = random.uniform(self.settings.min_delay, self.settings.max_delay)
        if delay < 0.0:
            delay = 0.0
        log.debug("sleeping %.2fs before request", delay)
        time.sleep(delay)
        return delay

    def _is_blocked(self, response: httpx.Response) -> bool:
        """Classify a response as an anti-bot block.

        True when any of these hold:

        * status is 403 or 429 (:data:`BLOCK_STATUS_CODES`);
        * ``Content-Type`` is HTML on an endpoint that must return JSON, or the
          body opens with markup — the login-wall interstitial;
        * the body decodes to a recognisable :func:`is_block_envelope`,
          whatever the status;
        * the transport reported success (sub-400) but the body is a
          :func:`is_soft_block` — a non-zero ``error`` the endpoint does not
          explain. This is the 200-with-a-refusal case, and it returns True so
          that a soft block takes the identical recovery path to a 403: one
          forced re-bootstrap through :meth:`_on_block`, subject to the same
          circuit breaker, then :class:`BlockedError`.

        Not a block, and each one must stay that way:

        * ``"error": 0`` with an empty item list — a successful empty result;
        * ``"error": null`` beside ``"retcode": 0`` — the success shape of
          ``get_web_experiments`` (see :func:`has_v4_error`);
        * a 404, or any other 4xx that is not in :data:`BLOCK_STATUS_CODES` —
          the status is the endpoint's honest answer, and :meth:`get_json`
          raises :class:`ScraperHTTPError` for it rather than burning a browser
          bootstrap;
        * a non-zero ``error`` that explains itself (``{"error": 4, "error_msg":
          "shop not found"}``). It is still not usable data, but it is the
          *adapter's* problem, not the cookie jar's, so it is returned unchanged
          for :mod:`scraper.adapters.shopee` to classify and refuse to count as
          an empty page.

        Args:
            response: The response to classify.

        Returns:
            True if the caller should re-bootstrap cookies and retry.
        """
        if response.status_code in BLOCK_STATUS_CODES:
            return True

        content_type = response.headers.get("content-type", "").lower()
        if "html" in content_type:
            return True

        if "json" not in content_type:
            # No/odd content type: an interstitial is still recognisable by its
            # markup. Anything else is left alone so a text/plain JSON body from
            # a quirky endpoint is not mistaken for a block.
            body = response.text.lstrip()
            if body.startswith("<"):
                return True

        try:
            payload = response.json()
        except ValueError:
            return False
        if not isinstance(payload, dict):
            return False

        # A recognised refusal envelope means the same thing under every status.
        if is_block_envelope(payload):
            return True

        # The general soft-block rule, applied only where it is sound: the
        # transport claimed the request succeeded, so the payload is the only
        # authority left. Above 400 the status already carries the meaning, and
        # a 404's bare `{"error": 4}` must not be escalated into a block.
        return response.status_code < 400 and is_soft_block(payload)
