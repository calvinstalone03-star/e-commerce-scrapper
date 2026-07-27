"""Unit tests for the ``login`` and ``doctor`` commands in :mod:`scraper.cli`.

Nothing here launches a browser or touches the network: ``manual_login`` is
patched on :class:`~scraper.session.ShopeeSession` for the login tests, the HTTP
transport is mocked with respx for the doctor tests, and every test asserts that
``scraper.session._sync_playwright`` was never called.

The two commands under test are the human-in-the-loop half of the tool:

* ``login`` opens a visible browser and waits while the *user* types their own
  credentials. The CLI's job is to explain that before the window opens and to
  report names and counts afterwards — never a cookie value.
* ``doctor`` probes the known endpoints with whatever jar is on disk. Its one
  load-bearing rule is that a verdict comes from the response **envelope**, not
  from the HTTP status: Shopee refuses with ``200 OK`` and a 119-byte
  ``{"error":90309999,...}`` body, so a status-based verdict would report a hard
  block as healthy.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
import respx
from typer.testing import CliRunner

from scraper import cli
from scraper import config as config_mod
from scraper import session as session_mod
from scraper.config import Settings
from scraper.session import ManualLoginTimeout, ShopeeSession

SITE = "https://shopee.co.id"

#: The exact refusal Shopee serves logged-out on search — with HTTP **200**.
BLOCKED_BODY: dict[str, Any] = {
    "is_customized": False,
    "is_login": False,
    "action_type": 2,
    "error": 90309999,
    "tracking_id": "120d5641a03-a941-4207-8b47-0ae160eff05e",
    "redirect_to_error_page": True,
}

SHOP_BODY: dict[str, Any] = {
    "error": 0,
    "error_msg": "",
    "data": {
        "shopid": 30203584,
        "name": "ERIGO Official Shop",
        "account": {"username": "erigostore"},
    },
}
SEO_BODY: dict[str, Any] = {
    "error": 0,
    "error_msg": "",
    "data": {"canonical_url": f"{SITE}/erigostore", "page_title": "Toko Online"},
}
CATEGORIES_BODY: dict[str, Any] = {
    "error": 0,
    "error_msg": "",
    "data": {"shop_categories": [{"shop_category_id": 1}, {"shop_category_id": 2}]},
}
SEARCH_BODY: dict[str, Any] = {
    "error": 0,
    "error_msg": "",
    "total_count": 3,
    "items": [{"itemid": 1}, {"itemid": 2}, {"itemid": 3}],
}

PATHS = {
    "get_shop_base_v2": f"{SITE}/api/v4/shop/get_shop_base_v2",
    "get_shop_detail": f"{SITE}/api/v4/shop/get_shop_detail",
    "get_shop_seo": f"{SITE}/api/v4/shop/get_shop_seo",
    "get_categories": f"{SITE}/api/v4/shop/get_categories",
    "search_items": f"{SITE}/api/v4/search/search_items",
}

ALL_OK = {
    "get_shop_base_v2": SHOP_BODY,
    "get_shop_detail": SHOP_BODY,
    "get_shop_seo": SEO_BODY,
    "get_categories": CATEGORIES_BODY,
    "search_items": SEARCH_BODY,
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def jar_path(tmp_path: Path) -> Path:
    """Cookie jar path inside an isolated temp directory."""
    return tmp_path / "cookies.json"


@pytest.fixture
def settings(jar_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Real Settings pointed at the temp jar, installed as the process settings."""
    built = Settings(cookies_path=jar_path)
    monkeypatch.setattr(config_mod, "get_settings", lambda: built)
    return built


@pytest.fixture(autouse=True)
def no_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neither command may ever launch Chromium by itself."""

    def _boom() -> Any:
        raise AssertionError("a browser was launched when it should not have been")

    monkeypatch.setattr(session_mod, "_sync_playwright", _boom)


@pytest.fixture
def pauses(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Neutralise the inter-probe delay and record how often it was taken."""
    taken: list[float] = []

    def _pause() -> float:
        taken.append(0.0)
        return 0.0

    monkeypatch.setattr(cli, "_pause_between_probes", _pause)
    return taken


def cookie(name: str, value: str = "v") -> dict[str, Any]:
    """One cookie in Playwright shape."""
    return {
        "name": name,
        "value": value,
        "domain": ".shopee.co.id",
        "path": "/",
        "expires": -1,
        "httpOnly": False,
        "secure": True,
        "sameSite": "Lax",
    }


