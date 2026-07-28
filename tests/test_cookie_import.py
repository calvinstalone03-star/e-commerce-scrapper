"""Tests for browser cookie-export parsing and the imported-jar protection.

The protection tests matter more than the parser tests: an imported jar is the
only authenticated Shopee session this project can obtain, and a bootstrap that
quietly replaced it would downgrade every later scrape with nothing visibly
failing.
"""

from __future__ import annotations

import json

import pytest

from scraper.cookie_import import (
    CookieImportError,
    filter_domain,
    parse_cookies,
    summarize,
)
from scraper.session import SOURCE_BROWSER, SOURCE_IMPORT, ShopeeSession


# ----------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------

NETSCAPE = "\n".join(
    [
        "# Netscape HTTP Cookie File",
        "# This is a generated file!  Do not edit.",
        ".shopee.co.id\tTRUE\t/\tTRUE\t1799999999\tSPC_EC\tsession-token-value",
        "#HttpOnly_.shopee.co.id\tTRUE\t/\tTRUE\t1799999999\tSPC_ST\tstate-token-value",
        ".shopee.co.id\tTRUE\t/\tFALSE\t0\tcsrftoken\tcsrf-value",
        ".doubleclick.net\tTRUE\t/\tTRUE\t1799999999\ttest_cookie\tad-value",
        "",
    ]
)

COOKIE_EDITOR = json.dumps(
    [
        {
            "name": "SPC_EC",
            "value": "session-token-value",
            "domain": ".shopee.co.id",
            "path": "/",
            "expirationDate": 1799999999.5,
            "httpOnly": True,
            "secure": True,
            "sameSite": "no_restriction",
        },
        {
            "name": "csrftoken",
            "value": "csrf-value",
            "domain": "shopee.co.id",
            "sameSite": "lax",
        },
        {"name": "_ga", "value": "ga-value", "domain": ".google-analytics.com"},
    ]
)


def test_parses_netscape_including_httponly_prefix() -> None:
    cookies, fmt, ua = parse_cookies(NETSCAPE)

    assert fmt == "netscape"
    assert ua is None
    by_name = {cookie["name"]: cookie for cookie in cookies}
    assert set(by_name) == {"SPC_EC", "SPC_ST", "csrftoken", "test_cookie"}
    # The #HttpOnly_ row is a cookie, not a comment, and keeps the flag.
    assert by_name["SPC_ST"]["httpOnly"] is True
    assert by_name["SPC_ST"]["domain"] == ".shopee.co.id"
    assert by_name["csrftoken"]["secure"] is False
    assert by_name["SPC_EC"]["expires"] == pytest.approx(1799999999)


def test_parses_cookie_editor_json_and_its_field_aliases() -> None:
    cookies, fmt, ua = parse_cookies(COOKIE_EDITOR)

    assert fmt == "json"
    assert ua is None
    by_name = {cookie["name"]: cookie for cookie in cookies}
    # expirationDate is Cookie-Editor's spelling of expires.
    assert by_name["SPC_EC"]["expires"] == pytest.approx(1799999999.5)
    # Chrome's lowercase sameSite vocabulary maps onto Playwright's.
    assert by_name["SPC_EC"]["sameSite"] == "None"
    assert by_name["csrftoken"]["sameSite"] == "Lax"


def test_parses_playwright_storage_state_and_keeps_its_user_agent() -> None:
    document = json.dumps(
        {
            "cookies": [{"name": "SPC_EC", "value": "v", "domain": ".shopee.co.id"}],
            "user_agent": "Mozilla/5.0 (Macintosh) Chrome/150.0.0.0",
        }
    )

    cookies, fmt, ua = parse_cookies(document)

    assert fmt == "json"
    assert [cookie["name"] for cookie in cookies] == ["SPC_EC"]
    assert ua == "Mozilla/5.0 (Macintosh) Chrome/150.0.0.0"


def test_parses_a_raw_cookie_header_line() -> None:
    cookies, fmt, _ua = parse_cookies("Cookie: SPC_EC=abc; csrftoken=def; SPC_F=ghi")

    assert fmt == "cookie-header"
    assert [cookie["name"] for cookie in cookies] == ["SPC_EC", "csrftoken", "SPC_F"]
    assert cookies[0]["value"] == "abc"


def test_empty_and_unrecognised_exports_raise() -> None:
    with pytest.raises(CookieImportError):
        parse_cookies("   \n  ")
    with pytest.raises(CookieImportError):
        parse_cookies("this is\nplain prose\nwith no cookies")
    with pytest.raises(CookieImportError):
        parse_cookies("{not valid json")


def test_filter_domain_drops_third_parties_but_keeps_domainless_entries() -> None:
    cookies, _fmt, _ua = parse_cookies(NETSCAPE)
    kept = filter_domain(cookies)

    assert {cookie["name"] for cookie in kept} == {"SPC_EC", "SPC_ST", "csrftoken"}

    # A raw header carries no domain; those were copied off a Shopee request by
    # hand, so dropping them would discard the whole import.
    header_cookies, _fmt, _ua = parse_cookies("SPC_EC=abc; csrftoken=def")
    assert len(filter_domain(header_cookies)) == 2


