"""Unit tests for :mod:`scraper.session`.

Everything here runs without launching a browser: :func:`scraper.session._sync_playwright`
is monkeypatched with the fake driver below, which implements exactly the slice
of the Playwright sync API that ``ShopeeSession`` touches. The one test that
does drive a real Chromium is marked ``slow`` and skipped unless
``RUN_BROWSER_TESTS=1`` is set.

Settings are supplied as a duck-typed :class:`StubSettings` rather than the real
:class:`scraper.config.Settings`, so these tests stay green regardless of what
state ``scraper/config.py`` is in. One test does exercise the real ``Settings``
and skips itself while that module is still a scaffold.
"""

from __future__ import annotations

import json
import logging
import os
import stat
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import pytest

from scraper import session as session_mod
from scraper.session import (
    AUTHENTICATED_COOKIES,
    DEFAULT_USER_AGENT,
    REQUIRED_COOKIES,
    ChallengeDetected,
    CookieDict,
    ManualLoginTimeout,
    ShopeeSession,
)

# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


@dataclass
class StubSettings:
    """Minimal stand-in for :class:`scraper.config.Settings`.

    Only the four attributes ``ShopeeSession`` reads are modelled. Using a stub
    keeps this suite independent of the (concurrently written) real Settings.
    """

    cookies_path: Path
    headless: bool = True
    shopee_username: str | None = None
    shopee_password: str | None = None
    min_delay: float = 0.0
    max_delay: float = 0.0

    @property
    def has_credentials(self) -> bool:
        """True only when both credentials are non-empty."""
        return bool(self.shopee_username and self.shopee_password)


def cookie(
    name: str,
    value: str = "v",
    *,
    expires: float = -1,
    domain: str = ".shopee.co.id",
) -> CookieDict:
    """Build one cookie dict in Playwright shape."""
    return {
        "name": name,
        "value": value,
        "domain": domain,
        "path": "/",
        "expires": expires,
        "httpOnly": False,
        "secure": True,
        "sameSite": "Lax",
    }


def anonymous_jar() -> list[CookieDict]:
    """A jar carrying everything an anonymous session needs, plus extras."""
    return [
        cookie("SPC_F", "spc-f-secret"),
        cookie("csrftoken", "csrf-secret"),
        cookie("SPC_SI", "spc-si-secret"),
        cookie("SPC_SEC_SI", "spc-sec-si-secret"),
    ]


class FakeMouse:
    """Records wheel gestures."""

    def __init__(self) -> None:
        self.wheels: list[tuple[int, int]] = []

    def wheel(self, delta_x: int, delta_y: int) -> None:
        self.wheels.append((delta_x, delta_y))


class FakePage:
    """The handful of page methods ``ShopeeSession`` calls."""

    def __init__(
        self,
        context: "FakeContext",
        *,
        goto_redirect: Callable[[str], str] | None = None,
        selectors: tuple[str, ...] = (),
        on_click: Callable[["FakePage"], None] | None = None,
        on_pause: Callable[["FakePage", int], None] | None = None,
    ) -> None:
        self.context = context
        self.url = ""
        self.mouse = FakeMouse()
        self.goto_calls: list[str] = []
        self.load_states: list[str] = []
        self.pauses: list[int] = []
        self.filled: list[tuple[str, str]] = []
        self.clicked: list[str] = []
        self._goto_redirect = goto_redirect
        self._selectors = selectors
        self._on_click = on_click
        self._on_pause = on_pause

    def goto(self, url: str, **_kwargs: Any) -> None:
        self.goto_calls.append(url)
        self.url = self._goto_redirect(url) if self._goto_redirect else url

    def wait_for_load_state(self, state: str, **_kwargs: Any) -> None:
        self.load_states.append(state)

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.pauses.append(milliseconds)
        if self._on_pause:
            self._on_pause(self, milliseconds)

    def wait_for_selector(self, selector: str, **_kwargs: Any) -> object:
        if selector in self._selectors:
            return object()
        raise RuntimeError(f"no such selector: {selector}")

    def fill(self, selector: str, value: str) -> None:
        self.filled.append((selector, value))

    def click(self, selector: str) -> None:
        self.clicked.append(selector)
        if self._on_click:
            self._on_click(self)


class FakeContext:
    """Browser context holding a mutable cookie list."""

    def __init__(self, cookies: list[CookieDict], page_kwargs: dict[str, Any]) -> None:
        self._cookies = list(cookies)
        self._page_kwargs = page_kwargs
        self.page: FakePage | None = None

    def cookies(self) -> list[CookieDict]:
        return list(self._cookies)

    def add(self, extra: CookieDict) -> None:
        self._cookies.append(extra)

    def new_page(self) -> FakePage:
        self.page = FakePage(self, **self._page_kwargs)
        return self.page


class FakeBrowser:
    """Browser that hands out one context and records closure."""

    def __init__(self, cookies: list[CookieDict], page_kwargs: dict[str, Any]) -> None:
        self.closed = False
        self.context_kwargs: dict[str, Any] = {}
        self.context = FakeContext(cookies, page_kwargs)

    def new_context(self, **kwargs: Any) -> FakeContext:
        self.context_kwargs = kwargs
        return self.context

    def close(self) -> None:
        self.closed = True


class FakeChromium:
    """Chromium launcher; can be told to fail like a missing binary."""

    def __init__(self, browser: FakeBrowser, launch_error: Exception | None) -> None:
        self.browser = browser
        self.launch_kwargs: dict[str, Any] = {}
        self._launch_error = launch_error

    def launch(self, **kwargs: Any) -> FakeBrowser:
        self.launch_kwargs = kwargs
        if self._launch_error is not None:
            raise self._launch_error
        return self.browser


@dataclass
class FakePlaywright:
    """Driver handle exposing only ``.chromium``."""

    chromium: FakeChromium
    entered: int = 0
    exited: int = 0
    _browser: FakeBrowser | None = field(default=None, repr=False)

    def __enter__(self) -> "FakePlaywright":
        self.entered += 1
        return self

    def __exit__(self, *_exc: Any) -> bool:
        self.exited += 1
        return False