def logged_in_jar() -> list[dict[str, Any]]:
    """A jar that looks like it came out of a successful manual login."""
    return [
        cookie("SPC_F", "spc-f-secret"),
        cookie("csrftoken", "csrf-secret"),
        cookie("SPC_EC", "logged-in-secret"),
        cookie("SPC_ST", "spc-st-secret"),
    ]


def mock_endpoints(bodies: dict[str, Any], *, status: int = 200) -> dict[str, respx.Route]:
    """Register one respx route per probed endpoint.

    Args:
        bodies: Endpoint name -> either a JSON-serialisable body, or an
            ``httpx.Response``/side effect to use verbatim.
        status: Status code for plain-dict bodies.

    Returns:
        The routes, keyed by endpoint name, so a test can inspect the calls.
    """
    routes: dict[str, respx.Route] = {}
    for name, url in PATHS.items():
        method = "POST" if name == "get_shop_base_v2" else "GET"
        body = bodies[name]
        route = respx.request(method, url)
        if isinstance(body, httpx.Response):
            route.mock(return_value=body)
        elif isinstance(body, BaseException) or callable(body):
            route.mock(side_effect=body)
        else:
            route.mock(return_value=httpx.Response(status, json=body))
        routes[name] = route
    return routes


def run_doctor(*args: str) -> Any:
    """Invoke ``ecom-scraper doctor`` with the given extra arguments."""
    return CliRunner().invoke(cli.app, ["doctor", *args])


def flat(text: str) -> str:
    """Collapse whitespace so assertions survive Rich's 80-column wrapping."""
    return " ".join(text.split())


# ---------------------------------------------------------------------------
# login — the human types, the CLI only reports
# ---------------------------------------------------------------------------


def patch_manual_login(
    monkeypatch: pytest.MonkeyPatch, behaviour: Callable[..., Any]
) -> list[dict[str, Any]]:
    """Replace ``ShopeeSession.manual_login`` and record how it was called."""
    calls: list[dict[str, Any]] = []

    def _manual_login(self: ShopeeSession, timeout_s: int = 600, poll_s: float = 2.0) -> Any:
        calls.append({"timeout_s": timeout_s, "poll_s": poll_s})
        return behaviour(self)

    monkeypatch.setattr(ShopeeSession, "manual_login", _manual_login)
    return calls


def test_login_explains_itself_before_opening_the_browser(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The user must know what is about to happen *before* a window appears."""
    printed_before_the_browser: list[str] = []

    def behaviour(_session: ShopeeSession) -> list[dict[str, Any]]:
        import sys

        sys.stdout.flush()
        printed_before_the_browser.append(sys.stdout.buffer.getvalue().decode())
        return logged_in_jar()

    patch_manual_login(monkeypatch, behaviour)
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code == 0, result.output
    assert len(printed_before_the_browser) == 1
    preamble = flat(printed_before_the_browser[0]).lower()
    assert "a real browser window is about to open" in preamble
    assert "you type your own username, password and any otp" in preamble
    assert "never sees, types, saves or logs them" in preamble
    assert "will not touch a captcha" in preamble
    assert "ctrl-c is safe" in preamble


def test_login_reports_counts_and_the_path_but_never_a_cookie_value(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_manual_login(monkeypatch, lambda _s: logged_in_jar())
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code == 0, result.output
    output = flat(result.output)
    assert "cookies captured" in output and "4" in output
    assert "yes" in output
    assert "cookies.json" in output
    assert "SPC_EC" in result.output, "names are useful and safe to print"
    for secret in ("logged-in-secret", "csrf-secret", "spc-f-secret", "spc-st-secret"):
        assert secret not in result.output, "cookie values must never be printed"


def test_login_forwards_the_timeout_and_poll_options(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = patch_manual_login(monkeypatch, lambda _s: logged_in_jar())
    result = CliRunner().invoke(cli.app, ["login", "--timeout", "45", "--poll", "0.5"])

    assert result.exit_code == 0, result.output
    assert calls == [{"timeout_s": 45, "poll_s": 0.5}]


def test_login_reports_a_logged_out_jar_as_not_authenticated(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_manual_login(monkeypatch, lambda _s: [cookie("SPC_F"), cookie("csrftoken")])
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code == 0, result.output
    assert "no (logged out)" in flat(result.output)


def test_login_exits_non_zero_on_timeout(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def timeout(_session: ShopeeSession) -> Any:
        raise ManualLoginTimeout(
            "no Shopee login completed within 600s ... re-run `ecom-scraper login`",
            timeout_s=600,
        )

    patch_manual_login(monkeypatch, timeout)
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code != 0
    assert "600s" in flat(result.output) and "ecom-scraper login" in flat(result.output)


def test_login_exits_non_zero_when_no_window_can_be_opened(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_window(_session: ShopeeSession) -> Any:
        raise RuntimeError("Could not open a visible browser window for the manual login.")

    patch_manual_login(monkeypatch, no_window)
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code == 2
    assert "visible browser window" in flat(result.output)


def test_login_exits_non_zero_when_cancelled(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cancel(_session: ShopeeSession) -> Any:
        raise KeyboardInterrupt

    patch_manual_login(monkeypatch, cancel)
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code == 1
    assert "cancelled" in flat(result.output)


def test_login_reports_a_playwright_failure_instead_of_a_traceback(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A navigation failure must not escape as a stack trace. Regression.

    ``playwright._impl._errors.Error`` — and the TimeoutError that subclasses it,
    which is what a 45s nav timeout on a slow connection raises — is a plain
    Exception: neither RuntimeError nor ValueError. It slipped past all four
    handlers, so the operator got a raw traceback under a banner that had just
    promised the browser is always closed.
    """

    class PlaywrightishError(Exception):
        """Same MRO as playwright's own Error: straight off Exception."""

    def nav_timeout(_session: ShopeeSession) -> Any:
        raise PlaywrightishError("Page.goto: Timeout 45000ms exceeded.")

    patch_manual_login(monkeypatch, nav_timeout)
    result = CliRunner().invoke(cli.app, ["login"])

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit), result.exception
    output = flat(result.output)
    assert "Timeout 45000ms exceeded" in output
    assert "cookie jar is unchanged" in output
    assert "Traceback" not in result.output


