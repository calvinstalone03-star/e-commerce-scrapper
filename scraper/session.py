"""Playwright-backed cookie bootstrap — the slow half of the hybrid.

Shopee's internal JSON API rejects requests that lack a plausible browser
session (notably the ``SPC_F`` / ``SPC_EC`` / ``csrftoken`` family of cookies).
Rather than reverse-engineer how those are minted, we let a real Chromium
produce them once, snapshot the jar to disk, and then hand it to the fast httpx
loop in :mod:`scraper.client`.

Lifecycle::

    bootstrap_cookies()  # launch Chromium, visit Shopee, harvest cookies, save
    manual_login()       # open a visible window, let a HUMAN log in, harvest
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

:meth:`ShopeeSession.manual_login` is the other way in, and the one to reach for
when Shopee's login wall (``/verify/traffic/error?...&is_logged_in=false``, "Masuk
Diperlukan") is what stands between the scraper and ``search_items``. It opens a
**visible** browser, navigates to the login page, and then keeps its hands off:
the human types their own credentials and clears their own OTP/CAPTCHA, and this
module does nothing but poll the cookie jar until an authenticated cookie shows
up. Nothing in that path reads, fills, types into or even locates a credential
field — see the guard rails documented on the method itself.

Concurrency: **sync API**. See the note at the top of :mod:`scraper.client` for
why the whole package is deliberately synchronous.

Cookie jar on-disk format is Playwright's own ``storage_state`` cookie list, so
it round-trips through ``BrowserContext.add_cookies`` without translation::

    [{"name": ..., "value": ..., "domain": ..., "path": ...,
      "expires": <unix seconds, -1 for session>, "httpOnly": bool,
      "secure": bool, "sameSite": "Lax"|"Strict"|"None"}, ...]

That list is stored inside an envelope so the *identity* that minted it travels
with it (see :data:`JAR_SCHEMA_VERSION`)::

    {"version": 1,
     "cookies": [<the storage_state list above>],
     "saved_at": "2026-07-27T05:11:03.412+00:00",
     "authenticated": false,
     "user_agent": "Mozilla/5.0 (Macintosh; ...) Chrome/131.0.0.0 Safari/537.36"}

The ``user_agent`` field is load-bearing, not decorative: Shopee's edge compares
the UA on an API call against the UA that was issued the cookies, and a mismatch
is the single most common cause of an instant 403. :meth:`ShopeeSession.load_cookies`
therefore rehydrates :attr:`ShopeeSession.user_agent` from the envelope, and
:mod:`scraper.client` must send *that* string rather than a hardcoded one.

:meth:`ShopeeSession.load_cookies` also accepts a bare top-level list (the
pre-envelope format) and a ``{"cookies": {"name": "value"}}`` mapping, so an
older or hand-written jar still loads.

Security: the jar is credential-grade material. It is written ``0600``, it is
gitignored, and nothing in this module ever logs a cookie *value* or the
password — only names and counts.
"""

from __future__ import annotations

import json
import logging
import os
import random
import stat
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TypedDict
from urllib.parse import urlparse

from scraper.config import Settings, get_settings

__all__ = [
    "CookieDict",
    "ShopeeSession",
    "ChallengeDetected",
    "ManualLoginTimeout",
    "SHOPEE_BASE_URL",
    "DEFAULT_USER_AGENT",
]

log = logging.getLogger(__name__)

SHOPEE_BASE_URL = "https://shopee.co.id"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

#: Bumped when the on-disk envelope changes shape incompatibly.
JAR_SCHEMA_VERSION = 1

#: Browser context settings. Indonesian locale + Jakarta clock, because a
#: desktop Chrome claiming ``id-ID`` while reporting a UTC clock is a tell.
LOCALE = "id-ID"
TIMEZONE_ID = "Asia/Jakarta"
VIEWPORT = {"width": 1440, "height": 900}
ACCEPT_LANGUAGE = "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"

#: Cookies an *anonymous* session must carry for the JSON API to answer.
#: Deliberately excludes ``SPC_EC``/``SPC_ST``: live capture confirms those are
#: minted only after a login, so requiring them would mark every logged-out jar
#: permanently expired and spin the client in a bootstrap loop.
REQUIRED_COOKIES: tuple[str, ...] = ("SPC_F", "csrftoken")

#: Cookies that only exist once a login succeeded. Presence of any one of these
#: is how a login attempt is judged, and they are additionally required of a jar
#: that claims to be authenticated.
AUTHENTICATED_COOKIES: tuple[str, ...] = ("SPC_EC", "SPC_ST")

#: Substrings that mean Shopee bounced us to an interstitial. Matched against
#: the URL only — the ordinary homepage contains words like "Masuk" (log in) in
#: its nav, so text matching would fire constantly on a perfectly good page.
CHALLENGE_URL_MARKERS: tuple[str, ...] = (
    "/verify/traffic",
    "/verify/captcha",
    "/verify/ttcaptcha",
    "/verify/bind",
)

NAV_TIMEOUT_MS = 45_000
NETWORK_IDLE_TIMEOUT_MS = 15_000
SELECTOR_TIMEOUT_MS = 10_000
LOGIN_SETTLE_MS = 8_000
#: How long a headful run waits for a human to clear a challenge before failing.
MANUAL_CHALLENGE_TIMEOUT_MS = 180_000

#: Seconds between "still waiting for you" heartbeats during a manual login.
#: Every poll would be noise; silence would look like a hang.
MANUAL_LOGIN_HEARTBEAT_S = 15.0
#: How long the homepage is given to settle after a manual login before the jar
#: is re-harvested. Shopee finishes minting the post-login cookie set on the
#: first authenticated page load, not on the login POST itself.
MANUAL_LOGIN_SETTLE_MS = 3_000