def test_summary_reports_authentication_without_exposing_values() -> None:
    cookies, fmt, _ua = parse_cookies(NETSCAPE)
    kept = filter_domain(cookies)
    summary = summarize(cookies, kept, source_format=fmt)

    assert summary.total == 4
    assert summary.kept == 3
    assert summary.authenticated is True
    assert summary.names == ("SPC_EC", "SPC_ST", "csrftoken")

    rendered = repr(summary)
    for secret in ("session-token-value", "state-token-value", "csrf-value"):
        assert secret not in rendered


def test_summary_without_a_session_cookie_is_not_authenticated() -> None:
    cookies, fmt, _ua = parse_cookies("SPC_F=abc; csrftoken=def")
    summary = summarize(cookies, cookies, source_format=fmt)

    assert summary.authenticated is False


# ----------------------------------------------------------------------
# Import + protection
# ----------------------------------------------------------------------


@pytest.fixture()
def session(tmp_path, monkeypatch) -> ShopeeSession:
    """A session whose jar lives in a temp dir, with no real settings loaded."""
    from scraper.config import Settings

    settings = Settings(
        database_url="postgresql://localhost/unused",
        cookies_path=tmp_path / "cookies.json",
    )
    return ShopeeSession(settings, cookies_path=tmp_path / "cookies.json")


def test_import_marks_the_jar_and_records_the_browser_user_agent(session) -> None:
    cookies, _fmt, _ua = parse_cookies(NETSCAPE)
    stored = session.import_cookies(filter_domain(cookies), user_agent="Chrome/150 real-browser")

    assert len(stored) == 3
    assert session.authenticated is True
    assert session.source == SOURCE_IMPORT
    assert session.user_agent == "Chrome/150 real-browser"

    envelope = json.loads(session.cookies_path.read_text())
    assert envelope["source"] == SOURCE_IMPORT
    assert envelope["authenticated"] is True
    assert envelope["user_agent"] == "Chrome/150 real-browser"


def test_imported_jar_survives_a_forced_bootstrap(session, monkeypatch) -> None:
    """The core protection: bootstrap must not launch a browser over an import.

    Without this, the client's 403 -> forced-rebootstrap path would swap the
    human's logged-in jar for a fresh anonymous one and every later scrape would
    quietly run logged out.
    """
    cookies, _fmt, _ua = parse_cookies(NETSCAPE)
    session.import_cookies(filter_domain(cookies), user_agent="Chrome/150 real-browser")

    def explode(*_args, **_kwargs):
        raise AssertionError("bootstrap launched a browser over an imported jar")

    monkeypatch.setattr(session, "_run_browser_bootstrap", explode)

    returned = session.bootstrap_cookies(force=True)

    assert {cookie["name"] for cookie in returned} == {"SPC_EC", "SPC_ST", "csrftoken"}
    envelope = json.loads(session.cookies_path.read_text())
    assert envelope["source"] == SOURCE_IMPORT
    assert envelope["authenticated"] is True


def test_expired_imported_jar_is_still_protected(session, monkeypatch) -> None:
    cookies, _fmt, _ua = parse_cookies(NETSCAPE)
    session.import_cookies(filter_domain(cookies), user_agent="Chrome/150")

    monkeypatch.setattr(session, "is_expired", lambda **_kwargs: True)
    monkeypatch.setattr(
        session,
        "_run_browser_bootstrap",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("bootstrapped over an import")),
    )

    assert session.bootstrap_cookies() != []


def test_logged_out_import_is_not_protected(session, monkeypatch) -> None:
    """An anonymous import has nothing worth preserving, so bootstrap proceeds."""
    session.import_cookies([{"name": "SPC_F", "value": "v"}], user_agent="Chrome/150")
    assert session.authenticated is False

    minted = [{"name": "SPC_F", "value": "fresh", "domain": ".shopee.co.id", "path": "/"}]
    monkeypatch.setattr(session, "_run_browser_bootstrap", lambda **_kwargs: (minted, False))

    returned = session.bootstrap_cookies(force=True)

    assert returned[0]["value"] == "fresh"


def test_browser_bootstrapped_jar_is_not_marked_as_imported(session, monkeypatch) -> None:
    minted = [{"name": "SPC_F", "value": "v", "domain": ".shopee.co.id", "path": "/"}]
    monkeypatch.setattr(session, "_run_browser_bootstrap", lambda **_kwargs: (minted, False))

    session.bootstrap_cookies(force=True)

    assert json.loads(session.cookies_path.read_text())["source"] == SOURCE_BROWSER


def test_import_rejects_an_empty_jar(session) -> None:
    with pytest.raises(ValueError):
        session.import_cookies([])


def test_loading_rehydrates_the_import_marker(session, tmp_path) -> None:
    cookies, _fmt, _ua = parse_cookies(NETSCAPE)
    session.import_cookies(filter_domain(cookies), user_agent="Chrome/150")

    fresh = ShopeeSession(session.settings, cookies_path=session.cookies_path)
    fresh.load_cookies()

    assert fresh.source == SOURCE_IMPORT
    assert fresh.authenticated is True
    assert fresh.user_agent == "Chrome/150"