def test_login_end_to_end_against_a_fake_browser(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, jar_path: Path
) -> None:
    """The command wired to the real ``manual_login``, browser doubles and all."""
    import stat

    from tests import test_session as doubles

    # Installed after the autouse guard, so this test alone gets a (fake) driver.
    driver = doubles.install_manual_playwright(monkeypatch, login_after=1)

    result = CliRunner().invoke(cli.app, ["login", "--timeout", "30", "--poll", "0.1"])

    assert result.exit_code == 0, result.output
    assert driver.chromium.launch_kwargs["headless"] is False
    _browser, _context, page = doubles.manual_parts(driver)
    assert page.touched == [], "the CLI path must not touch the login form either"

    document = json.loads(jar_path.read_text(encoding="utf-8"))
    assert document["authenticated"] is True
    assert {c["name"] for c in document["cookies"]} >= {"SPC_EC", "SPC_F", "csrftoken"}
    assert stat.S_IMODE(jar_path.stat().st_mode) == 0o600
    assert "logged-in-secret" not in result.output


def test_login_still_accepts_the_global_logging_options(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The -v/-q/--log-file callback must keep working in front of a new command."""
    patch_manual_login(monkeypatch, lambda _s: logged_in_jar())
    log_file = tmp_path / "cli.log"
    result = CliRunner().invoke(cli.app, ["-v", "--log-file", str(log_file), "login"])

    assert result.exit_code == 0, result.output
    assert log_file.exists()


# ---------------------------------------------------------------------------
# doctor — the verdict comes from the envelope, never from the status line
# ---------------------------------------------------------------------------


@respx.mock
def test_doctor_calls_a_200_with_the_antibot_envelope_blocked(
    settings: Settings, pauses: list[float]
) -> None:
    mock_endpoints({name: BLOCKED_BODY for name in PATHS})
    result = run_doctor()

    assert result.exit_code == 0, result.output
    output = flat(result.output)
    assert output.count("BLOCKED") >= 5
    assert "0/5 endpoint(s) usable" in output
    assert "90309999" in output
    assert "anti-bot refusal" in output


@respx.mock
def test_doctor_calls_a_200_with_error_zero_and_data_ok(
    settings: Settings, pauses: list[float]
) -> None:
    mock_endpoints(ALL_OK)
    result = run_doctor()

    assert result.exit_code == 0, result.output
    assert "5/5 endpoint(s) usable" in flat(result.output)
    assert "BLOCKED" not in result.output


@respx.mock
def test_doctor_json_shows_a_200_that_is_still_blocked(
    settings: Settings, pauses: list[float]
) -> None:
    """The status column says 200; the verdict says BLOCKED. That is the point."""
    bodies = dict(ALL_OK)
    bodies["search_items"] = BLOCKED_BODY
    mock_endpoints(bodies)

    result = run_doctor("--json")
    assert result.exit_code == 0, result.output
    document = json.loads(result.output)

    by_name = {probe["endpoint"]: probe for probe in document["probes"]}
    assert list(by_name) == [
        "get_shop_base_v2",
        "get_shop_detail",
        "get_shop_seo",
        "get_categories",
        "search_items",
    ]
    search = by_name["search_items"]
    assert search["http_status"] == 200
    assert search["error"] == 90309999
    assert search["items"] == 0
    assert search["verdict"] == "BLOCKED"

    assert by_name["get_shop_detail"]["verdict"] == "OK"
    assert by_name["get_categories"]["items"] == 2
    assert document["summary"] == {"ok": 4, "empty": 0, "error": 0, "blocked": 1}


@respx.mock
def test_doctor_json_carries_the_jar_summary_without_values(
    settings: Settings, pauses: list[float], jar_path: Path
) -> None:
    ShopeeSession(settings).save_cookies(logged_in_jar())  # type: ignore[arg-type]
    mock_endpoints(ALL_OK)

    result = run_doctor("--json")
    document = json.loads(result.output)

    assert document["jar"]["cookies"] == 4
    assert document["jar"]["authenticated"] is True
    assert "SPC_EC" in document["jar"]["names"]
    assert "logged-in-secret" not in result.output


@respx.mock
def test_doctor_prints_the_reason_under_the_table(
    settings: Settings, pauses: list[float]
) -> None:
    bodies = dict(ALL_OK)
    bodies["search_items"] = BLOCKED_BODY
    mock_endpoints(bodies)

    output = flat(run_doctor().output)
    assert "4/5 endpoint(s) usable" in output
    assert "search_items" in output
    assert "envelope error 90309999" in output


@respx.mock
def test_doctor_calls_a_successful_empty_answer_empty_not_blocked(
    settings: Settings, pauses: list[float]
) -> None:
    """``error: 0`` with an empty list is an answer, not a refusal. Regression.

    ``_judge`` reported BLOCKED whenever the first matching list key was empty,
    which is the exact opposite of the rule the transport enforces. Every one of
    these is a real, healthy shape: a keyword nothing matched, a shop with no
    custom categories, an SEO payload with an empty ``items``. Calling them
    BLOCKED sends an operator to re-run ``login`` and burn a browser bootstrap
    chasing a block that a 200 with ``error: 0`` has already disproved — and
    ``doctor`` is the tool ``login`` tells them to trust.
    """
    bodies = dict(ALL_OK)
    bodies["search_items"] = {"error": 0, "error_msg": "", "items": [], "nomore": True}
    bodies["get_categories"] = {"error": 0, "error_msg": "", "data": {"shop_categories": []}}
    mock_endpoints(bodies)

    result = run_doctor("--json")
    document = json.loads(result.output)
    by_name = {probe["endpoint"]: probe for probe in document["probes"]}

    assert by_name["search_items"]["verdict"] == "EMPTY"
    assert by_name["get_categories"]["verdict"] == "EMPTY"
    assert "not a refusal" in by_name["search_items"]["note"]
    assert document["summary"] == {"ok": 3, "empty": 2, "error": 0, "blocked": 0}


@respx.mock
def test_doctor_does_not_call_a_null_error_envelope_blocked(
    settings: Settings, pauses: list[float]
) -> None:
    """``{"data":[],"error":null,"retcode":0}`` is success. Regression.

    Straight out of ``.recon/browser_capture.json`` #3. ``_judge`` treated a
    missing or null ``error`` as BLOCKED — the very shape ``client.has_v4_error``
    was written to declare *not* an error — so the two layers of the same change
    disagreed about the same body, and any endpoint Shopee migrates to the
    retcode envelope made doctor report a healthy session as blocked.
    """
    bodies = dict(ALL_OK)
    bodies["search_items"] = {"data": [], "error": None, "error_msg": None, "retcode": 0}
    bodies["get_shop_seo"] = {"data": "OK"}
    mock_endpoints(bodies)

    document = json.loads(run_doctor("--json").output)
    by_name = {probe["endpoint"]: probe for probe in document["probes"]}

    assert by_name["search_items"]["verdict"] != "BLOCKED"
    assert by_name["get_shop_seo"]["verdict"] != "BLOCKED"
    assert document["summary"]["blocked"] == 0


@respx.mock
def test_doctor_separates_an_endpoint_error_from_a_block(
    settings: Settings, pauses: list[float]
) -> None:
    """"shop not found" is the endpoint answering, not Shopee refusing."""
    bodies = dict(ALL_OK)
    bodies["get_shop_detail"] = {"error": 4, "error_msg": "shop not found", "data": None}
    mock_endpoints(bodies)

    document = json.loads(run_doctor("--json").output)
    detail = next(p for p in document["probes"] if p["endpoint"] == "get_shop_detail")

    assert detail["verdict"] == "ERROR"
    assert "not a block" in detail["note"]
    assert document["summary"]["blocked"] == 0


@respx.mock
def test_doctor_treats_an_html_interstitial_as_blocked(
    settings: Settings, pauses: list[float]
) -> None:
    bodies = dict(ALL_OK)
    bodies["search_items"] = httpx.Response(
        200, html="<html><body>Masuk Diperlukan</body></html>"
    )
    mock_endpoints(bodies)

    result = run_doctor("--json")
    document = json.loads(result.output)
    search = next(p for p in document["probes"] if p["endpoint"] == "search_items")
    assert search["http_status"] == 200
    assert search["error"] is None
    assert search["verdict"] == "BLOCKED"
    assert "JSON" in search["note"]


@respx.mock
def test_doctor_treats_a_transport_failure_as_blocked(
    settings: Settings, pauses: list[float]
) -> None:
    bodies: dict[str, Any] = dict(ALL_OK)
    bodies["get_shop_seo"] = httpx.ConnectError("connection refused")
    mock_endpoints(bodies)

    result = run_doctor("--json")
    document = json.loads(result.output)
    seo = next(p for p in document["probes"] if p["endpoint"] == "get_shop_seo")
    assert seo["http_status"] is None
    assert seo["verdict"] == "BLOCKED"
    assert "transport failure" in seo["note"]


@respx.mock
def test_doctor_probes_each_endpoint_exactly_once_with_a_gap_between(
    settings: Settings, pauses: list[float]
) -> None:
    routes = mock_endpoints(ALL_OK)
    result = run_doctor()

    assert result.exit_code == 0, result.output
    assert [route.call_count for route in routes.values()] == [1, 1, 1, 1, 1]
    assert len(pauses) == len(routes) - 1, "a gap between probes, but not before the first"


@respx.mock
def test_doctor_sends_the_saved_cookies_and_the_persisted_user_agent(
    settings: Settings, pauses: list[float]
) -> None:
    session = ShopeeSession(settings, user_agent="UA/doctor 1.0")  # type: ignore[arg-type]
    session.authenticated = True
    session.save_cookies(logged_in_jar())

    routes = mock_endpoints(ALL_OK)
    assert run_doctor().exit_code == 0

    request = routes["search_items"].calls[0].request
    assert "SPC_EC=logged-in-secret" in request.headers["cookie"]
    assert request.headers["user-agent"] == "UA/doctor 1.0"
    assert request.headers["x-csrftoken"] == "csrf-secret"
    assert "shopee.co.id/search?keyword=" in request.headers["referer"]


@respx.mock
def test_doctor_posts_the_shop_base_v2_body_and_gets_the_shop_id(
    settings: Settings, pauses: list[float]
) -> None:
    """The id-keyed endpoints follow whatever --username actually resolves to."""
    shop_body = {
        "error": 0,
        "error_msg": "",
        "data": {"shopid": 777, "account": {"username": "someshop"}},
    }
    bodies = dict(ALL_OK)
    bodies["get_shop_base_v2"] = shop_body
    bodies["get_shop_detail"] = shop_body
    routes = mock_endpoints(bodies)

    assert run_doctor("--username", "someshop").exit_code == 0

    posted = json.loads(routes["get_shop_base_v2"].calls[0].request.content)
    assert posted["username"] == "someshop"
    assert posted["request_source"] == "pc_shop_home_page"

    assert "shopid=777" in str(routes["get_shop_seo"].calls[0].request.url)
    assert "shopid=777" in str(routes["get_categories"].calls[0].request.url)


@respx.mock
def test_doctor_uses_the_requested_keyword(settings: Settings, pauses: list[float]) -> None:
    routes = mock_endpoints(ALL_OK)
    assert run_doctor("--keyword", "tas kulit").exit_code == 0

    url = str(routes["search_items"].calls[0].request.url)
    assert "keyword=tas+kulit" in url or "keyword=tas%20kulit" in url


@respx.mock
def test_doctor_warns_when_there_is_no_jar_but_still_probes(
    settings: Settings, pauses: list[float], jar_path: Path
) -> None:
    assert not jar_path.exists()
    routes = mock_endpoints({name: BLOCKED_BODY for name in PATHS})

    result = run_doctor()
    assert result.exit_code == 0, result.output
    assert "no cookies on disk" in flat(result.output)
    assert "ecom-scraper login" in flat(result.output)
    assert all(route.call_count == 1 for route in routes.values())
