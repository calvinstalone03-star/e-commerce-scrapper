"""Unit tests for :mod:`scraper.client`.

The transport is mocked with respx, so nothing here touches shopee.co.id. The
delay is the only genuinely slow part of the client, so every test either zeroes
``min_delay``/``max_delay`` or monkeypatches ``time.sleep`` outright — the suite
must stay sub-second.

Dependencies on sibling modules are deliberately faked (:class:`FakeSession`,
:class:`FakeSettings`) rather than imported: those modules are being written
concurrently, and the client only ever uses a handful of their methods. The
contract exercised here is exactly the one the stubs declare:

* ``ShopeeSession.as_cookie_header() -> str``
* ``ShopeeSession.csrf_token() -> str | None``
* ``ShopeeSession.is_expired() -> bool``
* ``ShopeeSession.bootstrap_cookies(*, force=False) -> list``
* ``Settings.min_delay`` / ``Settings.max_delay``
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import respx

from scraper import client as client_mod
from scraper.client import (
    DEFAULT_HEADERS,
    SHOPEE_API_BASE,
    BlockedError,
    ScraperHTTPError,
    ShopeeClient,
)

BASE = SHOPEE_API_BASE
PATH = "/api/v4/shop/get_shop_detail"
URL = f"{BASE}{PATH}"

COOKIE_VALUE = "SPC_F=SuperSecretCookieValue; csrftoken=CsrfSecret123"
CSRF_TOKEN = "CsrfSecret123"
TEST_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "Chrome/149.0.0.0 Safari/537.36"
)

# A real (trimmed) shop-detail payload, from .recon/B_get_shop_detail.json.
OK_PAYLOAD: dict[str, Any] = {
    "error": 0,
    "error_msg": "",
    "data": {"shopid": 30203584, "name": "ERIGO Official Shop", "item_count": 2456},
}

# The live block envelope, captured verbatim in .recon/A_search_kaos_polos.json.
BLOCK_PAYLOAD: dict[str, Any] = {
    "is_customized": False,
    "is_login": False,
    "action_type": 2,
    "error": 90309999,
    "tracking_id": "120d5641a03-a941-4207-8b47-0ae160eff05e",
    "redirect_to_error_page": True,
}

# The same block, obfuscated under numeric keys, as the SPA receives it.
OBFUSCATED_BLOCK_PAYLOAD: dict[str, Any] = {
    "5": False,
    "2": False,
    "4": 2,
    "0": 3,
    "3": 90309999,
    "1": "7805ebe88b6-7065-402b-8145-43d021b7074d",
    "9": True,
}

INTERSTITIAL_HTML = (
    "<!doctype html><html><head><title>Masuk Diperlukan</title></head>"
    "<body>Sepertinya Anda belum masuk.</body></html>"
)


# ---------------------------------------------------------------------------
# doubles
# ---------------------------------------------------------------------------


@dataclass
class FakeSettings:
    """Stand-in for :class:`scraper.config.Settings` (only the fields used)."""

    min_delay: float = 0.0
    max_delay: float = 0.0


@dataclass
class FakeSession:
    """Stand-in for :class:`scraper.session.ShopeeSession`."""

    cookie_header: str = COOKIE_VALUE
    token: str | None = CSRF_TOKEN
    expired: bool = False
    user_agent: str = TEST_UA
    bootstrap_calls: list[bool] = field(default_factory=list)
    expired_calls: int = 0

    def as_cookie_header(self) -> str:
        return self.cookie_header

    def csrf_token(self) -> str | None:
        return self.token

    def is_expired(self, *, max_age_hours: float = 12.0) -> bool:
        self.expired_calls += 1
        return self.expired

    def bootstrap_cookies(self, *, force: bool = False, login: bool | None = None) -> list[Any]:
        self.bootstrap_calls.append(force)
        return []


def make_client(
    session: FakeSession | None = None,
    settings: FakeSettings | None = None,
    **kwargs: Any,
) -> ShopeeClient:
    """Build a client with retry backoff zeroed so tests never wait."""
    client = ShopeeClient(
        session=session if session is not None else FakeSession(),  # type: ignore[arg-type]
        settings=settings if settings is not None else FakeSettings(),  # type: ignore[arg-type]
        **kwargs,
    )
    client.retry_initial_wait = 0.0
    client.retry_max_wait = 0.0
    client.retry_jitter = 0.0
    return client


def json_response(payload: dict[str, Any], status: int = 200) -> Any:
    """A respx side_effect that builds a fresh response for every call."""

    def _build(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return _build


def html_response(status: int = 200) -> Any:
    """A respx side_effect returning Shopee's login-wall interstitial."""

    def _build(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, html=INTERSTITIAL_HTML)

    return _build


