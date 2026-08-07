"""Run the dashboard's notifier once a burst of ingest has gone quiet.

The extension does not scrape in runs. It hands over whatever JSON the page the
user is on already received (:mod:`scraper.ingest`), so data arrives as a stream
of small batches for as long as they keep browsing, and there is no "scrape
finished" event to hang a notification on. The closest honest equivalent is
*silence*: a batch stored something, and then nothing more arrived for a while.

That is what this module watches for. Every batch that writes a row calls
:meth:`NotifyTrigger.mark`; a background thread posts to the dashboard's
``/api/notify`` once ``quiet_seconds`` have passed with no further mark.

What that buys, precisely: a new shop or a new listing reaches Telegram about a
quiet window after it is captured, instead of waiting out the launchd agent's
half-hour tick — those two are watermark comparisons (``s.id > lastStoreId`` in
``dashboard/src/lib/notify/events.ts``), so they are reportable the moment the
row exists. It does **not** make price changes arrive sooner: a change is only
reported once its comparison snapshot is ``NOTIFY_MIN_GAP_HOURS`` (12) older, so
their timing is set by the data and no trigger can improve on it.

The launchd agent stays, and this does not replace it. It is the ceiling this
cannot provide: a browsing session that never goes quiet never fires a trigger,
and a failed POST here is dropped rather than retried (see
:meth:`NotifyTrigger.flush_if_due`). Both cases are covered by the half-hour
tick, which is also why dropping is the right call — a retry loop inside this
process would duplicate a mechanism that already exists and already works.

Two triggers landing at once is safe: ``/api/notify`` takes the watermark row
``FOR UPDATE``, so the second waits for the first and then finds nothing new.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from scraper.config import Settings, get_settings

__all__ = [
    "DEFAULT_QUIET_SECONDS",
    "DEFAULT_TICK_SECONDS",
    "NotifyTrigger",
    "build_notify_trigger",
    "post_notify",
]

log = logging.getLogger(__name__)

#: How long ingest must stay silent before a run is considered over. Three
#: minutes: long enough that paging through one shop's listings is a single
#: burst rather than a message per page, short enough that a notification still
#: lands while the user remembers what they were looking at.
DEFAULT_QUIET_SECONDS = 180.0

#: How often the background thread re-checks. Cheap — it takes a lock, compares
#: two floats and goes back to sleep — so this only sets the granularity of the
#: quiet window, and there is no reason for it to be tight.
DEFAULT_TICK_SECONDS = 5.0

#: Read timeout for the POST. ``FUNCTION_BUDGET_SECONDS`` in
#: ``dashboard/src/lib/notify/run.ts`` is 60, and a run that is queued behind
#: another one's ``FOR UPDATE`` can take longer still, so this leaves room rather
#: than reporting a timeout for a notifier that is working.
POST_TIMEOUT_SECONDS = 120.0


def post_notify(url: str, secret: str) -> None:
    """POST the notifier's run endpoint and raise unless it succeeded.

    Args:
        url: Base URL of the dashboard, with or without a trailing slash.
        secret: ``NOTIFY_SECRET``, sent as a bearer token.

    Raises:
        httpx.HTTPError: On a transport failure or a non-2xx response. The
            caller logs it; nothing here retries.
    """
    import httpx

    response = httpx.post(
        f"{url.rstrip('/')}/api/notify",
        headers={
            "authorization": f"Bearer {secret}",
            "content-type": "application/json",
        },
        timeout=httpx.Timeout(POST_TIMEOUT_SECONDS, connect=5.0),
    )
    response.raise_for_status()
    # The route answers with what it sent, and a failed run explains itself in
    # `detail`. Logged whole (bounded) because this runs unattended: without the
    # body, logs/ingest.log records that a notification happened but not what
    # was in it, which is the first thing anyone checks.
    log.info("notifier ran: %s", response.text[:500])


class NotifyTrigger:
    """Debounce ingest activity down to one notifier run per quiet period.

    Thread-safe: :meth:`mark` is called from FastAPI's worker threads while the
    background thread calls :meth:`flush_if_due`.

    Args:
        url: Dashboard base URL (``NOTIFY_URL``).
        secret: ``NOTIFY_SECRET``, matching the dashboard's own.
        quiet_seconds: Silence required after the last mark before firing.
        tick_seconds: How often the background thread checks.
        send: Override for the POST, for tests. Called with no arguments.
        clock: Monotonic clock source, for tests. A wall clock would let an NTP
            step or a laptop waking from sleep fire early or hang the window.
    """

    def __init__(
        self,
        url: str,
        secret: str,
        *,
        quiet_seconds: float = DEFAULT_QUIET_SECONDS,
        tick_seconds: float = DEFAULT_TICK_SECONDS,
        send: Callable[[], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.url = url.rstrip("/")
        self.quiet_seconds = float(quiet_seconds)
        self.tick_seconds = float(tick_seconds)
        self._secret = secret
        self._send = send if send is not None else lambda: post_notify(self.url, secret)
        self._clock = clock
        self._lock = threading.Lock()
        self._marked_at: float | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __repr__(self) -> str:
        # Explicit, because the default would print `_secret` — a bearer
        # credential for a route that writes to Telegram — and this object is
        # reachable from a FastAPI app that any future traceback may render.
        return f"NotifyTrigger(url={self.url!r}, quiet_seconds={self.quiet_seconds!r})"

    def mark(self) -> None:
        """Record that ingest just stored something.

        Cheap and non-blocking by design: this sits on the extension's request
        path, which is a user browsing.
        """
        with self._lock:
            self._marked_at = self._clock()

    def flush_if_due(self) -> bool:
        """Run the notifier if the quiet window has closed since the last mark.

        Returns:
            True if a run was attempted — including one that failed. False when
            nothing is pending or the window is still open.
        """
        with self._lock:
            marked_at = self._marked_at
            if marked_at is None or self._clock() - marked_at < self.quiet_seconds:
                return False
            # Cleared before sending, not after, and outside the lock the send
            # runs under: a mark arriving mid-send is a genuinely new batch and
            # deserves its own run, and holding the lock across a request that
            # may take a minute would block the extension's ingest calls.
            self._marked_at = None

        try:
            self._send()
        except Exception as exc:  # noqa: BLE001 - a dead notifier must not kill ingest
            # Not retried, and the mark stays cleared. The launchd agent runs
            # this same endpoint every half hour; a retry here would rebuild
            # that mechanism badly, and a tight loop against a dashboard that is
            # down would fill the log with the same line.
            log.warning("notify trigger failed (launchd will retry): %s", exc)
        return True

    def start(self) -> None:
        """Start the background thread. Idempotent."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        # Daemon: the thread spends its life in Event.wait, and the server
        # should be able to exit without waiting out a tick.
        self._thread = threading.Thread(target=self._loop, name="notify-trigger", daemon=True)
        self._thread.start()
        log.info(
            "notify trigger armed: %s, %.0fs quiet window", self.url, self.quiet_seconds
        )

    def stop(self, timeout: float | None = None) -> None:
        """Stop the background thread. Idempotent, safe before :meth:`start`.

        Args:
            timeout: Seconds to wait for the thread to notice. Defaults to two
                ticks, enough for a thread sitting in ``wait`` and short enough
                that a shutdown is not held up by an in-flight POST.
        """
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(self.tick_seconds * 2 if timeout is None else timeout)

    def _loop(self) -> None:
        # wait() returns True only when stop() sets the event, so this both
        # sleeps between checks and wakes immediately on shutdown.
        while not self._stop.wait(self.tick_seconds):
            self.flush_if_due()