def install_fake_playwright(
    monkeypatch: pytest.MonkeyPatch,
    *,
    cookies: list[CookieDict] | None = None,
    launch_error: Exception | None = None,
    goto_redirect: Callable[[str], str] | None = None,
    selectors: tuple[str, ...] = (),
    on_click: Callable[[FakePage], None] | None = None,
    on_pause: Callable[[FakePage, int], None] | None = None,
) -> FakePlaywright:
    """Patch ``_sync_playwright`` with a fake driver and return it."""
    browser = FakeBrowser(
        anonymous_jar() if cookies is None else cookies,
        {
            "goto_redirect": goto_redirect,
            "selectors": selectors,
            "on_click": on_click,
            "on_pause": on_pause,
        },
    )
    driver = FakePlaywright(FakeChromium(browser, launch_error), _browser=browser)
    monkeypatch.setattr(session_mod, "_sync_playwright", lambda: driver)
    return driver


def forbid_playwright(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any browser launch an immediate test failure."""

    def _boom() -> Any:
        raise AssertionError("a browser was launched when it should not have been")

    monkeypatch.setattr(session_mod, "_sync_playwright", _boom)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def jar_path(tmp_path: Path) -> Path:
    """Path to a cookie jar inside an isolated temp directory."""
    return tmp_path / "cookies.json"


@pytest.fixture
def settings(jar_path: Path) -> StubSettings:
    """Logged-out settings pointing at the temp jar."""
    return StubSettings(cookies_path=jar_path)


@pytest.fixture
def sess(settings: StubSettings) -> ShopeeSession:
    """A session wired to the temp jar."""
    return ShopeeSession(settings)  # type: ignore[arg-type]


def age_jar(path: Path, hours: float) -> None:
    """Backdate a jar's mtime by ``hours``."""
    old = datetime.now(timezone.utc) - timedelta(hours=hours)
    os.utime(path, (old.timestamp(), old.timestamp()))


# ---------------------------------------------------------------------------
# Persistence: save / load roundtrip
# ---------------------------------------------------------------------------


def test_save_load_roundtrip_preserves_every_cookie_field(sess: ShopeeSession) -> None:
    jar = anonymous_jar()
    sess.save_cookies(jar)

    fresh = ShopeeSession(sess.settings)
    loaded = fresh.load_cookies()

    assert [c["name"] for c in loaded] == [c["name"] for c in jar]
    assert [c["value"] for c in loaded] == [c["value"] for c in jar]
    assert all(c["domain"] == ".shopee.co.id" and c["path"] == "/" for c in loaded)
    assert all(c["expires"] == -1 for c in loaded)


def test_saved_envelope_carries_ua_saved_at_and_auth_flag(sess: ShopeeSession) -> None:
    sess.user_agent = "UA/test 1.0"
    sess.authenticated = True
    sess.save_cookies(anonymous_jar())

    document = json.loads(sess.cookies_path.read_text(encoding="utf-8"))
    assert document["user_agent"] == "UA/test 1.0"
    assert document["authenticated"] is True
    assert isinstance(document["cookies"], list)
    assert datetime.fromisoformat(document["saved_at"]).tzinfo is not None


def test_load_rehydrates_user_agent_so_client_sends_the_browsers_ua(sess: ShopeeSession) -> None:
    """The UA is the whole point of the envelope — a mismatch is an instant 403."""
    sess.user_agent = "Mozilla/5.0 (Macintosh) Chrome/999.0.0.0 Safari/537.36"
    sess.save_cookies(anonymous_jar())

    fresh = ShopeeSession(sess.settings)
    assert fresh.user_agent == DEFAULT_USER_AGENT  # before load
    fresh.load_cookies()
    assert fresh.user_agent == "Mozilla/5.0 (Macintosh) Chrome/999.0.0.0 Safari/537.36"


def test_load_rehydrates_authenticated_flag(sess: ShopeeSession) -> None:
    sess.authenticated = True
    sess.save_cookies(anonymous_jar() + [cookie("SPC_EC", "ec")])

    fresh = ShopeeSession(sess.settings)
    fresh.load_cookies()
    assert fresh.authenticated is True


def test_load_missing_file_returns_empty_list(sess: ShopeeSession) -> None:
    assert not sess.cookies_path.exists()
    assert sess.load_cookies() == []


def test_load_corrupt_json_is_treated_as_no_jar(sess: ShopeeSession) -> None:
    sess.cookies_path.write_text("{not json at all", encoding="utf-8")
    assert sess.load_cookies() == []


def test_load_wrong_shape_is_treated_as_no_jar(sess: ShopeeSession) -> None:
    sess.cookies_path.write_text('"just a string"', encoding="utf-8")
    assert sess.load_cookies() == []


def test_load_accepts_legacy_bare_list_format(sess: ShopeeSession) -> None:
    sess.cookies_path.write_text(json.dumps(anonymous_jar()), encoding="utf-8")
    loaded = sess.load_cookies()
    assert [c["name"] for c in loaded] == ["SPC_F", "csrftoken", "SPC_SI", "SPC_SEC_SI"]


def test_load_accepts_name_value_mapping_format(sess: ShopeeSession) -> None:
    sess.cookies_path.write_text(
        json.dumps({"cookies": {"SPC_F": "a", "csrftoken": "b"}}), encoding="utf-8"
    )
    loaded = sess.load_cookies()
    assert [(c["name"], c["value"]) for c in loaded] == [("SPC_F", "a"), ("csrftoken", "b")]
    assert all(c["domain"] == ".shopee.co.id" for c in loaded)


def test_save_creates_missing_parent_directories(tmp_path: Path) -> None:
    nested = tmp_path / "deep" / "deeper" / "cookies.json"
    sess = ShopeeSession(StubSettings(cookies_path=nested))  # type: ignore[arg-type]
    sess.save_cookies(anonymous_jar())
    assert nested.exists()


def test_save_leaves_no_temp_files_behind(sess: ShopeeSession, tmp_path: Path) -> None:
    sess.save_cookies(anonymous_jar())
    sess.save_cookies(anonymous_jar())
    assert [p.name for p in tmp_path.iterdir()] == ["cookies.json"]


def test_save_overwrites_previous_jar(sess: ShopeeSession) -> None:
    sess.save_cookies([cookie("SPC_F", "one")])
    sess.save_cookies([cookie("SPC_F", "two")])
    assert sess.load_cookies() == [cookie("SPC_F", "two")]


# ---------------------------------------------------------------------------
# Persistence: file permissions
# ---------------------------------------------------------------------------


def test_cookie_file_is_written_0600(sess: ShopeeSession) -> None:
    sess.save_cookies(anonymous_jar())
    assert stat.S_IMODE(sess.cookies_path.stat().st_mode) == 0o600


def test_cookie_file_permissions_are_tightened_on_rewrite(sess: ShopeeSession) -> None:
    sess.cookies_path.write_text("[]", encoding="utf-8")
    os.chmod(sess.cookies_path, 0o644)
    sess.save_cookies(anonymous_jar())
    assert stat.S_IMODE(sess.cookies_path.stat().st_mode) == 0o600


# ---------------------------------------------------------------------------
# Freshness
# ---------------------------------------------------------------------------


def test_is_expired_when_file_absent(sess: ShopeeSession) -> None:
    assert sess.is_expired() is True


def test_is_expired_when_jar_is_empty(sess: ShopeeSession) -> None:
    sess.cookies_path.write_text(json.dumps({"cookies": []}), encoding="utf-8")
    assert sess.is_expired() is True


def test_fresh_anonymous_jar_is_not_expired(sess: ShopeeSession) -> None:
    sess.save_cookies(anonymous_jar())
    assert sess.is_expired() is False


def test_is_expired_by_file_mtime(sess: ShopeeSession) -> None:
    sess.save_cookies(anonymous_jar())
    age_jar(sess.cookies_path, hours=13)
    assert sess.is_expired() is True
    assert sess.is_expired(max_age_hours=24) is False


def test_is_expired_by_saved_at_even_when_mtime_is_fresh(sess: ShopeeSession) -> None:
    """A copied jar has a brand-new mtime; saved_at is what catches it."""
    stale = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
    sess.cookies_path.write_text(
        json.dumps({"cookies": anonymous_jar(), "saved_at": stale}), encoding="utf-8"
    )
    assert sess.is_expired() is True


def test_session_cookies_are_judged_only_by_age(sess: ShopeeSession) -> None:
    """expires == -1 must never be read as 'expired in 1969'."""
    sess.save_cookies([cookie("SPC_F", expires=-1), cookie("csrftoken", expires=-1)])
    assert sess.is_expired() is False


@pytest.mark.parametrize("missing", REQUIRED_COOKIES)
def test_is_expired_when_a_required_cookie_is_missing(sess: ShopeeSession, missing: str) -> None:
    sess.save_cookies([c for c in anonymous_jar() if c["name"] != missing])
    assert sess.is_expired() is True


def test_is_expired_when_a_required_cookie_already_expired(sess: ShopeeSession) -> None:
    past = (datetime.now(timezone.utc) - timedelta(days=1)).timestamp()
    sess.save_cookies([cookie("SPC_F", expires=past), cookie("csrftoken")])
    assert sess.is_expired() is True


def test_future_expiry_is_not_expired(sess: ShopeeSession) -> None:
    future = (datetime.now(timezone.utc) + timedelta(days=7)).timestamp()
    sess.save_cookies([cookie("SPC_F", expires=future), cookie("csrftoken")])
    assert sess.is_expired() is False


def test_anonymous_jar_does_not_require_login_only_cookies(sess: ShopeeSession) -> None:
    """SPC_EC only exists after a login; requiring it would loop the bootstrap."""
    jar = anonymous_jar()
    assert not any(c["name"] in AUTHENTICATED_COOKIES for c in jar)
    sess.save_cookies(jar)
    assert sess.is_expired() is False


def test_authenticated_jar_missing_its_login_cookie_is_expired(sess: ShopeeSession) -> None:
    sess.authenticated = True
    sess.save_cookies(anonymous_jar())  # claims auth but carries no SPC_EC
    assert sess.is_expired() is True


# ---------------------------------------------------------------------------
# Views onto the jar
# ---------------------------------------------------------------------------


def test_as_cookie_header_formats_pairs(sess: ShopeeSession) -> None:
    sess.save_cookies([cookie("SPC_F", "a"), cookie("csrftoken", "b")])
    assert sess.as_cookie_header() == "SPC_F=a; csrftoken=b"


def test_as_cookie_header_empty_when_no_jar(sess: ShopeeSession) -> None:
    assert sess.as_cookie_header() == ""


def test_as_cookie_header_reads_from_disk_lazily(sess: ShopeeSession) -> None:
    sess.save_cookies([cookie("SPC_F", "a")])
    other = ShopeeSession(sess.settings)
    assert other.as_cookie_header() == "SPC_F=a"


def test_csrf_token_found_and_absent(sess: ShopeeSession) -> None:
    sess.save_cookies([cookie("csrftoken", "tok-123"), cookie("SPC_F", "a")])
    assert sess.csrf_token() == "tok-123"

    sess.save_cookies([cookie("SPC_F", "a")])
    assert sess.csrf_token() is None


def test_storage_state_shape(sess: ShopeeSession) -> None:
    sess.save_cookies(anonymous_jar())
    state = sess.storage_state()
    assert set(state) == {"cookies", "origins"}
    assert state["origins"] == []
    assert [c["name"] for c in state["cookies"]] == [c["name"] for c in anonymous_jar()]


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


def test_bootstrap_reuses_valid_jar_without_launching_a_browser(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    sess.save_cookies(anonymous_jar())
    forbid_playwright(monkeypatch)
    assert [c["name"] for c in sess.bootstrap_cookies()] == [c["name"] for c in anonymous_jar()]


def test_bootstrap_force_relaunches_even_with_a_valid_jar(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    sess.save_cookies(anonymous_jar())
    driver = install_fake_playwright(monkeypatch, cookies=[cookie("SPC_F", "new"), cookie("csrftoken", "new")])
    jar = sess.bootstrap_cookies(force=True)
    assert driver.chromium.launch_kwargs != {}
    assert [c["value"] for c in jar] == ["new", "new"]


def test_bootstrap_mints_and_persists_a_jar(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(monkeypatch)
    jar = sess.bootstrap_cookies()
    assert [c["name"] for c in jar] == ["SPC_F", "csrftoken", "SPC_SI", "SPC_SEC_SI"]
    assert sess.cookies_path.exists()
    assert stat.S_IMODE(sess.cookies_path.stat().st_mode) == 0o600
    assert ShopeeSession(sess.settings).load_cookies() == jar


def test_bootstrap_uses_indonesian_browser_identity(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_fake_playwright(monkeypatch)
    sess.bootstrap_cookies()

    kwargs = driver.chromium.browser.context_kwargs
    assert kwargs["locale"] == "id-ID"
    assert kwargs["timezone_id"] == "Asia/Jakarta"
    assert kwargs["user_agent"] == DEFAULT_USER_AGENT
    assert kwargs["viewport"]["width"] > 1000 and kwargs["viewport"]["height"] > 600
    assert kwargs["extra_http_headers"]["Accept-Language"].startswith("id-ID")
    assert driver.chromium.launch_kwargs["headless"] is True


def test_bootstrap_persists_the_ua_the_browser_ran_with(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    custom = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0.0.0 Safari/537.36"
    sess = ShopeeSession(settings, user_agent=custom)  # type: ignore[arg-type]
    driver = install_fake_playwright(monkeypatch)
    sess.bootstrap_cookies()

    assert driver.chromium.browser.context_kwargs["user_agent"] == custom
    assert json.loads(sess.cookies_path.read_text(encoding="utf-8"))["user_agent"] == custom

    # A separate process (the httpx client) picks the same UA back up off disk.
    reader = ShopeeSession(settings)  # type: ignore[arg-type]
    assert reader.user_agent == DEFAULT_USER_AGENT
    reader.load_cookies()
    assert reader.user_agent == custom


def test_bootstrap_headless_flag_follows_settings(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.headless = False
    sess = ShopeeSession(settings)  # type: ignore[arg-type]
    driver = install_fake_playwright(monkeypatch)
    sess.bootstrap_cookies()
    assert driver.chromium.launch_kwargs["headless"] is False


def test_bootstrap_warms_the_page_before_harvesting(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_fake_playwright(monkeypatch)
    sess.bootstrap_cookies()

    page = driver.chromium.browser.context.page
    assert page is not None
    assert page.goto_calls == ["https://shopee.co.id"]
    assert "networkidle" in page.load_states
    assert len(page.mouse.wheels) >= 1, "a human-ish scroll should happen"
    assert page.pauses, "the bootstrap should pause after scrolling"


def test_bootstrap_closes_the_browser_even_on_failure(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_fake_playwright(monkeypatch, cookies=[])
    with pytest.raises(RuntimeError):
        sess.bootstrap_cookies()
    assert driver.chromium.browser.closed is True


def test_bootstrap_raises_runtime_error_when_no_cookies_are_harvested(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(monkeypatch, cookies=[])
    with pytest.raises(RuntimeError, match="no cookies"):
        sess.bootstrap_cookies()
    assert not sess.cookies_path.exists()


def test_bootstrap_raises_runtime_error_when_chromium_is_missing(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(monkeypatch, launch_error=Exception("Executable doesn't exist"))
    with pytest.raises(RuntimeError, match="playwright install chromium"):
        sess.bootstrap_cookies()


def test_bootstrap_warns_but_returns_when_required_cookies_are_absent(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    install_fake_playwright(monkeypatch, cookies=[cookie("SPC_SI", "only-this-one")])
    with caplog.at_level(logging.WARNING, logger="scraper.session"):
        jar = sess.bootstrap_cookies()
    assert [c["name"] for c in jar] == ["SPC_SI"]
    assert "missing expected names" in caplog.text


# ---------------------------------------------------------------------------
# Challenge handling
# ---------------------------------------------------------------------------


def test_challenge_on_landing_page_raises_with_headless_guidance(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(
        monkeypatch,
        goto_redirect=lambda _url: "https://shopee.co.id/verify/traffic/error?type=4",
    )
    with pytest.raises(ChallengeDetected) as excinfo:
        sess.bootstrap_cookies()

    message = str(excinfo.value)
    assert "HEADLESS=false" in message
    assert "/verify/traffic/error" in excinfo.value.url  # type: ignore[operator]
    assert not sess.cookies_path.exists(), "a challenged run must not persist a partial jar"


def test_headful_run_waits_for_a_human_to_clear_the_challenge(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.headless = False
    sess = ShopeeSession(settings)  # type: ignore[arg-type]

    def clear_after_two_pauses(page: FakePage, _ms: int) -> None:
        if len(page.pauses) >= 2 and "/verify/" in page.url:
            page.url = "https://shopee.co.id/"

    install_fake_playwright(
        monkeypatch,
        goto_redirect=lambda _url: "https://shopee.co.id/verify/traffic/error?type=4",
        on_pause=clear_after_two_pauses,
    )
    jar = sess.bootstrap_cookies()
    assert [c["name"] for c in jar] == ["SPC_F", "csrftoken", "SPC_SI", "SPC_SEC_SI"]


def test_challenge_detected_is_not_swallowed_as_a_generic_runtime_error(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(
        monkeypatch, goto_redirect=lambda _url: "https://shopee.co.id/verify/captcha"
    )
    with pytest.raises(ChallengeDetected):
        sess.bootstrap_cookies()


# ---------------------------------------------------------------------------
# Login: opt-in, and always degrades gracefully
# ---------------------------------------------------------------------------


def test_no_credentials_means_no_login_attempt(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_fake_playwright(monkeypatch)
    jar = sess.bootstrap_cookies()

    page = driver.chromium.browser.context.page
    assert page is not None
    assert page.goto_calls == ["https://shopee.co.id"], "must not visit the login page"
    assert page.filled == []
    assert sess.authenticated is False
    assert json.loads(sess.cookies_path.read_text(encoding="utf-8"))["authenticated"] is False
    assert jar


def test_login_true_without_credentials_raises_value_error(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    forbid_playwright(monkeypatch)
    with pytest.raises(ValueError, match="SHOPEE_USERNAME"):
        sess.bootstrap_cookies(login=True)


def test_login_false_stays_anonymous_even_with_credentials(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]
    driver = install_fake_playwright(monkeypatch)

    sess.bootstrap_cookies(login=False)
    page = driver.chromium.browser.context.page
    assert page is not None
    assert page.filled == []
    assert sess.authenticated is False


def test_login_success_marks_the_session_authenticated(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]

    def succeed(page: FakePage) -> None:
        page.context.add(cookie("SPC_EC", "logged-in-secret"))
        page.url = "https://shopee.co.id/"

    driver = install_fake_playwright(
        monkeypatch,
        selectors=('input[name="loginKey"]', 'input[name="password"]', 'button:has-text("Log In")'),
        on_click=succeed,
    )
    jar = sess.bootstrap_cookies()

    page = driver.chromium.browser.context.page
    assert page is not None
    assert page.goto_calls[-1] == "https://shopee.co.id/buyer/login"
    assert [value for _sel, value in page.filled] == ["buyer@example.com", "hunter2-do-not-log"]
    assert sess.authenticated is True
    assert any(c["name"] == "SPC_EC" for c in jar)
    assert json.loads(sess.cookies_path.read_text(encoding="utf-8"))["authenticated"] is True


def test_login_failure_degrades_to_the_logged_out_jar(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """No SPC_EC appears after submit — we keep the anonymous cookies and warn."""
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]
    install_fake_playwright(
        monkeypatch,
        selectors=('input[name="loginKey"]', 'input[name="password"]', 'button:has-text("Log In")'),
    )

    with caplog.at_level(logging.WARNING, logger="scraper.session"):
        jar = sess.bootstrap_cookies()

    assert sess.authenticated is False
    assert [c["name"] for c in jar] == ["SPC_F", "csrftoken", "SPC_SI", "SPC_SEC_SI"]
    assert "keeping the logged-out jar" in caplog.text


def test_missing_login_form_degrades_instead_of_crashing(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]
    install_fake_playwright(monkeypatch, selectors=())  # no selectors resolve

    with caplog.at_level(logging.WARNING, logger="scraper.session"):
        jar = sess.bootstrap_cookies()

    assert sess.authenticated is False
    assert jar
    assert "Login form not found" in caplog.text


def test_login_captcha_degrades_instead_of_raising(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]

    def challenge(page: FakePage) -> None:
        page.url = "https://shopee.co.id/verify/captcha"

    install_fake_playwright(
        monkeypatch,
        selectors=('input[name="loginKey"]', 'input[name="password"]', 'button:has-text("Log In")'),
        on_click=challenge,
    )
    with caplog.at_level(logging.WARNING, logger="scraper.session"):
        jar = sess.bootstrap_cookies()

    assert sess.authenticated is False
    assert jar, "a login CAPTCHA must not cost us the anonymous cookies"
    assert "CAPTCHA/OTP" in caplog.text


def test_login_page_navigation_error_degrades(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]

    def explode_on_login_page(url: str) -> str:
        if "/buyer/login" in url:
            raise RuntimeError("net::ERR_TIMED_OUT")
        return url

    install_fake_playwright(monkeypatch, goto_redirect=explode_on_login_page)
    with caplog.at_level(logging.WARNING, logger="scraper.session"):
        jar = sess.bootstrap_cookies()

    assert sess.authenticated is False
    assert jar
    assert "Login attempt failed" in caplog.text


# ---------------------------------------------------------------------------
# Secret hygiene
# ---------------------------------------------------------------------------


def test_never_logs_cookie_values_or_the_password(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings.shopee_username = "buyer@example.com"
    settings.shopee_password = "hunter2-do-not-log"
    sess = ShopeeSession(settings)  # type: ignore[arg-type]
    install_fake_playwright(
        monkeypatch,
        selectors=('input[name="loginKey"]', 'input[name="password"]', 'button:has-text("Log In")'),
        on_click=lambda page: page.context.add(cookie("SPC_EC", "logged-in-secret")),
    )

    with caplog.at_level(logging.DEBUG, logger="scraper.session"):
        sess.bootstrap_cookies()
        sess.load_cookies()
        sess.is_expired()
        sess.as_cookie_header()

    for secret in (
        "hunter2-do-not-log",
        "spc-f-secret",
        "csrf-secret",
        "spc-si-secret",
        "logged-in-secret",
    ):
        assert secret not in caplog.text

    # ...while still being useful: names and counts are logged.
    assert "SPC_F" in caplog.text and "csrftoken" in caplog.text


# ---------------------------------------------------------------------------
# Convenience accessors
# ---------------------------------------------------------------------------


def test_get_cookies_bootstraps_lazily_when_the_file_is_missing(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(monkeypatch)
    assert not sess.cookies_path.exists()
    mapping = sess.get_cookies()
    assert mapping["SPC_F"] == "spc-f-secret"
    assert sess.cookies_path.exists()


def test_get_cookies_uses_the_cached_jar_when_fresh(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    sess.save_cookies(anonymous_jar())
    forbid_playwright(monkeypatch)
    assert set(sess.get_cookies()) == {"SPC_F", "csrftoken", "SPC_SI", "SPC_SEC_SI"}


def test_get_cookies_rebootstraps_a_stale_jar(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    sess.save_cookies([cookie("SPC_F", "old"), cookie("csrftoken", "old")])
    age_jar(sess.cookies_path, hours=48)
    install_fake_playwright(monkeypatch)
    assert sess.get_cookies()["SPC_F"] == "spc-f-secret"


def test_bootstrap_alias_returns_a_mapping(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_playwright(monkeypatch)
    mapping = sess.bootstrap(force=True)
    assert isinstance(mapping, dict)
    assert mapping["csrftoken"] == "csrf-secret"


# ---------------------------------------------------------------------------
# Manual login — the human types, the tool only harvests
#
# The doubles below are deliberately *stricter* than the bootstrap fakes: the
# page raises on every attribute the production code is not allowed to use, so
# "the form is never touched" is enforced by the mock rather than by review.
# ---------------------------------------------------------------------------


class StrictManualPage:
    """A page that fails the test the instant the login form is touched.

    Only ``goto``, ``wait_for_timeout`` and ``close`` are permitted. Every other
    attribute access — ``fill``, ``click``, ``type``, ``press``, ``locator``,
    ``get_by_label``, ``wait_for_selector``, ``keyboard``, ``evaluate``, anything
    at all — raises, and is also recorded in :attr:`touched` so a test can assert
    on it directly.
    """

    def __init__(
        self,
        context: "ManualContext",
        *,
        on_goto: Callable[["StrictManualPage", str], None] | None = None,
    ) -> None:
        self.context = context
        self.url = ""
        self.goto_calls: list[str] = []
        self.pauses: list[int] = []
        self.touched: list[str] = []
        self.closed = False
        self._on_goto = on_goto

    def goto(self, url: str, **_kwargs: Any) -> None:
        self.goto_calls.append(url)
        self.url = url
        if self._on_goto:
            self._on_goto(self, url)

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.pauses.append(milliseconds)

    def close(self) -> None:
        self.closed = True

    def __getattr__(self, name: str) -> Any:
        # Only reached for attributes not defined above.
        self.__dict__.setdefault("touched", []).append(name)
        raise AssertionError(
            f"the manual login touched page.{name}() — it must never locate, read, "
            "fill, type into, click or submit anything on the login page"
        )


class ManualContext:
    """Context whose jar gains ``SPC_EC`` after ``login_after`` reads."""

    def __init__(
        self,
        *,
        login_after: int = 1,
        cookies_error: BaseException | None = None,
        page_factory: Callable[["ManualContext"], Any] | None = None,
    ) -> None:
        self.reads = 0
        self.login_after = login_after
        self.cookies_error = cookies_error
        self.extra: list[CookieDict] = []
        self.closed = False
        self.page: Any = None
        self._page_factory = page_factory or (lambda ctx: StrictManualPage(ctx))

    def cookies(self) -> list[CookieDict]:
        self.reads += 1
        if self.cookies_error is not None and self.reads > 1:
            raise self.cookies_error
        jar = anonymous_jar() + list(self.extra)
        if self.reads > self.login_after:
            jar.append(cookie("SPC_EC", "logged-in-secret"))
        return jar

    def new_page(self) -> Any:
        self.page = self._page_factory(self)
        return self.page

    def close(self) -> None:
        self.closed = True


class ManualBrowser:
    """Browser handing out one :class:`ManualContext`."""

    def __init__(self, context: ManualContext) -> None:
        self.context = context
        self.context_kwargs: dict[str, Any] = {}
        self.closed = False

    def new_context(self, **kwargs: Any) -> ManualContext:
        self.context_kwargs = kwargs
        return self.context

    def close(self) -> None:
        self.closed = True


def install_manual_playwright(
    monkeypatch: pytest.MonkeyPatch,
    *,
    login_after: int = 1,
    launch_error: Exception | None = None,
    cookies_error: BaseException | None = None,
    page_factory: Callable[[ManualContext], Any] | None = None,
) -> FakePlaywright:
    """Patch ``_sync_playwright`` with the strict manual-login driver."""
    context = ManualContext(
        login_after=login_after, cookies_error=cookies_error, page_factory=page_factory
    )
    browser = ManualBrowser(context)
    driver = FakePlaywright(FakeChromium(browser, launch_error))  # type: ignore[arg-type]
    monkeypatch.setattr(session_mod, "_sync_playwright", lambda: driver)
    return driver


def manual_parts(driver: FakePlaywright) -> tuple[ManualBrowser, ManualContext, Any]:
    """Unpack ``(browser, context, page)`` out of a manual-login driver."""
    browser = driver.chromium.browser  # type: ignore[assignment]
    return browser, browser.context, browser.context.page  # type: ignore[return-value]


def forbid_login_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the credential-driven login path explode if it is ever entered."""

    def _boom(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("manual_login must not use the credential login path")

    monkeypatch.setattr(ShopeeSession, "_attempt_login", _boom)
    monkeypatch.setattr(ShopeeSession, "_first_selector", _boom)


def test_manual_login_forces_a_visible_browser_ignoring_settings(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """HEADLESS=true must not produce an invisible window nobody can type into."""
    settings.headless = True
    sess = ShopeeSession(settings)  # type: ignore[arg-type]
    driver = install_manual_playwright(monkeypatch)

    sess.manual_login(timeout_s=30, poll_s=0.01)

    assert driver.chromium.launch_kwargs["headless"] is False


def test_manual_login_never_touches_the_login_form(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    forbid_login_helpers(monkeypatch)
    driver = install_manual_playwright(monkeypatch, login_after=2)

    sess.manual_login(timeout_s=30, poll_s=0.01)

    _browser, _context, page = manual_parts(driver)
    assert page.touched == [], "no locator/fill/click/type may ever be attempted"
    assert page.goto_calls == [
        "https://shopee.co.id/buyer/login",
        "https://shopee.co.id",
    ], "the only navigations are to the login page and the post-login warm-up"


def executable_source(func: Any) -> str:
    """Return a function's code with docstrings and comments stripped out.

    Lets a test assert on what the code *does* without tripping over a docstring
    that legitimately names the very thing the code must not use.
    """
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or not body:
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            node.body = body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def test_manual_login_code_never_references_the_credential_machinery() -> None:
    """Structural guard: the form constants must not creep back onto this path."""
    code = "\n".join(
        executable_source(func)
        for func in (
            ShopeeSession.manual_login,
            ShopeeSession._run_manual_login_browser,
            ShopeeSession._poll_for_authenticated_jar,
            ShopeeSession._settle_after_manual_login,
            ShopeeSession._close_quietly,
        )
    )
    for forbidden in (
        "USERNAME_SELECTORS",
        "PASSWORD_SELECTORS",
        "SUBMIT_SELECTORS",
        "shopee_password",
        "shopee_username",
        "_attempt_login",
        "_first_selector",
        ".fill(",
        ".click(",
        "wait_for_selector",
        "has_credentials",
    ):
        assert forbidden not in code, f"{forbidden} must not appear in the manual login path"


def test_manual_login_returns_as_soon_as_an_auth_cookie_appears(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_manual_playwright(monkeypatch, login_after=3)

    started = time.monotonic()
    jar = sess.manual_login(timeout_s=60, poll_s=0.01)
    elapsed = time.monotonic() - started

    assert elapsed < 5.0, "polling must return promptly, not sit out the timeout"
    assert any(c["name"] == "SPC_EC" for c in jar)
    _browser, context, _page = manual_parts(driver)
    assert context.reads >= 4


def test_manual_login_persists_through_the_existing_save_path(
    settings: StubSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    custom = "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0 Safari/537.36"
    sess = ShopeeSession(settings, user_agent=custom)  # type: ignore[arg-type]
    install_manual_playwright(monkeypatch)

    jar = sess.manual_login(timeout_s=30, poll_s=0.01)

    document = json.loads(sess.cookies_path.read_text(encoding="utf-8"))
    assert document["authenticated"] is True
    assert document["user_agent"] == custom
    assert [c["name"] for c in document["cookies"]] == [c["name"] for c in jar]
    assert stat.S_IMODE(sess.cookies_path.stat().st_mode) == 0o600
    assert sess.authenticated is True

    reader = ShopeeSession(settings)  # type: ignore[arg-type]
    reader.load_cookies()
    assert reader.authenticated is True
    assert reader.user_agent == custom


def test_manual_login_warms_up_and_reharvests_the_settled_jar(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Shopee tops the jar up on the first authenticated page load."""

    def add_cookie_on_homepage(page: StrictManualPage, url: str) -> None:
        if url.rstrip("/") == "https://shopee.co.id":
            page.context.extra.append(cookie("SPC_ST", "settled-secret"))

    install_manual_playwright(
        monkeypatch,
        page_factory=lambda ctx: StrictManualPage(ctx, on_goto=add_cookie_on_homepage),
    )

    jar = sess.manual_login(timeout_s=30, poll_s=0.01)

    names = [c["name"] for c in jar]
    assert "SPC_EC" in names and "SPC_ST" in names


def test_manual_login_keeps_the_login_jar_when_the_warm_up_fails(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode_on_homepage(_page: StrictManualPage, url: str) -> None:
        if url.rstrip("/") == "https://shopee.co.id":
            raise RuntimeError("net::ERR_CONNECTION_RESET")

    install_manual_playwright(
        monkeypatch,
        page_factory=lambda ctx: StrictManualPage(ctx, on_goto=explode_on_homepage),
    )

    jar = sess.manual_login(timeout_s=30, poll_s=0.01)
    assert any(c["name"] == "SPC_EC" for c in jar)
    assert json.loads(sess.cookies_path.read_text(encoding="utf-8"))["authenticated"] is True


def test_manual_login_timeout_raises_and_keeps_the_existing_good_jar(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    good = anonymous_jar() + [cookie("SPC_EC", "previous-login-secret")]
    sess.authenticated = True
    sess.save_cookies(good)
    before = sess.cookies_path.read_text(encoding="utf-8")

    monkeypatch.setattr(session_mod, "MANUAL_LOGIN_HEARTBEAT_S", 0.0)
    driver = install_manual_playwright(monkeypatch, login_after=10**9)

    with pytest.raises(ManualLoginTimeout) as excinfo:
        sess.manual_login(timeout_s=1, poll_s=0.05)

    message = str(excinfo.value)
    assert "1s" in message and "ecom-scraper login" in message
    assert excinfo.value.timeout_s == 1
    assert sess.cookies_path.read_text(encoding="utf-8") == before, (
        "a timed-out manual login must not touch a jar that already works"
    )
    assert "waiting for you to finish logging in" in capsys.readouterr().out

    browser, context, page = manual_parts(driver)
    assert (browser.closed, context.closed, page.closed) == (True, True, True)


def test_manual_login_timeout_creates_no_jar_at_all_when_none_existed(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_manual_playwright(monkeypatch, login_after=10**9)
    with pytest.raises(ManualLoginTimeout):
        sess.manual_login(timeout_s=1, poll_s=0.05)
    assert not sess.cookies_path.exists()


def test_manual_login_closes_everything_on_an_exception(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode(_page: StrictManualPage, _url: str) -> None:
        raise RuntimeError("net::ERR_NAME_NOT_RESOLVED")

    driver = install_manual_playwright(
        monkeypatch, page_factory=lambda ctx: StrictManualPage(ctx, on_goto=explode)
    )

    with pytest.raises(RuntimeError, match="ERR_NAME_NOT_RESOLVED"):
        sess.manual_login(timeout_s=30, poll_s=0.01)

    browser, context, page = manual_parts(driver)
    assert (browser.closed, context.closed, page.closed) == (True, True, True)
    assert not sess.cookies_path.exists()


def test_manual_login_turns_a_playwright_nav_failure_into_a_clear_runtime_error(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A nav timeout is a plain Exception; it must not escape unwrapped. Regression.

    ``playwright._impl._errors.Error`` (and the TimeoutError subclassing it) is
    neither RuntimeError nor ValueError, so a 45s timeout on the login page broke
    this method's documented Raises contract and surfaced in the CLI as a bare
    traceback instead of the promised message.
    """

    class PlaywrightishError(Exception):
        """Same MRO as playwright's own Error: straight off Exception."""

    def timeout(_page: StrictManualPage, _url: str) -> None:
        raise PlaywrightishError("Page.goto: Timeout 45000ms exceeded.")

    driver = install_manual_playwright(
        monkeypatch, page_factory=lambda ctx: StrictManualPage(ctx, on_goto=timeout)
    )

    with pytest.raises(RuntimeError) as excinfo:
        sess.manual_login(timeout_s=30, poll_s=0.01)

    message = str(excinfo.value)
    assert "https://shopee.co.id/buyer/login" in message
    assert "Timeout 45000ms exceeded" in message
    assert "ecom-scraper login" in message

    browser, context, page = manual_parts(driver)
    assert (browser.closed, context.closed, page.closed) == (True, True, True)
    assert not sess.cookies_path.exists()


def test_manual_login_closes_everything_on_keyboard_interrupt(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ctrl-C is the expected way to abandon this command; it must not leak Chromium."""
    driver = install_manual_playwright(
        monkeypatch, login_after=10**9, cookies_error=KeyboardInterrupt()
    )

    with pytest.raises(KeyboardInterrupt):
        sess.manual_login(timeout_s=30, poll_s=0.01)

    browser, context, page = manual_parts(driver)
    assert (browser.closed, context.closed, page.closed) == (True, True, True)
    assert not sess.cookies_path.exists()


def test_manual_login_reports_a_closed_window_clearly(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_manual_playwright(
        monkeypatch,
        login_after=10**9,
        cookies_error=RuntimeError("Target page, context or browser has been closed"),
    )

    with pytest.raises(RuntimeError, match="browser window closed"):
        sess.manual_login(timeout_s=30, poll_s=0.01)

    browser, _context, _page = manual_parts(driver)
    assert browser.closed is True


def test_manual_login_needs_a_window_and_says_so(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_manual_playwright(
        monkeypatch, launch_error=Exception("Missing X server or $DISPLAY")
    )
    with pytest.raises(RuntimeError) as excinfo:
        sess.manual_login(timeout_s=30, poll_s=0.01)

    message = str(excinfo.value)
    assert "cannot run headless" in message
    assert "playwright install chromium" in message


def test_manual_login_uses_the_indonesian_browser_identity(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    driver = install_manual_playwright(monkeypatch)
    sess.manual_login(timeout_s=30, poll_s=0.01)

    kwargs = driver.chromium.browser.context_kwargs  # type: ignore[union-attr]
    assert kwargs["locale"] == "id-ID"
    assert kwargs["timezone_id"] == "Asia/Jakarta"
    assert kwargs["user_agent"] == DEFAULT_USER_AGENT


@pytest.mark.parametrize(
    ("timeout_s", "poll_s"), [(0, 2.0), (-1, 2.0), (600, 0.0), (600, -0.5)]
)
def test_manual_login_rejects_nonsense_timings_without_a_browser(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch, timeout_s: int, poll_s: float
) -> None:
    forbid_playwright(monkeypatch)
    with pytest.raises(ValueError):
        sess.manual_login(timeout_s=timeout_s, poll_s=poll_s)


def test_manual_login_logs_names_and_counts_but_never_values(
    sess: ShopeeSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    install_manual_playwright(monkeypatch)

    with caplog.at_level(logging.DEBUG, logger="scraper.session"):
        sess.manual_login(timeout_s=30, poll_s=0.01)

    for secret in ("logged-in-secret", "spc-f-secret", "csrf-secret", "spc-si-secret"):
        assert secret not in caplog.text
    assert "SPC_EC" in caplog.text and "csrftoken" in caplog.text


# ---------------------------------------------------------------------------
# Integration with the real Settings (skips while config.py is a stub)
# ---------------------------------------------------------------------------


def test_accepts_the_real_settings_object(tmp_path: Path) -> None:
    from scraper.config import Settings

    try:
        real = Settings(cookies_path=tmp_path / "cookies.json")
        _ = real.has_credentials
        _ = real.cookies_path
    except NotImplementedError:
        pytest.skip("scraper.config.Settings is still a scaffold stub")

    sess = ShopeeSession(real)
    assert sess.cookies_path == Path(tmp_path / "cookies.json")
    sess.save_cookies(anonymous_jar())
    assert sess.is_expired() is False


# ---------------------------------------------------------------------------
# Real browser — opt in with RUN_BROWSER_TESTS=1
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.skipif(
    os.environ.get("RUN_BROWSER_TESTS") != "1",
    reason="launches a real Chromium against shopee.co.id; set RUN_BROWSER_TESTS=1 to run",
)
def test_real_browser_bootstrap_harvests_shopee_cookies(tmp_path: Path) -> None:
    sess = ShopeeSession(StubSettings(cookies_path=tmp_path / "cookies.json"))  # type: ignore[arg-type]
    jar = sess.bootstrap_cookies(force=True)

    names = {c["name"] for c in jar}
    assert "csrftoken" in names
    assert any(name.startswith("SPC_") for name in names)
    assert sess.is_expired() is False
    assert stat.S_IMODE(sess.cookies_path.stat().st_mode) == 0o600