# ---------------------------------------------------------------------------
# delay
# ---------------------------------------------------------------------------


@respx.mock
def test_delay_is_applied_before_the_request(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    uniform_args: list[tuple[float, float]] = []

    def fake_uniform(low: float, high: float) -> float:
        uniform_args.append((low, high))
        return 2.25

    monkeypatch.setattr(client_mod.random, "uniform", fake_uniform)
    monkeypatch.setattr(client_mod.time, "sleep", slept.append)

    respx.get(URL).mock(side_effect=json_response(OK_PAYLOAD))

    client = make_client(settings=FakeSettings(min_delay=1.5, max_delay=3.0))
    with client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert uniform_args == [(1.5, 3.0)], "delay must be drawn from the configured bounds"
    assert slept == [2.25], "exactly one sleep, before the single request"


@respx.mock
def test_delay_is_applied_before_every_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(client_mod.random, "uniform", lambda low, high: 0.5)
    monkeypatch.setattr(client_mod.time, "sleep", slept.append)

    respx.get(URL).mock(
        side_effect=[
            httpx.Response(500, text="boom"),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )

    with make_client() as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    # tenacity's own (zeroed) backoff also calls time.sleep, so the recorded
    # sequence is [our delay, backoff, our delay]. Pick out our 0.5s pacing.
    assert slept[0] == 0.5, "pacing must precede the very first request, not only retries"
    assert [s for s in slept if s == 0.5] == [0.5, 0.5], "every attempt is paced"


@respx.mock
def test_random_delay_returns_the_slept_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_mod.random, "uniform", lambda low, high: 1.75)
    monkeypatch.setattr(client_mod.time, "sleep", lambda seconds: None)

    client = make_client(settings=FakeSettings(min_delay=1.0, max_delay=2.0))
    assert client._random_delay() == pytest.approx(1.75)
    client.close()


# ---------------------------------------------------------------------------
# retry
# ---------------------------------------------------------------------------


@respx.mock
def test_retries_on_500_then_succeeds() -> None:
    route = respx.get(URL).mock(
        side_effect=[
            httpx.Response(500, text="upstream exploded"),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )

    with make_client() as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert route.call_count == 2


@respx.mock
def test_retries_on_transport_error_then_succeeds() -> None:
    route = respx.get(URL).mock(
        side_effect=[
            httpx.ConnectTimeout("connect timed out"),
            httpx.ReadTimeout("read timed out"),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )

    with make_client() as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert route.call_count == 3


@respx.mock
def test_exhausted_5xx_raises_scraper_http_error_not_blocked() -> None:
    route = respx.get(URL).mock(side_effect=lambda request: httpx.Response(503, text="nope"))

    session = FakeSession()
    with make_client(session=session) as client:
        with pytest.raises(ScraperHTTPError) as excinfo:
            client.get_json(PATH)

    assert not isinstance(excinfo.value, BlockedError), "a 5xx is not an anti-bot block"
    assert excinfo.value.status_code == 503
    assert excinfo.value.url == URL
    assert "nope" in (excinfo.value.body_excerpt or "")
    assert route.call_count == 4, "MAX_ATTEMPTS attempts, no more"
    assert session.bootstrap_calls == [], "a 5xx must never re-bootstrap cookies"


@respx.mock
def test_exhausted_transport_error_raises_scraper_http_error() -> None:
    respx.get(URL).mock(side_effect=httpx.ConnectError("dns is down"))

    with make_client() as client:
        with pytest.raises(ScraperHTTPError) as excinfo:
            client.get_json(PATH)

    assert excinfo.value.status_code is None
    assert excinfo.value.url == URL


# ---------------------------------------------------------------------------
# block detection + single re-bootstrap
# ---------------------------------------------------------------------------


@respx.mock
def test_403_triggers_exactly_one_bootstrap_and_replay() -> None:
    route = respx.get(URL).mock(
        side_effect=[
            httpx.Response(403, json=BLOCK_PAYLOAD),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert session.bootstrap_calls == [True], "one forced re-bootstrap, exactly once"
    assert route.call_count == 2, "the request is replayed once, not retried in a loop"


@respx.mock
def test_second_403_raises_blocked_error_after_one_bootstrap() -> None:
    route = respx.get(URL).mock(side_effect=json_response(BLOCK_PAYLOAD, status=403))
    session = FakeSession()

    with make_client(session=session) as client:
        with pytest.raises(BlockedError) as excinfo:
            client.get_json(PATH)

    assert session.bootstrap_calls == [True], "never bootstrap more than once per request"
    assert route.call_count == 2, "one original + one replay, then give up"
    assert excinfo.value.status_code == 403
    assert excinfo.value.url == URL
    assert "90309999" in (excinfo.value.body_excerpt or "")
    assert isinstance(excinfo.value, ScraperHTTPError)


@respx.mock
def test_html_body_with_200_is_treated_as_blocked() -> None:
    route = respx.get(URL).mock(side_effect=html_response())
    session = FakeSession()

    with make_client(session=session) as client:
        with pytest.raises(BlockedError) as excinfo:
            client.get_json(PATH)

    assert session.bootstrap_calls == [True]
    assert route.call_count == 2
    assert excinfo.value.status_code == 200, "a soft block still reports its real status"
    assert "Masuk Diperlukan" in (excinfo.value.body_excerpt or "")


@respx.mock
def test_html_body_recovers_after_rebootstrap() -> None:
    respx.get(URL).mock(
        side_effect=[
            httpx.Response(200, html=INTERSTITIAL_HTML),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert session.bootstrap_calls == [True]


@respx.mock
def test_html_without_content_type_is_treated_as_blocked() -> None:
    respx.get(URL).mock(
        side_effect=lambda request: httpx.Response(
            200, content=INTERSTITIAL_HTML.encode(), headers={"content-type": ""}
        )
    )

    with make_client() as client:
        with pytest.raises(BlockedError):
            client.get_json(PATH)


@respx.mock
def test_429_after_retries_is_treated_as_a_block() -> None:
    route = respx.get(URL).mock(
        side_effect=[
            httpx.Response(429, text="slow down"),
            httpx.Response(429, text="slow down"),
            httpx.Response(429, text="slow down"),
            httpx.Response(429, text="slow down"),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert route.call_count == 5, "4 retried attempts, then one replay after bootstrap"
    assert session.bootstrap_calls == [True]


@respx.mock
def test_json_block_envelope_with_status_200_is_blocked() -> None:
    respx.get(URL).mock(side_effect=json_response(BLOCK_PAYLOAD))
    session = FakeSession()

    with make_client(session=session) as client:
        with pytest.raises(BlockedError) as excinfo:
            client.get_json(PATH)

    assert excinfo.value.status_code == 200
    assert session.bootstrap_calls == [True]


@respx.mock
def test_obfuscated_json_block_envelope_is_blocked() -> None:
    respx.get(URL).mock(side_effect=json_response(OBFUSCATED_BLOCK_PAYLOAD))

    with make_client() as client:
        with pytest.raises(BlockedError):
            client.get_json(PATH)


@respx.mock
def test_error_msg_marker_is_blocked() -> None:
    respx.get(URL).mock(
        side_effect=json_response({"error": 12, "error_msg": "Request was blocked"})
    )

    with make_client() as client:
        with pytest.raises(BlockedError):
            client.get_json(PATH)


@respx.mock
def test_benign_error_envelope_is_returned_unchanged() -> None:
    """A real application error (e.g. shop not found) is the adapter's problem."""
    payload = {"error": 4, "error_msg": "shop not found", "data": None}
    respx.get(URL).mock(side_effect=json_response(payload))
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == payload

    assert session.bootstrap_calls == []


@respx.mock
def test_successful_payload_with_error_zero_is_not_blocked() -> None:
    respx.get(URL).mock(side_effect=json_response(OK_PAYLOAD))
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH)["data"]["shopid"] == 30203584

    assert session.bootstrap_calls == []


@respx.mock
def test_404_is_not_a_block_and_raises_scraper_http_error() -> None:
    respx.get(URL).mock(side_effect=json_response({"error": 4}, status=404))
    session = FakeSession()

    with make_client(session=session) as client:
        with pytest.raises(ScraperHTTPError) as excinfo:
            client.get_json(PATH)

    assert not isinstance(excinfo.value, BlockedError)
    assert excinfo.value.status_code == 404
    assert session.bootstrap_calls == [], "a 404 must not burn a browser bootstrap"


@respx.mock
def test_invalid_json_raises_scraper_http_error() -> None:
    respx.get(URL).mock(
        side_effect=lambda request: httpx.Response(
            200, content=b"not json at all", headers={"content-type": "application/json"}
        )
    )

    with make_client() as client:
        with pytest.raises(ScraperHTTPError) as excinfo:
            client.get_json(PATH)

    assert not isinstance(excinfo.value, BlockedError)
    assert "not json at all" in (excinfo.value.body_excerpt or "")


@respx.mock
def test_non_object_json_raises_scraper_http_error() -> None:
    respx.get(URL).mock(side_effect=lambda request: httpx.Response(200, json=[1, 2, 3]))

    with make_client() as client:
        with pytest.raises(ScraperHTTPError, match="JSON object"):
            client.get_json(PATH)


@respx.mock
def test_bootstrap_failure_surfaces_as_blocked_error() -> None:
    respx.get(URL).mock(side_effect=json_response(BLOCK_PAYLOAD, status=403))

    def exploding_bootstrap() -> None:
        raise RuntimeError("chromium is not installed")

    with make_client(on_blocked=exploding_bootstrap) as client:
        with pytest.raises(BlockedError, match="chromium is not installed"):
            client.get_json(PATH)


# ---------------------------------------------------------------------------
# headers
# ---------------------------------------------------------------------------


@respx.mock
def test_headers_include_session_ua_cookies_and_csrf() -> None:
    route = respx.get(URL).mock(side_effect=json_response(OK_PAYLOAD))

    with make_client() as client:
        client.get_json(PATH, {"username": "erigostore"}, referer=f"{BASE}/erigostore")

    request = route.calls.last.request
    headers = request.headers

    assert headers["user-agent"] == TEST_UA
    assert headers["cookie"] == COOKIE_VALUE
    assert headers["x-csrftoken"] == CSRF_TOKEN
    assert headers["referer"] == f"{BASE}/erigostore"
    assert headers["x-requested-with"] == "XMLHttpRequest"
    assert headers["x-api-source"] == "pc"
    assert headers["x-shopee-language"] == "id"
    assert headers["accept-language"].startswith("id-ID")
    assert 'v="149"' in headers["sec-ch-ua"], "client hint must track the session UA"
    assert headers["sec-ch-ua-platform"] == '"macOS"'
    assert request.url.params["username"] == "erigostore"


@respx.mock
def test_referer_defaults_to_base_url() -> None:
    route = respx.get(URL).mock(side_effect=json_response(OK_PAYLOAD))

    with make_client() as client:
        client.get_json(PATH)

    assert route.calls.last.request.headers["referer"] == f"{BASE}/"


def test_build_headers_omits_cookie_and_csrf_when_session_is_empty() -> None:
    client = make_client(session=FakeSession(cookie_header="", token=None))
    headers = client._build_headers()
    client.close()

    assert "Cookie" not in headers
    assert "X-CSRFToken" not in headers
    for key in DEFAULT_HEADERS:
        assert key in headers


def test_build_headers_returns_a_fresh_mutable_dict() -> None:
    client = make_client()
    first = client._build_headers()
    first["X-Injected"] = "1"
    second = client._build_headers()
    client.close()

    assert "X-Injected" not in second
    assert "X-Injected" not in DEFAULT_HEADERS


def test_user_agent_falls_back_to_the_module_default() -> None:
    session = FakeSession()
    session.user_agent = ""
    client = make_client(session=session)
    ua = client._build_headers()["User-Agent"]
    client.close()

    assert "Chrome/" in ua


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------


def test_context_manager_bootstraps_when_the_jar_is_expired() -> None:
    session = FakeSession(expired=True)
    with make_client(session=session):
        pass

    assert session.expired_calls == 1
    assert session.bootstrap_calls == [False], "a lazy (unforced) bootstrap on entry"


def test_context_manager_skips_bootstrap_when_the_jar_is_fresh() -> None:
    session = FakeSession(expired=False)
    with make_client(session=session):
        pass

    assert session.bootstrap_calls == []


def test_context_manager_closes_the_transport() -> None:
    transport = httpx.Client(base_url=BASE)
    with make_client(client=transport):
        assert not transport.is_closed
    assert transport.is_closed


def test_context_manager_closes_the_transport_on_exception() -> None:
    transport = httpx.Client(base_url=BASE)
    with pytest.raises(ValueError):
        with make_client(client=transport):
            raise ValueError("boom")
    assert transport.is_closed, "__exit__ must close, and must not swallow"


def test_close_is_idempotent() -> None:
    client = make_client()
    client.close()
    client.close()


@respx.mock
def test_absolute_urls_bypass_base_url() -> None:
    other = "https://shopee.co.id/api/v4/pages/get_category_tree"
    route = respx.get(other).mock(side_effect=json_response(OK_PAYLOAD))

    with make_client(base_url="https://example.invalid") as client:
        client.get_json(other)

    assert route.call_count == 1


# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------


@respx.mock
def test_logs_method_path_status_and_attempt(caplog: pytest.LogCaptureFixture) -> None:
    respx.get(URL).mock(
        side_effect=[
            httpx.Response(500, text="boom"),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )

    with caplog.at_level(logging.DEBUG, logger="scraper.client"):
        with make_client() as client:
            client.get_json(PATH)

    records = [r for r in caplog.records if getattr(r, "path", None) == PATH]
    assert len(records) == 2
    assert [r.attempt for r in records] == [1, 2]
    assert [r.status for r in records] == [500, 200]
    assert all(r.method == "GET" for r in records)
    assert all(isinstance(r.elapsed_ms, float) for r in records)


@respx.mock
def test_cookie_values_are_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    respx.get(URL).mock(side_effect=json_response(BLOCK_PAYLOAD, status=403))

    with caplog.at_level(logging.DEBUG, logger="scraper.client"):
        with make_client() as client:
            with pytest.raises(BlockedError):
                client.get_json(PATH)

    blob = "\n".join(r.getMessage() for r in caplog.records)
    assert "SuperSecretCookieValue" not in blob
    assert CSRF_TOKEN not in blob


# ---------------------------------------------------------------------------
# integration with the real Settings, when the config module is implemented
# ---------------------------------------------------------------------------


@respx.mock
def test_works_with_the_real_settings_object() -> None:
    from scraper.config import Settings

    try:
        settings = Settings(min_delay=0.0, max_delay=0.0)
    except NotImplementedError:  # pragma: no cover - config module still a stub
        pytest.skip("scraper.config.Settings is not implemented yet")

    respx.get(URL).mock(side_effect=json_response(OK_PAYLOAD))

    client = ShopeeClient(session=FakeSession(), settings=settings)  # type: ignore[arg-type]
    with client:
        assert client.get_json(PATH) == OK_PAYLOAD
