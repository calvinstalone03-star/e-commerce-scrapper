"""Tests for the debounce that turns a stream of ingest batches into one run.

The interesting properties are all about *when* it fires: not before the quiet
window closes, not twice for one burst, not at all without a mark, and never in
a way that lets a dead dashboard take the ingest server down with it.
"""

from __future__ import annotations

import threading

import httpx
import pytest
import respx

from scraper.config import Settings
from scraper.notify_trigger import (
    DEFAULT_QUIET_SECONDS,
    NotifyTrigger,
    build_notify_trigger,
    post_notify,
)


class FakeClock:
    """A monotonic clock the test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class Recorder:
    """Stands in for the POST, counting runs instead of making them."""

    def __init__(self, fail: bool = False) -> None:
        self.runs = 0
        self.fail = fail

    def __call__(self) -> None:
        self.runs += 1
        if self.fail:
            raise httpx.ConnectError("connection refused")


@pytest.fixture()
def clock() -> FakeClock:
    return FakeClock()


def trigger_with(clock: FakeClock, send: Recorder, quiet: float = 180.0) -> NotifyTrigger:
    return NotifyTrigger(
        "http://127.0.0.1:3100", "s3cret", quiet_seconds=quiet, send=send, clock=clock
    )


# ----------------------------------------------------------------------
# When it fires
# ----------------------------------------------------------------------


def test_nothing_fires_without_a_mark(clock) -> None:
    """An idle server must not run the notifier on a timer of its own."""
    send = Recorder()
    trigger = trigger_with(clock, send)

    clock.advance(10_000)

    assert trigger.flush_if_due() is False
    assert send.runs == 0


def test_a_mark_does_not_fire_before_the_window_closes(clock) -> None:
    send = Recorder()
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(179.0)

    assert trigger.flush_if_due() is False
    assert send.runs == 0


def test_a_mark_fires_once_the_window_closes(clock) -> None:
    send = Recorder()
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(180.0)

    assert trigger.flush_if_due() is True
    assert send.runs == 1


def test_a_later_mark_pushes_the_run_back(clock) -> None:
    """The whole point: a burst is one run, timed from its last batch.

    Browsing a shop's listings delivers a batch per page. Firing from the first
    one would send a notification into the middle of the session and then have
    nothing left to say about the rest of it.
    """
    send = Recorder()
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(170.0)
    trigger.mark()  # still browsing
    clock.advance(20.0)  # 190s since the first mark, 20s since the last

    assert trigger.flush_if_due() is False

    clock.advance(160.0)

    assert trigger.flush_if_due() is True
    assert send.runs == 1


def test_one_burst_produces_one_run(clock) -> None:
    send = Recorder()
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(200.0)
    trigger.flush_if_due()

    clock.advance(10_000)

    assert trigger.flush_if_due() is False
    assert send.runs == 1


def test_a_new_burst_after_a_run_fires_again(clock) -> None:
    send = Recorder()
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(200.0)
    trigger.flush_if_due()

    trigger.mark()
    clock.advance(200.0)

    assert trigger.flush_if_due() is True
    assert send.runs == 2


def test_a_zero_quiet_window_fires_on_the_next_check(clock) -> None:
    """`notify_quiet_seconds=0` means "as soon as you notice", not "never"."""
    send = Recorder()
    trigger = trigger_with(clock, send, quiet=0.0)

    trigger.mark()

    assert trigger.flush_if_due() is True
    assert send.runs == 1


# ----------------------------------------------------------------------
# Failure
# ----------------------------------------------------------------------


def test_a_failed_run_does_not_reach_the_caller(clock) -> None:
    """A dashboard that is down must not turn into a 500 on the ingest path."""
    send = Recorder(fail=True)
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(200.0)

    assert trigger.flush_if_due() is True
    assert send.runs == 1


def test_a_failed_run_is_not_retried(clock) -> None:
    """launchd retries every half hour; a loop here would be a second one."""
    send = Recorder(fail=True)
    trigger = trigger_with(clock, send)

    trigger.mark()
    clock.advance(200.0)
    trigger.flush_if_due()

    clock.advance(10_000)

    assert trigger.flush_if_due() is False
    assert send.runs == 1


def test_the_secret_stays_out_of_repr() -> None:
    """This object hangs off a FastAPI app any traceback may render."""
    trigger = NotifyTrigger("http://127.0.0.1:3100", "s3cret-do-not-print")

    assert "s3cret" not in repr(trigger)
    assert "127.0.0.1:3100" in repr(trigger)


# ----------------------------------------------------------------------
# The background thread
# ----------------------------------------------------------------------


def test_the_thread_fires_without_a_manual_flush() -> None:
    fired = threading.Event()
    trigger = NotifyTrigger(
        "http://127.0.0.1:3100",
        "s3cret",
        quiet_seconds=0.0,
        tick_seconds=0.01,
        send=fired.set,
    )

    trigger.start()
    try:
        trigger.mark()
        assert fired.wait(5.0) is True
    finally:
        trigger.stop()


def test_start_is_idempotent() -> None:
    trigger = NotifyTrigger(
        "http://127.0.0.1:3100", "s3cret", tick_seconds=0.01, send=lambda: None
    )

    trigger.start()
    first = trigger._thread
    trigger.start()
    try:
        assert trigger._thread is first
    finally:
        trigger.stop()


def test_stop_is_safe_before_start() -> None:
    trigger = NotifyTrigger("http://127.0.0.1:3100", "s3cret", send=lambda: None)

    trigger.stop()  # must not raise


def test_stop_ends_the_thread() -> None:
    trigger = NotifyTrigger(
        "http://127.0.0.1:3100", "s3cret", tick_seconds=0.01, send=lambda: None
    )

    trigger.start()
    thread = trigger._thread
    trigger.stop(timeout=5.0)

    assert thread is not None
    assert thread.is_alive() is False


# ----------------------------------------------------------------------
# The POST itself
# ----------------------------------------------------------------------


@respx.mock
def test_post_carries_the_bearer_token_to_the_notify_route() -> None:
    route = respx.post("http://127.0.0.1:3100/api/notify").mock(
        return_value=httpx.Response(200, json={"sent": 2})
    )

    post_notify("http://127.0.0.1:3100/", "s3cret")

    assert route.called
    request = route.calls[0].request
    assert request.headers["authorization"] == "Bearer s3cret"
    assert request.headers["content-type"] == "application/json"


@respx.mock
def test_post_raises_when_the_route_refuses() -> None:
    """A 401 answers with a body, and swallowing it would report success."""
    respx.post("http://127.0.0.1:3100/api/notify").mock(
        return_value=httpx.Response(401, json={"detail": "bad secret"})
    )

    with pytest.raises(httpx.HTTPStatusError):
        post_notify("http://127.0.0.1:3100", "wrong")


# ----------------------------------------------------------------------
# Construction from settings
# ----------------------------------------------------------------------


def base_settings(**kwargs) -> Settings:
    """Settings with the notifier explicitly unconfigured.

    Explicit None rather than an omission: this repo's own ``.env`` sets
    ``NOTIFY_URL``, and ``Settings`` reads it, so an omitted field would make
    "not configured" mean "whatever is in the developer's checkout".
    """
    fields = {
        "notify_url": None,
        "notify_secret": None,
        "neon_notify_url": None,
        "neon_notify_secret": None,
        **kwargs,
    }
    return Settings(database_url="postgresql://localhost/unused", **fields)


def test_no_trigger_without_configuration() -> None:
    """A bare checkout has no dashboard, and ingest must still run."""
    assert build_notify_trigger(base_settings()) is None


@pytest.mark.parametrize(
    "kwargs",
    [
        {"notify_url": "http://127.0.0.1:3100"},
        {"notify_secret": "s3cret"},
    ],
)
def test_half_a_configuration_builds_nothing(kwargs) -> None:
    assert build_notify_trigger(base_settings(**kwargs)) is None


def test_both_variables_build_a_trigger() -> None:
    trigger = build_notify_trigger(
        base_settings(notify_url="http://127.0.0.1:3100/", notify_secret="s3cret")
    )

    assert trigger is not None
    assert trigger.url == "http://127.0.0.1:3100"  # trailing slash normalised
    assert trigger.quiet_seconds == DEFAULT_QUIET_SECONDS


def test_the_neon_target_reads_its_own_variables() -> None:
    trigger = build_notify_trigger(
        base_settings(
            notify_url="http://127.0.0.1:3100",
            notify_secret="local-secret",
            neon_notify_url="https://dashboard.example",
            neon_notify_secret="hosted-secret",
        ),
        target="neon",
    )

    assert trigger is not None
    assert trigger.url == "https://dashboard.example"


def test_the_neon_secret_does_not_fall_back_to_the_local_one() -> None:
    """A fallback would send the laptop's secret to a host on the internet."""
    trigger = build_notify_trigger(
        base_settings(
            notify_secret="local-secret",
            neon_notify_url="https://dashboard.example",
        ),
        target="neon",
    )

    assert trigger is None


def test_an_unknown_notify_target_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="unknown notify target"):
        build_notify_trigger(base_settings(), target="mars")


def test_the_quiet_window_comes_from_settings() -> None:
    trigger = build_notify_trigger(
        base_settings(
            notify_url="http://127.0.0.1:3100",
            notify_secret="s3cret",
            notify_quiet_seconds=42.0,
        )
    )

    assert trigger is not None
    assert trigger.quiet_seconds == 42.0