LOGIN_PATH = "/buyer/login"
USERNAME_SELECTORS = ('input[name="loginKey"]', 'form input[type="text"]')
PASSWORD_SELECTORS = ('input[name="password"]', 'form input[type="password"]')
SUBMIT_SELECTORS = (
    'button:has-text("Log In")',
    'button:has-text("LOG IN")',
    'button:has-text("Masuk")',
    'button:has-text("MASUK")',
    'form button[type="submit"]',
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


class ChallengeDetected(RuntimeError):
    """Shopee served a CAPTCHA / traffic-verification interstitial.

    Raised instead of attempting to solve it. The message always carries the
    remedy: re-run with ``HEADLESS=false`` and clear the challenge by hand once,
    which mints a jar the fast loop can then reuse.

    Attributes:
        url: The interstitial URL we landed on.
    """

    def __init__(self, message: str, *, url: str | None = None) -> None:
        """Store the offending URL alongside the message."""
        super().__init__(message)
        self.url = url


class ManualLoginTimeout(TimeoutError):
    """Nobody finished logging in before :meth:`ShopeeSession.manual_login` gave up.

    Carries the deadline that elapsed so the message can name it, and is raised
    *instead of* saving anything: a timed-out manual login must leave whatever jar
    was already on disk untouched.

    Attributes:
        timeout_s: The deadline, in seconds, that was exceeded.
    """

    def __init__(self, message: str, *, timeout_s: int) -> None:
        """Store the elapsed deadline alongside the message."""
        super().__init__(message)
        self.timeout_s = timeout_s


def _sync_playwright() -> Any:
    """Return an unentered ``playwright.sync_api.sync_playwright()`` manager.

    Isolated into a module-level function for two reasons: the import is
    deferred so merely importing :mod:`scraper.session` does not pay Playwright's
    import cost, and tests monkeypatch this one name to install a fake driver
    instead of launching a real browser.

    Returns:
        The context manager yielding a Playwright driver handle.

    Raises:
        RuntimeError: If the ``playwright`` package is not importable.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise RuntimeError(
            "playwright is not installed. Run: pip install playwright && "
            "python -m playwright install chromium"
        ) from exc
    return sync_playwright()


def _cookie_names(cookies: list[CookieDict]) -> list[str]:
    """List cookie names for logging. Never returns values.

    Args:
        cookies: Jar to describe.

    Returns:
        The names, in jar order.
    """
    return [str(c.get("name", "")) for c in cookies]


def _has_cookie(cookies: list[CookieDict], name: str) -> bool:
    """Whether a jar carries a cookie of this name. Values are never compared.

    Args:
        cookies: Jar to inspect.
        name: Cookie name to look for.

    Returns:
        True if present.
    """
    return any(str(c.get("name", "")) == name for c in cookies)


class ShopeeSession:
    """Owns the Shopee cookie jar: minting it, caching it, and judging its age.

    Holds no network client of its own beyond the short-lived Playwright browser
    it opens during a bootstrap. :class:`scraper.client.ShopeeClient` composes an
    instance of this class and calls back into
    :meth:`bootstrap_cookies` when it gets blocked.

    Attributes:
        base_url: Marketplace origin bootstrapped against.
        settings: Configuration in force.
        cookies_path: Where the jar is persisted.
        user_agent: The UA string Playwright ran with. Rehydrated from disk by
            :meth:`load_cookies` so the httpx loop can send an identical one.
        authenticated: Whether the cached jar carries a logged-in session.
    """

    base_url: str
    settings: Settings
    cookies_path: Path
    user_agent: str
    authenticated: bool

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        base_url: str = SHOPEE_BASE_URL,
        cookies_path: Path | None = None,
        user_agent: str | None = None,
    ) -> None:
        """Configure the session without touching the network or the disk.

        Args:
            settings: Configuration. Defaults to ``config.get_settings()``.
            base_url: Marketplace origin to bootstrap against. Overridable so a
                test can point at a local fixture server.
            cookies_path: Where the jar lives. Defaults to
                ``settings.cookies_path``.
            user_agent: Override the UA Chromium runs with. Defaults to
                :data:`DEFAULT_USER_AGENT`, and is replaced by the persisted UA
                as soon as an existing jar is loaded.
        """
        self.settings = get_settings() if settings is None else settings
        self.base_url = base_url.rstrip("/")
        self.cookies_path = Path(
            cookies_path if cookies_path is not None else self.settings.cookies_path
        )
        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.authenticated = False
        # In-memory mirror of the jar. None means "not read from disk yet";
        # an empty list means "read, and there was nothing there".
        self._cookies: list[CookieDict] | None = None

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------

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
            ChallengeDetected: If the landing page bounced to a CAPTCHA or
                traffic-verification interstitial that a human must clear.
            RuntimeError: If Chromium cannot be launched (browser not installed)
                or the landing page yields no cookies at all.
        """
        if login is True and not self.settings.has_credentials:
            raise ValueError(
                "bootstrap_cookies(login=True) needs SHOPEE_USERNAME and SHOPEE_PASSWORD. "
                "Leave login unset to bootstrap a logged-out session, which is the "
                "supported default."
            )

        if not force:
            cached = self.load_cookies()
            if cached and not self.is_expired():
                log.info(
                    "Reusing cached cookie jar: %d cookies from %s (authenticated=%s)",
                    len(cached),
                    self.cookies_path,
                    self.authenticated,
                )
                return cached

        want_login = self.settings.has_credentials if login is None else bool(login)
        log.info(
            "Bootstrapping Shopee cookies with Chromium (headless=%s, login=%s)",
            self.settings.headless,
            want_login,
        )

        cookies, authenticated = self._run_browser_bootstrap(want_login=want_login)

        if not cookies:
            raise RuntimeError(
                f"Bootstrap harvested no cookies from {self.base_url}. The page may have "
                "failed to load. Re-run with HEADLESS=false to see what the browser sees."
            )

        self.authenticated = authenticated
        self.save_cookies(cookies)
        log.info(
            "Bootstrapped %d cookies (authenticated=%s): %s",
            len(cookies),
            authenticated,
            ", ".join(_cookie_names(cookies)),
        )
        missing = self._missing_required(cookies)
        if missing:
            log.warning(
                "Cookie jar is missing expected names %s — the API may reject it. "
                "Re-run with HEADLESS=false to check for an interstitial.",
                ", ".join(missing),
            )
        return cookies

    def bootstrap(self, force: bool = False) -> dict[str, str]:
        """Convenience wrapper: bootstrap and return a ``{name: value}`` mapping.

        Thin alias over :meth:`bootstrap_cookies` for callers that only want the
        flat mapping. The canonical entry point remains
        :meth:`bootstrap_cookies`, which returns the full Playwright shape.

        Args:
            force: Re-bootstrap even when a valid cached jar exists.

        Returns:
            Cookie name to value, in jar order.
        """
        return self._as_mapping(self.bootstrap_cookies(force=force))

    def get_cookies(self) -> dict[str, str]:
        """Return the jar as ``{name: value}``, bootstrapping lazily if needed.

        Reads the cached jar; if the file is missing, empty or stale it mints a
        fresh one first. This is the lazy accessor described in the design —
        :meth:`load_cookies` deliberately never launches a browser.

        Returns:
            Cookie name to value, in jar order.
        """
        cookies = self.load_cookies()
        if not cookies or self.is_expired():
            cookies = self.bootstrap_cookies()
        return self._as_mapping(cookies)

    def _run_browser_bootstrap(self, *, want_login: bool) -> tuple[list[CookieDict], bool]:
        """Drive one whole Chromium session and return its jar.

        Args:
            want_login: Whether to attempt the login flow after warm-up.

        Returns:
            ``(cookies, authenticated)``.

        Raises:
            ChallengeDetected: An interstitial blocked the landing page.
            RuntimeError: Chromium could not be launched or the session failed.
        """
        with _sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(
                    headless=self.settings.headless,
                    args=["--disable-blink-features=AutomationControlled"],
                )
            except Exception as exc:
                raise RuntimeError(
                    "Could not launch Chromium. Install the browser binary with: "
                    f"python -m playwright install chromium (original error: {exc})"
                ) from exc

            try:
                context = browser.new_context(
                    user_agent=self.user_agent,
                    locale=LOCALE,
                    timezone_id=TIMEZONE_ID,
                    viewport=dict(VIEWPORT),
                    extra_http_headers={"Accept-Language": ACCEPT_LANGUAGE},
                )
                page = context.new_page()
                self._warm_up(page)
                authenticated = False
                if want_login:
                    authenticated = self._attempt_login(page, context)
                cookies = self._harvest(context)
            except ChallengeDetected:
                raise
            except Exception as exc:
                raise RuntimeError(f"Shopee cookie bootstrap failed: {exc}") from exc
            finally:
                try:
                    browser.close()
                except Exception:  # pragma: no cover - close is best effort
                    log.debug("Ignoring error while closing Chromium", exc_info=True)

        return cookies, authenticated

    def _warm_up(self, page: Any) -> None:
        """Load the landing page and behave like a bored human for a moment.

        Navigates, waits for the network to settle, scrolls a little and pauses.
        The anti-bot layer mints part of the cookie set from client-side script
        that only runs once the page is interactive, so landing and immediately
        reading cookies yields a short jar.

        Args:
            page: Playwright page.

        Raises:
            ChallengeDetected: If the landing page bounced to an interstitial
                and (when headful) a human did not clear it in time.
        """
        page.goto(self.base_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        try:
            page.wait_for_load_state("networkidle", timeout=NETWORK_IDLE_TIMEOUT_MS)
        except Exception:
            # Shopee's homepage keeps long-poll connections open, so networkidle
            # legitimately times out. Not fatal — carry on with what loaded.
            log.debug("networkidle wait timed out; continuing", exc_info=True)

        self._guard_challenge(page)

        for delta in (random.randint(300, 700), random.randint(400, 900)):
            try:
                page.mouse.wheel(0, delta)
            except Exception:  # pragma: no cover - input is best effort
                log.debug("Scroll gesture failed; continuing", exc_info=True)
            page.wait_for_timeout(random.randint(400, 1200))

        self._guard_challenge(page)

    def _is_challenged(self, page: Any) -> bool:
        """Whether the page currently sits on a CAPTCHA/verification interstitial.

        Args:
            page: Playwright page.

        Returns:
            True if the current URL matches :data:`CHALLENGE_URL_MARKERS`.
        """
        try:
            url = str(page.url or "")
        except Exception:  # pragma: no cover - defensive
            return False
        return any(marker in url for marker in CHALLENGE_URL_MARKERS)

    def _guard_challenge(self, page: Any) -> None:
        """Raise :class:`ChallengeDetected` if an interstitial is in the way.

        In a headful run the operator gets :data:`MANUAL_CHALLENGE_TIMEOUT_MS` to
        clear it by hand, which is exactly the documented remedy; the poll exits
        as soon as the URL stops matching. Headless runs fail immediately —
        nobody is watching.

        Args:
            page: Playwright page.

        Raises:
            ChallengeDetected: Interstitial present and not cleared.
        """
        if not self._is_challenged(page):
            return

        url = str(page.url or "")
        if not self.settings.headless:
            log.warning(
                "Challenge page detected at %s — solve it in the open browser window; "
                "waiting up to %d seconds.",
                url,
                MANUAL_CHALLENGE_TIMEOUT_MS // 1000,
            )
            waited = 0
            step = 2_000
            while waited < MANUAL_CHALLENGE_TIMEOUT_MS:
                page.wait_for_timeout(step)
                waited += step
                if not self._is_challenged(page):
                    log.info("Challenge cleared by hand after %ds; continuing.", waited // 1000)
                    return

        raise ChallengeDetected(
            f"Shopee served an anti-bot challenge at {url}. This tool does not solve "
            "challenges. Re-run the bootstrap with HEADLESS=false (or "
            "`ecom-scraper bootstrap --headful`), clear it by hand once, and the "
            "harvested cookies will be reused by the fast loop.",
            url=url,
        )

    def _attempt_login(self, page: Any, context: Any) -> bool:
        """Best-effort login. Never raises — a failure means "stay anonymous".

        Drives the buyer login form with the configured credentials, then judges
        success purely by whether an authenticated cookie appeared. A CAPTCHA,
        an OTP prompt, a changed selector or a timeout are all treated the same
        way: warn, and keep the logged-out jar. Logged-out is a fully supported
        posture, so degrading is strictly better than failing the run.

        The password is never logged, never included in an exception message and
        never written anywhere but the form field.

        Args:
            page: Playwright page, already warmed up on the landing page.
            context: Browser context, used to inspect the resulting cookies.

        Returns:
            True only if an authenticated session cookie is present afterwards.
        """
        username = self.settings.shopee_username
        password = self.settings.shopee_password
        if not username or not password:
            log.warning("Login requested but credentials are incomplete; staying logged out.")
            return False

        try:
            page.goto(
                f"{self.base_url}{LOGIN_PATH}",
                wait_until="domcontentloaded",
                timeout=NAV_TIMEOUT_MS,
            )
            user_sel = self._first_selector(page, USERNAME_SELECTORS)
            pass_sel = self._first_selector(page, PASSWORD_SELECTORS)
            if user_sel is None or pass_sel is None:
                log.warning(
                    "Login form not found (username=%s, password=%s); staying logged out.",
                    user_sel is not None,
                    pass_sel is not None,
                )
                return False

            page.fill(user_sel, username)
            page.wait_for_timeout(random.randint(200, 600))
            page.fill(pass_sel, password)
            page.wait_for_timeout(random.randint(200, 600))

            submit_sel = self._first_selector(page, SUBMIT_SELECTORS)
            if submit_sel is None:
                log.warning("Login submit button not found; staying logged out.")
                return False
            page.click(submit_sel)
            page.wait_for_timeout(LOGIN_SETTLE_MS)

            if self._is_challenged(page):
                log.warning(
                    "Login hit a CAPTCHA/OTP challenge at %s; keeping the logged-out jar. "
                    "Run with HEADLESS=false to complete it by hand.",
                    page.url,
                )
                return False

            names = {str(c.get("name", "")) for c in (context.cookies() or [])}
            authenticated = any(name in names for name in AUTHENTICATED_COOKIES)
            if authenticated:
                # The identifier is deliberately not logged: `-v --log-file` opens
                # a plain-text handler at INFO, so naming the account would write
                # half a credential pair — plus confirmation that it is valid —
                # into a file on disk. Only one account can be configured, so the
                # name adds nothing operationally.
                log.info("Login succeeded; jar is authenticated.")
            else:
                log.warning(
                    "Login did not produce an authenticated cookie (looked for %s); "
                    "keeping the logged-out jar.",
                    ", ".join(AUTHENTICATED_COOKIES),
                )
            return authenticated
        except ChallengeDetected as exc:
            log.warning("Login blocked by a challenge (%s); keeping the logged-out jar.", exc.url)
            return False
        except Exception as exc:
            # Deliberately broad: every login failure mode degrades to anonymous.
            # exc never contains the password — it is only ever passed to page.fill.
            log.warning(
                "Login attempt failed (%s: %s); keeping the logged-out jar.",
                type(exc).__name__,
                exc,
            )
            return False

    def _first_selector(self, page: Any, candidates: tuple[str, ...]) -> str | None:
        """Return the first selector in ``candidates`` that resolves on the page.

        Shopee's markup changes without notice, so each field is tried against a
        short list of plausible selectors rather than one brittle string.

        Args:
            page: Playwright page.
            candidates: Selectors to try, most specific first.

        Returns:
            The first selector that matched, or None if none did.
        """
        for selector in candidates:
            try:
                if page.wait_for_selector(selector, timeout=SELECTOR_TIMEOUT_MS, state="visible"):
                    return selector
            except Exception:
                log.debug("Selector %r did not resolve", selector)
        return None

    def _harvest(self, context: Any) -> list[CookieDict]:
        """Read the browser context's cookies into our own shape.

        Args:
            context: Playwright browser context.

        Returns:
            Normalised cookie jar.
        """
        raw = context.cookies() or []
        return _normalise_cookies(raw, default_domain=self._default_cookie_domain())

    # ------------------------------------------------------------------
    # Manual login — the human types, this code only watches the jar
    # ------------------------------------------------------------------

    def manual_login(self, timeout_s: int = 600, poll_s: float = 2.0) -> list[CookieDict]:
        """Open a visible browser, wait for a *human* to log in, harvest the jar.

        This is the answer to Shopee's login wall. ``/api/v4/search/search_items``
        and ``/api/v4/shop/get_shop_tab`` answer a logged-out caller with HTTP 200
        and a 119-byte ``{"error":90309999,...}`` body, and the page itself
        redirects to ``/verify/traffic/error?...&is_logged_in=false`` ("Masuk
        Diperlukan"). Requests fired from inside a live page are fully signed by
        Shopee's own SDK and are rejected all the same, so signing is not the
        gate — being logged in is. The only supported way through is for the
        account's owner to log in themselves.

        What this method does, in order:

        1. Launches Chromium with ``headless=False`` **unconditionally**.
           ``Settings.headless`` is deliberately ignored: a manual login nobody
           can see is a contradiction, so a platform that cannot open a window
           gets a clear error rather than a browser that waits forever offscreen.
        2. Navigates to ``<base_url>/buyer/login`` and stops touching the page.
        3. Polls ``context.cookies()`` every ``poll_s`` seconds for any of
           :data:`AUTHENTICATED_COOKIES`, printing a heartbeat with the remaining
           time every :data:`MANUAL_LOGIN_HEARTBEAT_S` seconds.
        4. On success, loads the homepage once so the post-login cookie set
           finishes minting, re-harvests, and persists through
           :meth:`save_cookies` — same envelope, same ``0600`` file, same
           recorded user agent as a bootstrap.

        What this method never does, and what no future edit may add to it:

        * it never locates, reads, fills, types into, clicks or submits the
          username, password or OTP fields — :data:`USERNAME_SELECTORS`,
          :data:`PASSWORD_SELECTORS` and :data:`SUBMIT_SELECTORS` are not
          referenced anywhere on this path;
        * it never solves or bypasses a CAPTCHA, slider or OTP challenge;
        * it never reads credentials from settings, the environment or anywhere
          else. The credential-driven :meth:`_attempt_login` is a separate,
          untouched path used only by :meth:`bootstrap_cookies`.

        Args:
            timeout_s: How long to wait for the login to complete, in seconds.
            poll_s: Seconds between cookie-jar polls.

        Returns:
            The harvested jar, in Playwright ``storage_state`` shape, already
            persisted to :attr:`cookies_path` with ``authenticated=true``.

        Raises:
            ValueError: If ``timeout_s`` or ``poll_s`` is not positive.
            ManualLoginTimeout: If no authenticated cookie appeared in time. The
                existing jar on disk is left exactly as it was.
            RuntimeError: If a visible Chromium cannot be launched, or if the
                window was closed before the login finished.
        """
        if timeout_s <= 0:
            raise ValueError(f"timeout_s must be positive, got {timeout_s}")
        if poll_s <= 0:
            raise ValueError(f"poll_s must be positive, got {poll_s}")

        log.info(
            "Manual login: opening a visible Chromium at %s%s (waiting up to %ds)",
            self.base_url,
            LOGIN_PATH,
            timeout_s,
        )
        cookies = self._run_manual_login_browser(timeout_s=timeout_s, poll_s=poll_s)

        # Only reached once an authenticated cookie is actually in hand, so the
        # save below can never overwrite a good jar with a logged-out one.
        self.authenticated = True
        self.save_cookies(cookies)
        log.info(
            "Manual login captured %d cookies (authenticated=True): %s",
            len(cookies),
            ", ".join(_cookie_names(cookies)),
        )
        missing = self._missing_required(cookies)
        if missing:
            log.warning(
                "Cookie jar is missing expected names %s — the API may reject it.",
                ", ".join(missing),
            )
        return cookies

    def _run_manual_login_browser(self, *, timeout_s: int, poll_s: float) -> list[CookieDict]:
        """Drive the whole visible-browser manual login and return its jar.

        Split out of :meth:`manual_login` so that persistence happens strictly
        after the browser is closed: nothing is written while a window the user
        may ``ctrl-C`` at any moment is still open.

        Args:
            timeout_s: Deadline for the human to finish, in seconds.
            poll_s: Seconds between cookie-jar polls.

        Returns:
            The harvested, authenticated jar.

        Raises:
            ManualLoginTimeout: The deadline passed with no authenticated cookie.
            RuntimeError: Chromium could not be launched visibly, the login page
                could not be reached, or the window went away mid-login.
        """
        deadline = time.monotonic() + timeout_s

        with _sync_playwright() as pw:
            browser: Any = None
            context: Any = None
            page: Any = None
            try:
                try:
                    # headless is hardcoded False on purpose. Do not thread
                    # Settings.headless in here.
                    browser = pw.chromium.launch(
                        headless=False,
                        args=["--disable-blink-features=AutomationControlled"],
                    )
                except Exception as exc:
                    raise RuntimeError(
                        "Could not open a visible browser window for the manual login. "
                        "This command cannot run headless — you have to be able to see "
                        "the page to type into it. Run it on a desktop session (not a "
                        "bare SSH shell), and make sure the browser binary is installed "
                        "with: python -m playwright install chromium "
                        f"(original error: {exc})"
                    ) from exc

                context = browser.new_context(
                    user_agent=self.user_agent,
                    locale=LOCALE,
                    timezone_id=TIMEZONE_ID,
                    viewport=dict(VIEWPORT),
                    extra_http_headers={"Accept-Language": ACCEPT_LANGUAGE},
                )
                page = context.new_page()
                login_url = f"{self.base_url}{LOGIN_PATH}"
                try:
                    page.goto(
                        login_url,
                        wait_until="domcontentloaded",
                        timeout=NAV_TIMEOUT_MS,
                    )
                except Exception as exc:
                    # Playwright's Error/TimeoutError are plain Exceptions, so
                    # letting them out unwrapped broke this method's documented
                    # contract and reached the CLI as a bare traceback. The
                    # realistic trigger is a slow connection missing the 45s
                    # navigation timeout.
                    raise RuntimeError(
                        f"Could not open Shopee's login page at {login_url} within "
                        f"{NAV_TIMEOUT_MS // 1000}s ({type(exc).__name__}: {exc}). "
                        "Nothing was saved and any existing jar is untouched. Check "
                        "that the site loads in a normal browser, then re-run "
                        "`ecom-scraper login`."
                    ) from exc
                # From here on the page is the human's. Nothing below touches it
                # except to poll cookies and, after success, to load the homepage.
                harvested = self._poll_for_authenticated_jar(
                    context, deadline=deadline, poll_s=poll_s
                )
                if harvested is None:
                    raise ManualLoginTimeout(
                        f"no Shopee login completed within {timeout_s}s, so no "
                        f"authenticated cookie ({' or '.join(AUTHENTICATED_COOKIES)}) "
                        "ever appeared. Nothing was saved and any existing jar is "
                        "untouched. Re-run `ecom-scraper login` — add "
                        "`--timeout 1200` if you need longer than "
                        f"{timeout_s}s at the keyboard.",
                        timeout_s=timeout_s,
                    )
                return self._settle_after_manual_login(page, context, harvested)
            finally:
                # Runs on success, on timeout, on a Playwright error and on the
                # KeyboardInterrupt the operator is very likely to send: this
                # command's whole job is to sit and wait. Nothing here may raise
                # or a leaked Chromium becomes the least of the problems.
                self._close_quietly(page, context, browser)

    def _poll_for_authenticated_jar(
        self, context: Any, *, deadline: float, poll_s: float
    ) -> list[CookieDict] | None:
        """Watch the cookie jar until a login lands or the deadline passes.

        The jar is the only thing inspected. The page is never queried for state,
        so a redesigned login form, an OTP step or a CAPTCHA in the middle costs
        nothing here — whatever the human has to do, the cookies show up when it
        is done.

        Args:
            context: Playwright browser context.
            deadline: ``time.monotonic()`` value after which to give up.
            poll_s: Seconds between polls.

        Returns:
            The harvested jar as soon as it carries an authenticated cookie, or
            None if the deadline passed first.

        Raises:
            RuntimeError: If the browser window went away while we were waiting.
        """
        last_beat = time.monotonic()
        while True:
            try:
                cookies = self._harvest(context)
            except Exception as exc:
                raise RuntimeError(
                    "The browser window closed before the login finished, so no "
                    "cookies were captured. Nothing was saved. Re-run "
                    "`ecom-scraper login` and leave the window open until the "
                    f"command says it is done ({type(exc).__name__}: {exc})."
                ) from exc

            found = [name for name in AUTHENTICATED_COOKIES if _has_cookie(cookies, name)]
            if found:
                log.info(
                    "Manual login detected: %s present in the jar (%d cookies).",
                    ", ".join(found),
                    len(cookies),
                )
                return cookies

            now = time.monotonic()
            remaining = deadline - now
            if remaining <= 0:
                return None
            if now - last_beat >= MANUAL_LOGIN_HEARTBEAT_S:
                last_beat = now
                print(
                    f"  ... waiting for you to finish logging in "
                    f"({int(remaining)}s left)",
                    flush=True,
                )
            time.sleep(min(poll_s, remaining))

    def _settle_after_manual_login(
        self, page: Any, context: Any, harvested: list[CookieDict]
    ) -> list[CookieDict]:
        """Load the homepage once so the jar settles, then re-harvest.

        Shopee tops the cookie set up on the first authenticated page load, so the
        jar read the instant ``SPC_EC`` appears is usually a cookie or two short of
        what the httpx loop wants.

        Args:
            page: Playwright page.
            context: Playwright browser context.
            harvested: The jar as read the moment the login was detected. Used as
                the fallback for every failure mode here — a warm-up problem must
                never cost us a login the human already completed.

        Returns:
            The settled jar, or ``harvested`` when the warm-up did not improve it.
        """
        try:
            page.goto(self.base_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            page.wait_for_timeout(MANUAL_LOGIN_SETTLE_MS)
            settled = self._harvest(context)
        except Exception:
            log.debug(
                "Warm-up after the manual login failed; keeping the jar as harvested",
                exc_info=True,
            )
            return harvested

        if not any(_has_cookie(settled, name) for name in AUTHENTICATED_COOKIES):
            log.warning(
                "The warm-up navigation dropped the authenticated cookie; keeping the "
                "jar exactly as it was when the login completed."
            )
            return harvested
        log.debug(
            "Jar after warm-up: %d cookies (%s)",
            len(settled),
            ", ".join(_cookie_names(settled)),
        )
        return settled

    @staticmethod
    def _close_quietly(page: Any, context: Any, browser: Any) -> None:
        """Close page, context and browser, swallowing every failure.

        Called from a ``finally``, including on ``KeyboardInterrupt``. Each handle
        is closed independently so one broken handle cannot strand the next — a
        leaked Chromium outlives the process and keeps holding the profile.

        Args:
            page: Playwright page, or None if it was never created.
            context: Playwright browser context, or None.
            browser: Playwright browser, or None.
        """
        for handle, label in ((page, "page"), (context, "context"), (browser, "browser")):
            if handle is None:
                continue
            try:
                handle.close()
            except Exception:  # pragma: no cover - close is best effort
                log.debug("Ignoring error while closing the %s", label, exc_info=True)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def load_cookies(self) -> list[CookieDict]:
        """Read the cached jar from :attr:`cookies_path`.

        Does not bootstrap. Callers that want "load, and mint if missing" should
        call :meth:`bootstrap_cookies`, which is already lazy.

        Side effect: rehydrates :attr:`user_agent` and :attr:`authenticated` from
        the envelope, so the httpx client sends the same UA the browser used.

        Returns:
            The stored jar, or an empty list when the file is absent or its
            contents are not a list of cookie dicts (a corrupt jar is treated as
            no jar, never as an error).
        """
        payload = self._read_payload()
        if payload is None:
            self._cookies = []
            return []

        cookies, user_agent, authenticated, _saved_at = payload
        self._cookies = cookies
        if user_agent:
            self.user_agent = user_agent
        self.authenticated = authenticated
        log.debug(
            "Loaded %d cookies from %s: %s",
            len(cookies),
            self.cookies_path,
            ", ".join(_cookie_names(cookies)),
        )
        return cookies

    def save_cookies(self, cookies: list[CookieDict]) -> None:
        """Atomically persist a jar to :attr:`cookies_path`.

        Writes to a sibling temp file and ``os.replace``s it into position so a
        crash mid-write cannot leave a half-written jar behind. Creates parent
        directories as needed. The jar is credential-grade material and must
        never be committed: it is always written ``0600`` so other local accounts
        cannot read the session, and ``.gitignore`` covers the default name plus
        anything matching ``*cookies*.json`` — a ``COOKIES_PATH`` outside those
        patterns has to be added there by hand.

        Args:
            cookies: Jar to write, in Playwright ``storage_state`` shape.
        """
        normalised = _normalise_cookies(cookies, default_domain=self._default_cookie_domain())
        saved_at = datetime.now(timezone.utc)
        payload = {
            "version": JAR_SCHEMA_VERSION,
            "cookies": normalised,
            "saved_at": saved_at.isoformat(),
            "authenticated": bool(self.authenticated),
            "user_agent": self.user_agent,
        }

        directory = self.cookies_path.parent
        directory.mkdir(parents=True, exist_ok=True)

        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{self.cookies_path.name}.", suffix=".tmp", dir=str(directory)
        )
        tmp_path = Path(tmp_name)
        try:
            os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)  # 0600 before any bytes land
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, self.cookies_path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
        # os.replace preserves the temp file's mode, but an existing target that
        # predates this code may have been laxer; assert 0600 either way.
        os.chmod(self.cookies_path, stat.S_IRUSR | stat.S_IWUSR)

        self._cookies = normalised
        log.debug(
            "Saved %d cookies to %s: %s",
            len(normalised),
            self.cookies_path,
            ", ".join(_cookie_names(normalised)),
        )

    def _read_payload(
        self,
    ) -> tuple[list[CookieDict], str | None, bool, datetime | None] | None:
        """Parse the jar file into its four parts.

        Accepts the current envelope, a bare cookie list, and a
        ``{"cookies": {"name": "value"}}`` mapping.

        Returns:
            ``(cookies, user_agent, authenticated, saved_at)``, or None when the
            file is missing, unreadable, corrupt or carries no cookies.
        """
        try:
            raw_text = self.cookies_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as exc:
            log.warning("Could not read cookie jar %s: %s", self.cookies_path, exc)
            return None

        try:
            document = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            log.warning("Cookie jar %s is not valid JSON (%s); treating as absent.", self.cookies_path, exc)
            return None

        user_agent: str | None = None
        authenticated = False
        saved_at: datetime | None = None

        if isinstance(document, list):
            raw_cookies: Any = document
        elif isinstance(document, dict):
            raw_cookies = document.get("cookies")
            ua = document.get("user_agent")
            user_agent = ua if isinstance(ua, str) and ua else None
            authenticated = bool(document.get("authenticated", False))
            saved_at = _parse_iso(document.get("saved_at"))
        else:
            log.warning("Cookie jar %s has an unexpected shape; treating as absent.", self.cookies_path)
            return None

        cookies = _normalise_cookies(raw_cookies, default_domain=self._default_cookie_domain())
        if not cookies:
            log.warning("Cookie jar %s carries no usable cookies; treating as absent.", self.cookies_path)
            return None
        return cookies, user_agent, authenticated, saved_at

    # ------------------------------------------------------------------
    # Freshness
    # ------------------------------------------------------------------

    def is_expired(self, *, max_age_hours: float = 12.0) -> bool:
        """Cheap staleness check run before a batch of requests.

        Considered expired when any of these hold:

        * the jar file does not exist, or contains no cookies;
        * the jar is older than ``max_age_hours`` — age is taken from the later
          of the file's mtime and the envelope's ``saved_at``, whichever makes
          the jar look *older*, so a copied file cannot masquerade as fresh;
        * a cookie the API depends on (:data:`REQUIRED_COOKIES`, plus
          :data:`AUTHENTICATED_COOKIES` for a jar claiming to be logged in) is
          missing, or carries an ``expires`` already in the past.

        Session cookies (``expires <= 0``) are judged purely by jar age.

        Args:
            max_age_hours: Wall-clock age past which the jar is refreshed
                regardless of individual cookie expiry.

        Returns:
            True when the caller should re-bootstrap.
        """
        payload = self._read_payload()
        if payload is None:
            return True
        cookies, _user_agent, authenticated, saved_at = payload

        now = datetime.now(timezone.utc)
        try:
            mtime = datetime.fromtimestamp(self.cookies_path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            return True
        oldest = min(t for t in (mtime, saved_at) if t is not None)
        if now - oldest > timedelta(hours=max_age_hours):
            log.debug("Cookie jar is older than %.1fh; expired.", max_age_hours)
            return True

        missing = self._missing_required(cookies, authenticated=authenticated)
        if missing:
            log.debug("Cookie jar is missing required cookies %s; expired.", ", ".join(missing))
            return True

        required = self._required_names(authenticated)
        now_ts = now.timestamp()
        for cookie in cookies:
            if str(cookie.get("name", "")) not in required:
                continue
            expires = cookie.get("expires")
            if isinstance(expires, (int, float)) and 0 < float(expires) <= now_ts:
                log.debug("Required cookie %r has expired.", cookie.get("name"))
                return True
        return False

    def _required_names(self, authenticated: bool) -> tuple[str, ...]:
        """Cookie names this jar must carry.

        Args:
            authenticated: Whether the jar claims a logged-in session.

        Returns:
            Required names — the anonymous set, plus one authenticated cookie
            when the jar claims to be logged in.
        """
        if authenticated:
            return REQUIRED_COOKIES + AUTHENTICATED_COOKIES[:1]
        return REQUIRED_COOKIES

    def _missing_required(
        self, cookies: list[CookieDict], *, authenticated: bool | None = None
    ) -> list[str]:
        """Which required cookie names are absent from ``cookies``.

        Args:
            cookies: Jar to inspect.
            authenticated: Override the authenticated flag; defaults to
                :attr:`authenticated`.

        Returns:
            Missing names, in the order they are required.
        """
        present = {str(c.get("name", "")) for c in cookies}
        flag = self.authenticated if authenticated is None else authenticated
        return [name for name in self._required_names(flag) if name not in present]

    # ------------------------------------------------------------------
    # Views onto the jar
    # ------------------------------------------------------------------

    def as_cookie_header(self) -> str:
        """Render the cached jar as a single ``Cookie:`` request-header value.

        Convenience for :class:`scraper.client.ShopeeClient`, which injects
        cookies by header rather than by httpx cookie jar so the exact ordering
        Shopee's edge expects is preserved.

        Returns:
            ``"name=value; name=value"``, or an empty string when the jar is empty.
        """
        return "; ".join(f"{name}={value}" for name, value in self._as_mapping(self._jar()).items())

    def csrf_token(self) -> str | None:
        """Extract the ``csrftoken`` cookie value, needed as an ``X-CSRFToken`` header.

        Returns:
            The token, or None when the jar does not carry one.
        """
        for cookie in self._jar():
            if str(cookie.get("name", "")).lower() == "csrftoken":
                value = cookie.get("value")
                return str(value) if value else None
        return None

    def storage_state(self) -> dict[str, Any]:
        """Return the jar wrapped as a Playwright ``storage_state`` dict.

        Lets a future adapter re-open a browser already warm with this session,
        e.g. to render a page the JSON API does not expose.

        Returns:
            ``{"cookies": [...], "origins": []}``.
        """
        return {"cookies": [dict(c) for c in self._jar()], "origins": []}

    def _jar(self) -> list[CookieDict]:
        """Return the in-memory jar, reading from disk once if needed.

        Returns:
            The cached cookie list (possibly empty). Never bootstraps.
        """
        if self._cookies is None:
            return self.load_cookies()
        return self._cookies

    @staticmethod
    def _as_mapping(cookies: list[CookieDict]) -> dict[str, str]:
        """Flatten a jar to ``{name: value}``, last duplicate winning.

        Args:
            cookies: Jar to flatten.

        Returns:
            Ordered mapping of cookie name to value.
        """
        mapping: dict[str, str] = {}
        for cookie in cookies:
            name = str(cookie.get("name", ""))
            if not name:
                continue
            mapping[name] = str(cookie.get("value", ""))
        return mapping

    def _default_cookie_domain(self) -> str:
        """Domain to stamp on cookies that arrive without one.

        Returns:
            ``.<host>`` derived from :attr:`base_url`.
        """
        host = urlparse(self.base_url).hostname or "shopee.co.id"
        return f".{host}"


def _parse_iso(value: object) -> datetime | None:
    """Parse an ISO-8601 timestamp, tolerating junk.

    Args:
        value: Candidate value from the jar envelope.

    Returns:
        A timezone-aware UTC datetime, or None if unparseable.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalise_cookies(raw: object, *, default_domain: str) -> list[CookieDict]:
    """Coerce any supported cookie representation into the canonical list.

    Accepts a list of cookie dicts (Playwright shape) or a flat
    ``{"name": "value"}`` mapping. Entries lacking a name are dropped; entries
    lacking a domain/path/expiry get browser-plausible defaults so the jar can
    round-trip through ``BrowserContext.add_cookies``.

    Args:
        raw: Value to coerce.
        default_domain: Domain to stamp on cookies that carry none.

    Returns:
        A normalised jar, possibly empty. Never raises.
    """
    if isinstance(raw, dict):
        raw = [{"name": key, "value": value} for key, value in raw.items()]
    if not isinstance(raw, list):
        return []

    out: list[CookieDict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        cookie: CookieDict = {
            "name": name,
            "value": str(entry.get("value", "")),
            "domain": str(entry.get("domain") or default_domain),
            "path": str(entry.get("path") or "/"),
        }
        expires = entry.get("expires", -1)
        cookie["expires"] = float(expires) if isinstance(expires, (int, float)) else -1.0
        cookie["httpOnly"] = bool(entry.get("httpOnly", False))
        cookie["secure"] = bool(entry.get("secure", True))
        same_site = entry.get("sameSite")
        cookie["sameSite"] = same_site if same_site in {"Lax", "Strict", "None"} else "Lax"
        out.append(cookie)
    return out
