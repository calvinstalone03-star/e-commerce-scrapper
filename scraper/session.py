"""Playwright-backed cookie bootstrap — the slow half of the hybrid.

Shopee's internal JSON API rejects requests that lack a plausible browser
session (notably the ``SPC_F`` / ``SPC_EC`` / ``csrftoken`` family of cookies).
Rather than reverse-engineer how those are minted, we let a real Chromium
produce them once, snapshot the jar to disk, and then hand it to the fast httpx
loop in :mod:`scraper.client`.

Lifecycle::

    bootstrap_cookies()  # launch Chromium, visit Shopee, harvest cookies, save
    load_cookies()       # read cookies.json back (used on every client startup)
    is_expired()         # cheap check the client runs before each batch
    save_cookies()       # persist a jar (also called by bootstrap)

Logged-out is the default and the supported posture: public search and shop
listing endpoints do not require a login, and an anonymous session cannot get an
account banned. When ``Settings.has_credentials`` is true, ``bootstrap_cookies``
may perform a login pass — but it must degrade to the logged-out jar rather than
raise if login fails or a CAPTCHA/OTP challenge appears. This code never solves
challenges; if one blocks progress it surfaces it so a human can run with
``HEADLESS=false``.

Concurrency: **sync API**. See the note at the top of :mod:`scraper.client` for
why the whole package is deliberately synchronous.

Cookie jar on-disk format is Playwright's own ``storage_state`` cookie list, so
it round-trips through ``BrowserContext.add_cookies`` without translation::

    [{"name": ..., "value": ..., "domain": ..., "path": ...,
      "expires": <unix seconds, -1 for session>, "httpOnly": bool,
      "secure": bool, "sameSite": "Lax"|"Strict"|"None"}, ...]
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, TypedDict

from scraper.config import Settings

__all__ = ["CookieDict", "ShopeeSession", "SHOPEE_BASE_URL", "DEFAULT_USER_AGENT"]

SHOPEE_BASE_URL = "https://shopee.co.id"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class CookieDict(TypedDict, total=False):
    """One cookie in Playwright ``storage_state`` shape. See module docstring."""

    name: str
    value: str
    domain: str
    path: str
    expires: float
    httpOnly: bool
    secure: bool
    sameSite: str


class ShopeeSession:
    """Owns the Shopee cookie jar: minting it, caching it, and judging its age.

    Holds no network client of its own beyond the short-lived Playwright browser
    it opens during a bootstrap. :class:`scraper.client.ShopeeClient` composes an
    instance of this class and calls back into
    :meth:`bootstrap_cookies` when it gets blocked.
    """

    base_url: str
    settings: Settings
    cookies_path: Path

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        base_url: str = SHOPEE_BASE_URL,
        cookies_path: Path | None = None,
    ) -> None:
        """Configure the session without touching the network or the disk.

        Args:
            settings: Configuration. Defaults to ``config.get_settings()``.
            base_url: Marketplace origin to bootstrap against. Overridable so a
                test can point at a local fixture server.
            cookies_path: Where the jar lives. Defaults to
                ``settings.cookies_path``.
        """
        raise NotImplementedError

    def bootstrap_cookies(self, *, force: bool = False, login: bool | None = None) -> list[CookieDict]:
        """Launch Chromium, obtain a fresh cookie jar, persist it, return it.

        Steps:

        1. If a valid jar already exists on disk and ``force`` is False, load and
           return it without launching a browser.
        2. Launch Chromium (headless per ``Settings.headless``) with a realistic
           user agent, viewport and ``Accept-Language: id-ID,id;q=0.9``.
        3. Navigate to ``base_url``, wait for network idle, and perform a small
           amount of human-ish interaction (a scroll, a pause) so the anti-bot
           layer mints the full cookie set.
        4. If ``login`` resolves true, drive the login form with the configured
           credentials. On CAPTCHA/OTP/timeout, log a warning and keep the
           logged-out jar rather than raising.
        5. Read ``context.cookies()``, hand it to :meth:`save_cookies`, close the
           browser, return the jar.

        Args:
            force: Re-bootstrap even when a valid cached jar exists.
            login: Tri-state. None means "log in only if
                ``Settings.has_credentials``". True forces a login attempt and
                raises if credentials are missing. False stays anonymous.

        Returns:
            The cookie jar, in Playwright ``storage_state`` shape.

        Raises:
            ValueError: If ``login`` is True but no credentials are configured.
            RuntimeError: If Chromium cannot be launched (browser not installed)
                or the landing page yields no cookies at all.
        """
        raise NotImplementedError

    def load_cookies(self) -> list[CookieDict]:
        """Read the cached jar from :attr:`cookies_path`.

        Does not bootstrap. Callers that want "load, and mint if missing" should
        call :meth:`bootstrap_cookies`, which is already lazy.

        Returns:
            The stored jar, or an empty list when the file is absent or its
            contents are not a list of cookie dicts (a corrupt jar is treated as
            no jar, never as an error).
        """
        raise NotImplementedError

    def save_cookies(self, cookies: list[CookieDict]) -> None:
        """Atomically persist a jar to :attr:`cookies_path`.

        Writes to a sibling temp file and ``os.replace``s it into position so a
        crash mid-write cannot leave a half-written jar behind. Creates parent
        directories as needed. The file is gitignored — it is credential-grade
        material and must never be committed.

        Args:
            cookies: Jar to write, in Playwright ``storage_state`` shape.
        """
        raise NotImplementedError

    def is_expired(self, *, max_age_hours: float = 12.0) -> bool:
        """Cheap staleness check run before a batch of requests.

        Considered expired when any of these hold:

        * the jar file does not exist, or contains no cookies;
        * the file's mtime is older than ``max_age_hours``;
        * a cookie the API depends on (``SPC_F``, ``SPC_EC``, ``csrftoken``) is
          missing, or carries an ``expires`` already in the past.

        Session cookies (``expires == -1``) are judged purely by file mtime.

        Args:
            max_age_hours: Wall-clock age past which the jar is refreshed
                regardless of individual cookie expiry.

        Returns:
            True when the caller should re-bootstrap.
        """
        raise NotImplementedError

    def as_cookie_header(self) -> str:
        """Render the cached jar as a single ``Cookie:`` request-header value.

        Convenience for :class:`scraper.client.ShopeeClient`, which injects
        cookies by header rather than by httpx cookie jar so the exact ordering
        Shopee's edge expects is preserved.

        Returns:
            ``"name=value; name=value"``, or an empty string when the jar is empty.
        """
        raise NotImplementedError

    def csrf_token(self) -> str | None:
        """Extract the ``csrftoken`` cookie value, needed as an ``X-CSRFToken`` header.

        Returns:
            The token, or None when the jar does not carry one.
        """
        raise NotImplementedError

    def storage_state(self) -> dict[str, Any]:
        """Return the jar wrapped as a Playwright ``storage_state`` dict.

        Lets a future adapter re-open a browser already warm with this session,
        e.g. to render a page the JSON API does not expose.

        Returns:
            ``{"cookies": [...], "origins": []}``.
        """
        raise NotImplementedError
