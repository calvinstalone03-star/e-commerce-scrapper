"""Signed GraphQL client for Shopee's Affiliate Open API.

This is the *supported* route to Shopee listing data, and the reason it exists
in this project is recorded plainly so nobody re-litigates it: the web endpoint
`/api/v4/search/search_items` is closed to this client. Four hypotheses were
tested and disproven in turn — request signing, being logged out, session
credentials, and an automation-flagged browser. What actually stops it is an
anti-bot CAPTCHA challenge, which this project does not solve, work around, or
outsource to a solver service. The affiliate API answers the same questions with
credentials Shopee issues on purpose.

It is a different shape of thing from :mod:`scraper.client`:

* one POST endpoint, GraphQL body, no cookies, no browser, no anti-bot layer;
* an HMAC-style request signature over ``appId + timestamp + payload + secret``;
* ``productOfferV2`` covers **both** of this project's modes — ``keyword`` for
  keyword mode and ``shopId`` for store mode, the latter lifting the scraper's
  one-item-per-shop ceiling.

Not free of caveats, and they belong in the open:

* the catalogue is the *affiliate offer* catalogue, which is not guaranteed to
  be every product of every shop;
* rate limits are undocumented (error code ``10030`` signals the ceiling);
* it requires an approved Shopee Affiliate account. Registration is a human
  step; this module only consumes the credentials it is given.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import time
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

__all__ = [
    "AffiliateAuthError",
    "AffiliateClient",
    "AffiliateError",
    "AffiliateRateLimited",
    "DEFAULT_ENDPOINT",
    "ENDPOINTS",
    "RATE_LIMIT_CODE",
]

log = logging.getLogger(__name__)

#: Per-region GraphQL endpoints. The affiliate API is regionalised the same way
#: the storefront is; Indonesia is this project's target.
ENDPOINTS: dict[str, str] = {
    "id": "https://open-api.affiliate.shopee.co.id/graphql",
    "vn": "https://open-api.affiliate.shopee.vn/graphql",
    "br": "https://open-api.affiliate.shopee.com.br/graphql",
    "th": "https://open-api.affiliate.shopee.co.th/graphql",
    "my": "https://open-api.affiliate.shopee.com.my/graphql",
    "ph": "https://open-api.affiliate.shopee.ph/graphql",
    "sg": "https://open-api.affiliate.shopee.sg/graphql",
    "tw": "https://open-api.affiliate.shopee.tw/graphql",
}

DEFAULT_ENDPOINT = ENDPOINTS["id"]

#: Shopee's "you are going too fast" error code.
RATE_LIMIT_CODE = 10030

#: Error codes that mean the credentials are wrong rather than the request.
#: Retrying these is pointless and burns quota, so they raise immediately.
AUTH_ERROR_CODES = frozenset({10020, 10021, 10022, 10023, 11001})


class AffiliateError(RuntimeError):
    """The affiliate API answered with an error envelope.

    Attributes:
        code: Shopee's numeric error code, when one was supplied.
        message: Shopee's message.
    """

    def __init__(self, message: str, *, code: int | None = None) -> None:
        super().__init__(message if code is None else f"[{code}] {message}")
        self.code = code
        self.message = message


class AffiliateAuthError(AffiliateError):
    """Credentials were rejected. Check ``app_id`` / ``app_secret``."""


class AffiliateRateLimited(AffiliateError):
    """Rate limit hit (code 10030). Slow down; retrying immediately will not help."""


@dataclass(frozen=True)
class AffiliateCredentials:
    """App credentials issued by the Shopee Affiliate dashboard.

    Attributes:
        app_id: Numeric App ID, sent in the Authorization header in the clear.
        app_secret: App Secret. Signing input only — never sent over the wire,
            never logged.
    """

    app_id: str
    app_secret: str

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"AffiliateCredentials(app_id={self.app_id!r}, app_secret=<redacted>)"


def sign_request(app_id: str, app_secret: str, payload: str, timestamp: int) -> str:
    """Compute the request signature.

    Shopee signs the concatenation ``app_id + timestamp + payload + app_secret``
    with SHA-256 and sends the hex digest. The payload must be the **exact**
    bytes of the request body — serialise once and sign that same string, never
    re-serialise, since a re-ordered key or a changed separator silently
    invalidates the signature and yields an opaque "Invalid Signature" error.

    Args:
        app_id: Numeric App ID.
        app_secret: App Secret.
        payload: The request body exactly as it will be sent.
        timestamp: Unix seconds, the same value sent in the header.

    Returns:
        Lowercase hex SHA-256 digest.
    """
    factor = f"{app_id}{timestamp}{payload}{app_secret}"
    return hashlib.sha256(factor.encode("utf-8")).hexdigest()


class AffiliateClient:
    """POST signed GraphQL queries to the Shopee Affiliate Open API.

    Args:
        credentials: App ID / App Secret.
        endpoint: Full GraphQL URL. Defaults to the Indonesian endpoint.
        timeout: Per-request timeout in seconds.
        min_delay: Lower bound of the randomised pause before each request.
        max_delay: Upper bound of that pause. Rate limits here are undocumented,
            so the client paces itself rather than discovering the ceiling.
        transport: Optional httpx transport, for tests.
    """

    def __init__(
        self,
        credentials: AffiliateCredentials,
        *,
        endpoint: str = DEFAULT_ENDPOINT,
        timeout: float = 30.0,
        min_delay: float = 0.4,
        max_delay: float = 1.2,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.credentials = credentials
        self.endpoint = endpoint
        self.min_delay = min_delay
        self.max_delay = max_delay
        self._client = httpx.Client(
            timeout=timeout,
            transport=transport,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        #: Requests issued on this client, for progress reporting.
        self.request_count = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __enter__(self) -> AffiliateClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client. Idempotent."""
        if not self._client.is_closed:
            self._client.close()

    # ------------------------------------------------------------------
    # Requests
    # ------------------------------------------------------------------

    def execute(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """Run one GraphQL query and return its ``data`` object.

        Args:
            query: GraphQL document.
            variables: Optional variables map.

        Returns:
            The ``data`` object from the response.

        Raises:
            AffiliateAuthError: Credentials rejected.
            AffiliateRateLimited: Error code 10030.
            AffiliateError: Any other error envelope, or a malformed response.
            httpx.HTTPError: Transport-level failure that survived retries.
        """
        body: dict[str, Any] = {"query": query}
        if variables:
            body["variables"] = variables

        # Serialise ONCE. The signature covers these exact bytes; re-dumping the
        # dict for the actual send could reorder keys and invalidate it.
        payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        self._pace()
        response = self._post(payload)
        return self._unwrap(response)

    @retry(
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.TransportError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=10),
        reraise=True,
    )
    def _post(self, payload: str) -> httpx.Response:
        """POST the signed payload, retrying transport failures only."""
        timestamp = int(time.time())
        signature = sign_request(
            self.credentials.app_id, self.credentials.app_secret, payload, timestamp
        )
        headers = {
            "Authorization": (
                f"SHA256 Credential={self.credentials.app_id},"
                f"Timestamp={timestamp},"
                f"Signature={signature}"
            )
        }
        started = time.monotonic()
        response = self._client.post(
            self.endpoint, content=payload.encode("utf-8"), headers=headers
        )
        self.request_count += 1
        log.debug(
            "affiliate POST %s -> %s in %dms (request %d)",
            self.endpoint,
            response.status_code,
            int((time.monotonic() - started) * 1000),
            self.request_count,
        )
        return response

    def _pace(self) -> None:
        """Sleep a randomised beat before a request."""
        if self.max_delay > 0:
            time.sleep(random.uniform(self.min_delay, self.max_delay))

    def _unwrap(self, response: httpx.Response) -> dict[str, Any]:
        """Turn an HTTP response into ``data``, or raise the right error.

        GraphQL habitually reports application errors with HTTP 200, so the
        status line is checked *and* the envelope is inspected — the same lesson
        the web-scraping path had to learn the hard way.
        """
        if response.status_code in (401, 403):
            raise AffiliateAuthError(
                f"credentials rejected (HTTP {response.status_code}). Check "
                "SHOPEE_AFFILIATE_APP_ID / SHOPEE_AFFILIATE_APP_SECRET and that the "
                "affiliate account is approved.",
                code=response.status_code,
            )
        if response.status_code == 429:
            raise AffiliateRateLimited("rate limited (HTTP 429)", code=429)
        if response.status_code >= 400:
            raise AffiliateError(
                f"HTTP {response.status_code}: {response.text[:300]}",
                code=response.status_code,
            )

        try:
            document = response.json()
        except ValueError as exc:
            raise AffiliateError(
                f"response was not JSON: {response.text[:300]}"
            ) from exc

        if not isinstance(document, dict):
            raise AffiliateError(f"unexpected response shape: {type(document).__name__}")

        # Shopee puts its own code alongside the GraphQL envelope.
        code = document.get("error")
        if isinstance(code, int) and code != 0:
            raise self._classify(code, str(document.get("msg") or document.get("message") or ""))

        errors = document.get("errors")
        if errors:
            first = errors[0] if isinstance(errors, list) and errors else {}
            message = str(first.get("message", errors)) if isinstance(first, dict) else str(errors)
            inner = first.get("extensions", {}).get("code") if isinstance(first, dict) else None
            raise self._classify(inner if isinstance(inner, int) else None, message)

        data = document.get("data")
        if not isinstance(data, dict):
            raise AffiliateError(f"response carried no data object: {str(document)[:300]}")
        return data

    @staticmethod
    def _classify(code: int | None, message: str) -> AffiliateError:
        """Map an error code onto the most specific exception type."""
        if code == RATE_LIMIT_CODE:
            return AffiliateRateLimited(message or "rate limit exceeded", code=code)
        if code in AUTH_ERROR_CODES:
            return AffiliateAuthError(message or "credentials rejected", code=code)
        return AffiliateError(message or "affiliate API error", code=code)
