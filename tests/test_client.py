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

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
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
    has_v4_error,
    is_block_envelope,
    is_soft_block,
)

BASE = SHOPEE_API_BASE
PATH = "/api/v4/shop/get_shop_detail"
URL = f"{BASE}{PATH}"
FIXTURES = Path(__file__).parent / "fixtures"

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

# THE soft block, byte-for-byte off the wire: tests/fixtures/
# shopee_soft_block_search_items.json is request #6 of .recon/browser_capture.json
# — GET /api/v4/search/search_items issued from inside a real logged-out browser
# page, answered **HTTP 200, content-type application/json, 119 bytes**. The
# status line says OK; the body says 90309999. Read as bytes rather than as a
# dict so the tests exercise the real content type and the real length.
SOFT_BLOCK_BODY: bytes = (FIXTURES / "shopee_soft_block_search_items.json").read_bytes()
SOFT_BLOCK_PAYLOAD: dict[str, Any] = json.loads(SOFT_BLOCK_BODY)

# The success shape that most resembles a block and must never be read as one:
# GET /api/v4/abtest/traffic/get_web_experiments, request #3 of the same capture.
# A **null** error, a zero retcode and an empty data list — success with no rows.
NULL_ERROR_OK_PAYLOAD: dict[str, Any] = {
    "data": [],
    "error": None,
    "error_msg": None,
    "debug": None,
    "retcode": 0,
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
def test_429_stops_after_one_request_and_never_launches_a_browser() -> None:
    """A rate limit is honoured, not escalated into eight requests and a Chromium.

    Regression: 429 was in both RETRYABLE_STATUS_CODES and BLOCK_STATUS_CODES, so
    a single rate-limited request produced 4 retried attempts, a forced cookie
    bootstrap, and 4 more attempts on the replay — an 8x traffic burst plus a
    headless browser aimed at the endpoint that had just asked us to back off.
    """
    route = respx.get(URL).mock(
        return_value=httpx.Response(429, text="slow down", headers={"Retry-After": "600"})
    )
    session = FakeSession()

    with make_client(session=session) as client:
        with pytest.raises(BlockedError) as excinfo:
            client.get_json(PATH)

    assert route.call_count == 1, "a rate limit gets exactly one request"
    assert session.bootstrap_calls == [], "fresh cookies cannot clear a rate limit"
    assert excinfo.value.status_code == 429
    # The server's own instruction reaches the operator instead of being replaced
    # by a 1-4s exponential backoff.
    assert "600" in str(excinfo.value)


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


# ---------------------------------------------------------------------------
# soft block: HTTP 200 whose body says denied
# ---------------------------------------------------------------------------


def test_the_soft_block_fixture_is_the_real_119_byte_wire_body() -> None:
    """Provenance guard on the fixture every soft-block test below is built from.

    If this ever fails, the fixture stopped being the captured body and the
    tests stopped proving anything about Shopee.
    """
    assert len(SOFT_BLOCK_BODY) == 119, "the captured body is 119 bytes, newline included"
    assert SOFT_BLOCK_PAYLOAD["error"] == 90309999
    # The same code also rides under an obfuscated numeric key, which is why
    # detection scans values and not only the `error` key.
    assert SOFT_BLOCK_PAYLOAD["3"] == 90309999
    # And it explains itself with neither of the v4 envelope's two slots — the
    # property the general (code-independent) rule keys on.
    assert "error_msg" not in SOFT_BLOCK_PAYLOAD
    assert "data" not in SOFT_BLOCK_PAYLOAD


@respx.mock
def test_real_soft_block_body_on_a_200_is_blocked() -> None:
    """The core case: HTTP 200, application/json, 119 bytes, and it is a refusal.

    Without this the client hands the body to the adapter, the adapter reads
    zero items, and a refused scrape is recorded as a SUCCESSFUL run with 0
    items — a silent hole in the price history rather than a failure.
    """
    route = respx.get(URL).mock(
        side_effect=lambda request: httpx.Response(
            200, content=SOFT_BLOCK_BODY, headers={"content-type": "application/json"}
        )
    )
    session = FakeSession()

    with make_client(session=session) as client:
        with pytest.raises(BlockedError) as excinfo:
            client.get_json(PATH)

    assert excinfo.value.status_code == 200, "a soft block reports the status it really wore"
    assert session.bootstrap_calls == [True], "one forced re-bootstrap, as for a 403"
    assert route.call_count == 2, "original + one replay, then give up"
    assert "90309999" in (excinfo.value.body_excerpt or "")


@respx.mock
def test_soft_block_recovers_after_one_rebootstrap() -> None:
    """Recovery works the same way it does for a 403: re-mint once, replay once."""
    respx.get(URL).mock(
        side_effect=[
            httpx.Response(
                200, content=SOFT_BLOCK_BODY, headers={"content-type": "application/json"}
            ),
            httpx.Response(200, json=OK_PAYLOAD),
        ]
    )
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == OK_PAYLOAD

    assert session.bootstrap_calls == [True]


@respx.mock
def test_a_soft_block_and_a_true_403_take_the_identical_path() -> None:
    """One recovery policy, not two. Regression guard for the whole fix.

    The soft block is the same refusal wearing a 200, so it must produce the
    same number of requests, the same number of browser bootstraps and the same
    exception type as the hard 403 — otherwise the retry policy, the
    NO_REBOOTSTRAP rule and the re-bootstrap breaker would each need a second,
    divergent implementation.
    """

    def run(responder: Any) -> tuple[int, list[bool], type]:
        route = respx.get(URL).mock(side_effect=responder)
        session = FakeSession()
        with make_client(session=session) as client:
            with pytest.raises(BlockedError) as excinfo:
                client.get_json(PATH)
        return route.call_count, list(session.bootstrap_calls), type(excinfo.value)

    hard = run(json_response(BLOCK_PAYLOAD, status=403))
    respx.reset()
    soft = run(
        lambda request: httpx.Response(
            200, content=SOFT_BLOCK_BODY, headers={"content-type": "application/json"}
        )
    )

    assert soft == hard == (2, [True], BlockedError)


@respx.mock
def test_repeated_soft_blocks_trip_the_same_rebootstrap_breaker() -> None:
    """The breaker protects against soft blocks too, or it protects against nothing.

    A structural block is exactly what a soft block looks like: 200 after 200
    after 200, all of them refusals. If this path had its own recovery code it
    would launch a browser per blocked request — the traffic amplification the
    breaker exists to stop — while the 403 path stayed polite.
    """
    from scraper.client import MAX_INEFFECTIVE_REBOOTSTRAPS

    respx.get(URL).mock(
        return_value=httpx.Response(
            200, content=SOFT_BLOCK_BODY, headers={"content-type": "application/json"}
        )
    )
    session = FakeSession(expired=False)

    with make_client(session=session) as client:
        for _ in range(4):
            # Neutralise the minimum-interval brake, as the 403 test does; this
            # is about the cap on bootstraps that failed to clear the block.
            client._last_bootstrap_at = None
            with pytest.raises(BlockedError):
                client.get_json(PATH)

    assert len(session.bootstrap_calls) == MAX_INEFFECTIVE_REBOOTSTRAPS


@respx.mock
def test_error_zero_with_an_empty_item_list_is_success_not_a_block() -> None:
    """The false positive that would matter most: a real, empty, successful page.

    A keyword with no matches answers ``"error": 0`` with an empty ``items``
    array. Classifying that as a block would fail healthy targets and, worse,
    teach an operator to ignore block reports.
    """
    payload = {"error": 0, "error_msg": "", "items": [], "nomore": True, "total_count": 0}
    respx.get(URL).mock(side_effect=json_response(payload))
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == payload

    assert session.bootstrap_calls == [], "an empty result must not burn a bootstrap"


@respx.mock
def test_null_error_envelope_is_not_a_block() -> None:
    """``"error": null`` beside ``"retcode": 0`` is success — verbatim from recon.

    ``/api/v4/abtest/traffic/get_web_experiments`` answers exactly this. A rule
    phrased as "any error field that is not 0" would classify it as a block.
    """
    respx.get(URL).mock(side_effect=json_response(NULL_ERROR_OK_PAYLOAD))
    session = FakeSession()

    with make_client(session=session) as client:
        assert client.get_json(PATH) == NULL_ERROR_OK_PAYLOAD

    assert session.bootstrap_calls == []


@respx.mock
def test_a_renumbered_refusal_is_still_blocked() -> None:
    """Detection must not depend on 90309999 — Shopee owns that number, not us.

    Same envelope, unknown code, and the ``redirect_to_error_page`` giveaway
    removed, leaving only the marker keys that ride with a refusal.
    """
    payload = {
        "is_customized": False,
        "is_login": False,
        "action_type": 2,
        "error": 90310042,
        "tracking_id": "9880b6c7939-a941-4207-8b47-0ae160eff05e",
    }
    respx.get(URL).mock(side_effect=json_response(payload))

    with make_client() as client:
        with pytest.raises(BlockedError):
            client.get_json(PATH)


@respx.mock
def test_an_unexplained_error_code_on_a_200_is_blocked() -> None:
    """A non-zero error that explains itself with neither error_msg nor data.

    Nothing legitimate answers a 200 that way; a refusal does.
    """
    respx.get(URL).mock(side_effect=json_response({"error": 55555}))

    with make_client() as client:
        with pytest.raises(BlockedError):
            client.get_json(PATH)


@respx.mock
def test_an_empty_error_msg_does_not_exonerate_a_refusal() -> None:
    """An empty ``error_msg`` explains nothing, so it cannot downgrade a block.

    Regression: ``_looks_like_application_error`` asked only whether the
    ``error_msg``/``data`` *keys* were present, so the key-shuffled envelope with
    a renumbered code plus a bare ``"error_msg": ""`` was classified ERROR rather
    than BLOCKED. That means no re-bootstrap, no BlockedError, and no credit
    toward the runner's consecutive-block abort — a fully blocked invocation
    would walk every remaining target at full request volume.
    """
    payload = {"3": 91234567, "error": 91234567, "error_msg": "", "9": True}
    assert is_soft_block(payload) is True

    respx.get(URL).mock(side_effect=json_response(payload))
    with make_client() as client:
        with pytest.raises(BlockedError):
            client.get_json(PATH)


def test_a_null_data_slot_does_not_exonerate_a_refusal() -> None:
    """The other half: ``"data": null`` is not an explanation either."""
    assert is_soft_block({"error": 91234567, "data": None}) is True
    assert is_soft_block({"error": 4, "error_msg": "shop not found", "data": None}) is False
    assert is_soft_block({"error": 19, "error_msg": "", "data": {"user": None}}) is False


@pytest.mark.parametrize(
    ("name", "payload", "blocked"),
    [
        # -- real bodies that MUST stay usable (.recon/browser_capture.json) --
        ("get_shop_base_v2", {"error": 0, "error_msg": "", "data": {"shopid": 30203584}}, False),
        ("is_short_url", {"data": {"url": ""}, "error": 0, "error_msg": ""}, False),
        ("shop_is_show", {"error": 0, "error_msg": "", "data": {"is_show": False}}, False),
        ("subcart", {"data": "OK"}, False),
        ("get_web_experiments", NULL_ERROR_OK_PAYLOAD, False),
        ("empty_search", {"error": 0, "items": []}, False),
        # An application error: not usable data, but not anti-bot either — fresh
        # cookies cannot fix "shop not found", so it stays the adapter's problem.
        ("account_info", {"data": None, "error": 19, "error_msg": "Failed to authenticate"}, False),
        ("shop_not_found", {"error": 4, "error_msg": "shop not found", "data": None}, False),
        # -- real refusals --
        ("soft_block_200", SOFT_BLOCK_PAYLOAD, True),
        ("block_403_body", BLOCK_PAYLOAD, True),
        ("obfuscated", OBFUSCATED_BLOCK_PAYLOAD, True),
    ],
)
def test_is_soft_block_over_every_captured_body(
    name: str, payload: dict[str, Any], blocked: bool
) -> None:
    """The classification rule, stated against the whole recon corpus at once."""
    assert is_soft_block(payload) is blocked, name


def test_has_v4_error_reads_only_the_error_field() -> None:
    """The success sentinels, spelled out: absent, null, 0, "0" and "" are all fine."""
    assert has_v4_error({"error": 90309999}) is True
    assert has_v4_error({"error": "90309999"}) is True
    assert has_v4_error({"error": 4}) is True
    assert has_v4_error({"error": 0}) is False
    assert has_v4_error({"error": "0"}) is False
    assert has_v4_error({"error": ""}) is False
    assert has_v4_error({"error": None}) is False
    assert has_v4_error({"data": "OK"}) is False


def test_is_block_envelope_ignores_a_status_it_cannot_see() -> None:
    """The envelope check is status-independent by design.

    The same bytes arrive as a 403 body and as a 200 body; a helper that needed
    the status to decide would have to be called differently in each case, which
    is precisely how the two paths drifted apart in the first place.
    """
    assert is_block_envelope(BLOCK_PAYLOAD) is True
    assert is_block_envelope(SOFT_BLOCK_PAYLOAD) is True
    assert is_block_envelope({"error": 0, "items": []}) is False


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


@respx.mock
def test_cold_start_does_not_double_bootstrap_on_an_immediate_block() -> None:
    """A jar minted seconds ago must not be re-minted by the first 403. Regression.

    ``_ensure_session`` bootstrapped a stale jar, then the very first request came
    back 403 and ``_on_block`` unconditionally forced a *second* browser launch
    seconds later — two real Chromium launches inside one ``get_json`` call, on a
    block the first launch had just demonstrably failed to prevent.
    """
    respx.get(URL).mock(return_value=httpx.Response(403, text="nope"))
    session = FakeSession(expired=True)

    with make_client(session=session) as client:
        with pytest.raises(BlockedError) as excinfo:
            client.get_json(PATH)

    assert session.bootstrap_calls == [False], "the lazy bootstrap only, no forced encore"
    assert "already bootstrapped" in str(excinfo.value)


@respx.mock
def test_repeated_blocks_stop_launching_browsers_after_the_breaker_trips() -> None:
    """A structural block must not make the scraper hit Shopee harder. Regression.

    Every blocked request independently forced a full Chromium launch with no
    cross-request memory, so modelling the live shape (three store targets, all
    listing endpoints 403) produced nine real browser launches aimed at the site
    that was already refusing us. After MAX_INEFFECTIVE_REBOOTSTRAPS failures the
    client fails fast instead.
    """
    from scraper.client import MAX_INEFFECTIVE_REBOOTSTRAPS

    respx.get(URL).mock(return_value=httpx.Response(403, text="nope"))
    session = FakeSession(expired=False)

    with make_client(session=session) as client:
        for _ in range(4):
            # Neutralise the minimum-interval brake; this test is about the cap
            # on bootstraps that demonstrably failed to clear the block.
            client._last_bootstrap_at = None
            with pytest.raises(BlockedError):
                client.get_json(PATH)

        assert client._ineffective_rebootstraps >= MAX_INEFFECTIVE_REBOOTSTRAPS

    assert len(session.bootstrap_calls) == MAX_INEFFECTIVE_REBOOTSTRAPS, (
        "the breaker caps forced bootstraps for the life of the client"
    )


@respx.mock
def test_cookie_freshness_is_rechecked_during_a_long_run() -> None:
    """Freshness must be re-armed on an interval, not checked once per client. Regression.

    ``_session_checked`` was set once and never cleared, so a client that outlived
    its 12-hour jar discovered expiry only by being blocked — one wasted request
    and one Chromium launch per discovery, instead of one cheap refresh.
    """
    from scraper import client as client_module

    respx.get(URL).mock(return_value=httpx.Response(200, json=OK_PAYLOAD))
    session = FakeSession(expired=False)

    with make_client(session=session) as client:
        client.get_json(PATH)
        client.get_json(PATH)
        assert session.expired_calls == 1, "no re-check inside the interval"

        # Pretend the interval elapsed.
        client._session_checked_at -= client_module.SESSION_RECHECK_INTERVAL + 1
        client.get_json(PATH)

    assert session.expired_calls == 2, "the check re-arms once the interval passes"


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