def build_notify_trigger(
    settings: Settings | None = None, *, target: str = "local"
) -> NotifyTrigger | None:
    """Build the trigger for one ingest target, or None when unconfigured.

    One dashboard reads one database, so each ingest target has its own: writes
    to the laptop's Postgres are news to the dashboard on `NOTIFY_URL`, and
    writes to the hosted database are news to the deployment on
    ``NEON_NOTIFY_URL``. Running the wrong one is not harmful — it reads a
    database nothing just wrote to and finds nothing — but it is a request that
    could never report anything.

    ``NEON_NOTIFY_SECRET`` deliberately does not fall back to ``NOTIFY_SECRET``:
    the two dashboards are different deployments, and a fallback would send the
    laptop's secret to a host on the internet because a variable was forgotten.

    Absent configuration is the normal case rather than an error — a bare
    checkout has no dashboard, and ingest must run without one.

    Args:
        settings: Configuration. Defaults to :func:`get_settings`.
        target: ``local`` or ``neon``.

    Returns:
        A stopped :class:`NotifyTrigger`, or None if either variable is unset.

    Raises:
        ValueError: On an unknown target.
    """
    settings = settings or get_settings()
    if target == "local":
        url, secret = settings.notify_url, settings.notify_secret
    elif target == "neon":
        url, secret = settings.neon_notify_url, settings.neon_notify_secret
    else:
        raise ValueError(f"unknown notify target {target!r}")

    if not url or not secret:
        return None
    return NotifyTrigger(url, secret, quiet_seconds=settings.notify_quiet_seconds)
