"""Typer command-line interface.

Commands::

    ecom-scraper bootstrap [--force] [--login/--no-login] [--headful]
    ecom-scraper login [--timeout S] [--poll S]
    ecom-scraper doctor [--username U] [--keyword K] [--shopid N] [--json]
    ecom-scraper run --mode keyword|store [--keywords-file P] [--stores-file P]
                     [--pages N] [--target T ...] [--marketplace shopee]
    ecom-scraper initdb
    ecom-scraper stats [--marketplace shopee]

``login`` opens a visible browser and waits while **you** log in by hand; it only
harvests the resulting cookie jar. ``doctor`` then probes the known endpoints with
that jar and says, per endpoint, whether the answer is usable — which is how you
find out whether logging in actually unlocked search.

``--target`` is also spelled ``--keyword`` and ``--store``; the three are the
same repeatable option, so ``--keyword "sepatu pria" --keyword "tas kulit"``
reads naturally in keyword mode and ``--store erigostore`` in store mode. Inline
targets override the target file entirely.

The CLI is a thin shell: it parses options, calls exactly one function in
:mod:`scraper.runner`, :mod:`scraper.session`, :mod:`scraper.db` or
:mod:`scraper.store`, and renders the result with Rich. No scraping, parsing or
SQL belongs in this module — ``docs/DESIGN.md`` §7 gives it "option parsing and
Rich rendering" and nothing else. The ``stats`` reads (recent runs, recent price
changes) live in :func:`scraper.store.recent_runs` and
:func:`scraper.store.recent_price_changes`.

Exit codes: ``0`` success, ``1`` partial failure (some targets failed), ``2``
usage/configuration error. Typer raises :class:`typer.Exit` to set these.
"""

from __future__ import annotations

import json as jsonlib
import random
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
import typer
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from scraper.config import Settings
from scraper.models import Marketplace, RunMode, RunStatus

__all__ = ["app", "main", "console"]

app = typer.Typer(
    name="ecom-scraper",
    help="Scrape marketplace listings (Shopee first) into Postgres.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()

#: Cookie names that only exist on a logged-in Shopee jar. Presence of any one of
#: them is what ``bootstrap`` reports as "authenticated". Values are never read,
#: logged or printed — only the names are inspected.
#:
#: Sourced from :mod:`scraper.session` rather than restated here. This module
#: previously carried its own wider set including ``SPC_U`` and ``SPC_R_T_ID``,
#: which made every anonymous bootstrap report "authenticated: yes": the
#: browser-capture recon (``.recon/cookie_names.json``) shows ``SPC_R_T_ID`` in
#: the 21-cookie **logged-out** jar. Only ``SPC_EC``/``SPC_ST`` are login-only,
#: and ``session.ShopeeSession`` already judges its own jar by exactly that set.
#: Two definitions of "authenticated" in one package is how they drifted apart.
def _authenticated_cookie_names() -> frozenset[str]:
    """Login-only cookie names, per :mod:`scraper.session`.

    Returns:
        The names whose presence means the jar carries a logged-in session.
    """
    from scraper.session import AUTHENTICATED_COOKIES

    return frozenset(AUTHENTICATED_COOKIES)

#: How many rows the ``stats`` tables show.
RECENT_RUNS_LIMIT = 10
RECENT_CHANGES_LIMIT = 10


@app.callback()
def _configure(
    verbose: bool = typer.Option(
        False,
        "--verbose",
        "-v",
        help="Show INFO-level diagnostics: every request, cookie bootstraps, "
        "per-strategy item counts.",
    ),
    quiet: bool = typer.Option(
        False, "--quiet", "-q", help="Only show errors."
    ),
    log_file: Path | None = typer.Option(
        None, "--log-file", help="Also append plain-text logs here, for cron runs."
    ),
) -> None:
    """Install logging before any command runs.

    The package had no logging configuration at all, so the root logger sat at
    its WARNING default and every INFO diagnostic the code carefully emits — the
    per-request ``GET /api/v4/... -> 403``, ``bootstrapped N cookies``, the
    per-strategy item counts — was discarded with no way to get it back short of
    editing source. That is exactly the trail an operator needs when a run comes
    back green with zero items. What did survive went to a bare stderr handler
    that interleaved with, and corrupted, the live Rich progress display.

    Args:
        verbose: Lower the threshold to INFO.
        quiet: Raise it to ERROR. Ignored when ``verbose`` is also set.
        log_file: Optional path to append a plain-text copy to.
    """
    import logging

    from rich.logging import RichHandler

    level = logging.INFO if verbose else (logging.ERROR if quiet else logging.WARNING)
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    # Bound to the same Console the progress reporter uses, so log lines and the
    # spinner cooperate instead of overwriting each other.
    rich_handler = RichHandler(
        console=console, show_path=False, rich_tracebacks=True, log_time_format="%H:%M:%S"
    )
    rich_handler.setLevel(level)
    root.addHandler(rich_handler)

    if log_file is not None:
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(level)
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )
        root.addHandler(file_handler)


# ---------------------------------------------------------------------------
# Presentation helpers
# ---------------------------------------------------------------------------


def _fail(message: str, *, code: int = 2) -> None:
    """Print an error and exit with ``code``.

    The message is escaped before rendering: it routinely carries an exception
    string, and a stray ``[`` in a path or a driver error would otherwise be
    parsed as Rich markup and blow up the error reporting itself.

    Args:
        message: Operator-facing message. Must never contain a secret.
        code: Process exit code. Defaults to 2 (usage/configuration error).

    Raises:
        typer.Exit: Always.
    """
    console.print(f"[bold red]error:[/bold red] {escape(message)}")
    raise typer.Exit(code)


def _safe_dsn(database_url: str) -> str:
    """Render a DB URL with any password removed, for error messages.

    Args:
        database_url: The configured URL.

    Returns:
        ``driver://user@host:port/dbname`` — never the password.
    """
    try:
        parts = urlsplit(database_url)
    except ValueError:
        return "<unparseable DATABASE_URL>"
    user = f"{parts.username}@" if parts.username else ""
    host = parts.hostname or "?"
    port = f":{parts.port}" if parts.port else ""
    name = parts.path.lstrip("/") or "?"
    return f"{parts.scheme}://{user}{host}{port}/{name}"


def _fmt_dt(value: object) -> str:
    """Format a timestamp for a Rich cell.

    Args:
        value: A datetime, or anything falsy.

    Returns:
        ``YYYY-MM-DD HH:MM:SS`` in the value's own timezone, or ``-``.
    """
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return "-" if value is None else str(value)


def _fmt_rupiah(value: object) -> str:
    """Format a Decimal price as thousands-separated rupiah.

    Args:
        value: Price in whole rupiah, or None.

    Returns:
        e.g. ``Rp 152.900``, or ``-`` when unknown.
    """
    if value is None:
        return "-"
    try:
        amount = Decimal(str(value)).quantize(Decimal(1))
    except (ArithmeticError, ValueError):
        return str(value)
    return "Rp " + f"{amount:,}".replace(",", ".")


def _status_style(status: str) -> str:
    """Map a run status onto a Rich colour.

    Args:
        status: The ``scrape_runs.status`` value.

    Returns:
        A Rich style name.
    """
    return {
        RunStatus.SUCCESS.value: "green",
        RunStatus.PARTIAL.value: "yellow",
        RunStatus.FAILED.value: "red",
        RunStatus.RUNNING.value: "cyan",
    }.get(str(status), "white")


def _settings() -> Settings:
    """Load settings, turning a bad ``.env`` into a clean exit-2.

    Returns:
        The process-wide :class:`~scraper.config.Settings`.

    Raises:
        typer.Exit: Code 2 when the environment cannot be parsed.
    """
    from scraper.config import get_settings

    try:
        return get_settings()
    except Exception as exc:  # noqa: BLE001 — surface config errors as usage errors
        _fail(f"invalid configuration (check .env): {exc}")
        raise  # unreachable; keeps type checkers happy


# ---------------------------------------------------------------------------
# doctor: one probe per known endpoint
# ---------------------------------------------------------------------------

#: Marketplace origin the probes run against.
SHOPEE_SITE = "https://shopee.co.id"

#: Defaults for the three things the probes need a value for. ``erigostore`` /
#: ``30203584`` is the shop the recon capture in ``.recon/`` was taken against, so
#: a bare ``ecom-scraper doctor`` reproduces exactly what that capture saw.
DOCTOR_DEFAULT_USERNAME = "erigostore"
DOCTOR_DEFAULT_SHOP_ID = 30203584
DOCTOR_DEFAULT_KEYWORD = "sepatu pria"

#: Seconds between two probes, drawn uniformly. Five endpoints back to back with
#: no gap is exactly the burst the whole scraper is built to avoid.
DOCTOR_MIN_SPACING = 2.0
DOCTOR_MAX_SPACING = 4.0

#: Per-request timeout for a probe, seconds.
DOCTOR_TIMEOUT = 30.0

#: Shopee's anti-bot refusal code, observed live on ``search_items`` — served with
#: HTTP **200** and a ~119-byte body. It is the reason this command judges by the
#: envelope and not by the status line.
ANTIBOT_ERROR_CODE = 90309999

VERDICT_OK = "OK"
#: The envelope reported success and carried rows, but zero of them. A keyword
#: nothing matches, a shop with no custom categories and an SEO payload with an
#: empty ``items`` list all land here. Its own verdict on purpose: folding it
#: into BLOCKED told operators a healthy session was refused and sent them to
#: re-run ``login`` chasing a block two HTTP 200s had already disproved.
VERDICT_EMPTY = "EMPTY"
#: The endpoint answered with its own error ("shop not found"). Not usable data,
#: but not anti-bot either — fresh cookies cannot fix it.
VERDICT_ERROR = "ERROR"
VERDICT_BLOCKED = "BLOCKED"


@dataclass
class _ProbeTargets:
    """The three values the probe URLs need filling in.

    ``shop_id`` starts at the CLI default (or ``--shopid``) and is upgraded in
    place the moment a shop probe reveals the real id for ``username``, so that
    ``--username someothershop`` needs no second flag.

    Attributes:
        username: Shop slug for the shop endpoints.
        keyword: Search phrase for ``search_items``.
        shop_id: Numeric shop id for ``get_shop_seo`` / ``get_categories``.
        shop_id_discovered: Whether ``shop_id`` came from a live payload. First
            discovery wins, so the id cannot flip halfway down the table.
    """

    username: str
    keyword: str
    shop_id: int
    shop_id_discovered: bool = False


@dataclass(frozen=True)
class _EndpointProbe:
    """One endpoint to hit exactly once.

    Attributes:
        name: Short label shown in the table.
        method: HTTP method. ``get_shop_base_v2`` is a POST with a JSON body;
            everything else is a GET.
        path: API path.
        params: Builds the query string from the current targets.
        body: Builds the JSON request body, or None for a bodyless request.
        referer: Builds the ``Referer`` — the page a human would have been on.
    """

    name: str
    method: str
    path: str
    params: Any = None
    body: Any = None
    referer: Any = None


#: The five endpoints, probed in this order. ``get_shop_base_v2`` and
#: ``get_shop_detail`` come first because their payloads carry the numeric
#: ``shopid`` that the two endpoints after them need.
ENDPOINT_PROBES: tuple[_EndpointProbe, ...] = (
    _EndpointProbe(
        name="get_shop_base_v2",
        method="POST",
        path="/api/v4/shop/get_shop_base_v2",
        body=lambda t: {
            "entry_point": "",
            "request_source": "pc_shop_home_page",
            "livestream_params": {},
            "user_address": {},
            "username": t.username,
        },
        referer=lambda t: f"{SHOPEE_SITE}/{t.username}",
    ),
    _EndpointProbe(
        name="get_shop_detail",
        method="GET",
        path="/api/v4/shop/get_shop_detail",
        params=lambda t: {"username": t.username},
        referer=lambda t: f"{SHOPEE_SITE}/{t.username}",
    ),
    _EndpointProbe(
        name="get_shop_seo",
        method="GET",
        path="/api/v4/shop/get_shop_seo",
        params=lambda t: {"shopid": t.shop_id},
        referer=lambda t: f"{SHOPEE_SITE}/shop/{t.shop_id}",
    ),
    _EndpointProbe(
        name="get_categories",
        method="GET",
        path="/api/v4/shop/get_categories",
        params=lambda t: {
            "limit": 20,
            "offset": 0,
            "shopid": t.shop_id,
            "two_tier_cate": 1,
        },
        referer=lambda t: f"{SHOPEE_SITE}/{t.username}",
    ),
    _EndpointProbe(
        name="search_items",
        method="GET",
        path="/api/v4/search/search_items",
        params=lambda t: {
            "by": "relevancy",
            "keyword": t.keyword,
            "limit": 60,
            "newest": 0,
            "order": "desc",
            "page_type": "search",
            "scenario": "PAGE_GLOBAL_SEARCH",
            "version": 2,
        },
        referer=lambda t: f"{SHOPEE_SITE}/search?keyword={quote(t.keyword)}",
    ),
)


@dataclass
class _ProbeResult:
    """What one probe found.

    Attributes:
        name: Endpoint label.
        method: HTTP method used.
        path: API path hit.
        status: HTTP status, or None on a transport failure. **Never** decides
            the verdict — Shopee refuses with 200.
        error: Top-level envelope ``error`` code, or None when the body carried
            no recognisable envelope.
        error_msg: Shopee's own ``error_msg``, when present.
        items: Count of usable records found in the payload.
        verdict: :data:`VERDICT_OK`, :data:`VERDICT_EMPTY`, :data:`VERDICT_ERROR`
            or :data:`VERDICT_BLOCKED`.
        note: Why, in one line. Empty when the verdict is OK.
    """

    name: str
    method: str
    path: str
    status: int | None = None
    error: int | None = None
    error_msg: str = ""
    items: int = 0
    verdict: str = VERDICT_BLOCKED
    note: str = ""

    def as_dict(self) -> dict[str, object]:
        """Render as a plain JSON-serialisable dict for ``--json``.

        Returns:
            One flat object per probe.
        """
        return {
            "endpoint": self.name,
            "method": self.method,
            "path": self.path,
            "http_status": self.status,
            "error": self.error,
            "error_msg": self.error_msg,
            "items": self.items,
            "verdict": self.verdict,
            "note": self.note,
        }


def _pause_between_probes() -> float:
    """Sleep a couple of seconds so five probes are not a burst.

    Its own function so a test can neutralise it without patching ``time.sleep``
    process-wide.

    Returns:
        The seconds slept.
    """
    delay = random.uniform(DOCTOR_MIN_SPACING, DOCTOR_MAX_SPACING)
    time.sleep(delay)
    return delay


def _probe_headers(session: Any, *, referer: str, json_body: bool) -> dict[str, str]:
    """Build the header set a probe sends — identical to a real scraper request.

    Fidelity is the whole point: a verdict is only evidence about the real run if
    the probe looked exactly like the real run. The static set and the client-hint
    derivation are therefore taken from :mod:`scraper.client` rather than restated
    here, and the cookies come from the jar on disk as-is.

    Args:
        session: The :class:`~scraper.session.ShopeeSession` holding the jar.
        referer: Page URL to claim as the referrer.
        json_body: True when a JSON request body will be sent.

    Returns:
        A fresh header dict. Cookie **values** live in it, so it is never logged
        or printed.
    """
    from scraper import client as client_mod

    headers = dict(client_mod.DEFAULT_HEADERS)
    user_agent = session.user_agent
    headers["User-Agent"] = user_agent
    headers["Referer"] = referer

    # Client hints are derived from the UA by client.py. Pulled by name with a
    # fallback so this diagnostic can never be what breaks when that module is
    # refactored — worst case the hints are simply omitted.
    for header, helper in (("Sec-CH-UA", "_sec_ch_ua"), ("Sec-CH-UA-Platform", "_sec_ch_ua_platform")):
        derive = getattr(client_mod, helper, None)
        if callable(derive):
            headers[header] = derive(user_agent)

    cookie_header = session.as_cookie_header()
    if cookie_header:
        headers["Cookie"] = cookie_header
    token = session.csrf_token()
    if token:
        headers["X-CSRFToken"] = token
    if json_body:
        headers["Content-Type"] = "application/json"
        headers["Origin"] = SHOPEE_SITE
    return headers


def _envelope_error(payload: dict[str, Any]) -> int | None:
    """Extract the top-level envelope error code from a decoded body.

    Handles both shapes seen live: the readable ``{"error": 90309999, ...}`` and
    the obfuscated one the SPA receives, where the same code arrives under a
    numeric string key.

    Args:
        payload: Decoded JSON object.

    Returns:
        The error code, or None when the body carries no recognisable envelope.
    """
    error = payload.get("error")
    if isinstance(error, int) and not isinstance(error, bool):
        return error
    for value in payload.values():
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value == ANTIBOT_ERROR_CODE:
            return value
    return None


def _count_items(payload: dict[str, Any]) -> int:
    """Count the usable records in a probe response.

    "Usable" is deliberately generous — a shop envelope counts as one record, a
    listing/category envelope counts its rows — because the question this command
    answers is "did anything real come back", not "how many".

    Args:
        payload: Decoded JSON object.

    Returns:
        Number of usable records, 0 when the payload carried none.
    """
    for key in ("items", "shop_categories", "categories"):
        value = payload.get(key)
        if isinstance(value, list):
            return len(value)

    data = payload.get("data")
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        for key in ("items", "shop_categories", "categories"):
            value = data.get(key)
            if isinstance(value, list):
                return len(value)
        return 1 if data else 0
    return 0


def _shop_id_from(payload: dict[str, Any]) -> int | None:
    """Dig the numeric shop id out of a shop payload, if it is there.

    Args:
        payload: Decoded JSON object from a shop endpoint.

    Returns:
        The shop id, or None.
    """
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    for key in ("shopid", "shop_id"):
        value = data.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def _error_label(result: _ProbeResult, payload: dict[str, Any]) -> str:
    """One-line description of a non-zero envelope error, for the note column.

    Args:
        result: Probe result whose ``error``/``error_msg`` are already filled in.
        payload: The decoded body, used when ``error`` was not an integer.

    Returns:
        Something like ``envelope error 4: shop not found``.
    """
    code = result.error if result.error is not None else payload.get("error")
    label = f"envelope error {code}"
    if result.error_msg:
        label += f": {result.error_msg}"
    return label


def _judge(result: _ProbeResult, payload: dict[str, Any] | None) -> None:
    """Set ``verdict`` and ``note`` on a result from its **payload**, not its status.

    Shopee answers a blocked ``search_items`` with HTTP 200 and a 119-byte
    ``{"error":90309999,...}`` body, so a status-based verdict would report a hard
    block as healthy.

    The block rule is :func:`scraper.client.is_soft_block`, not a second opinion
    written here: doctor exists to describe what the *transport* will do with
    this session, and two layers disagreeing about the same body is worse than
    either rule alone. That shared definition also settles the two shapes a
    hand-rolled rule kept getting wrong:

    * a **missing or null** ``error`` is success, not a block —
      ``{"data":"OK"}`` and ``{"data":[],"error":null,"retcode":0}`` are both
      real, healthy answers from the recon capture;
    * ``error == 0`` with an **empty list** is success with no rows —
      ``get_categories`` on a shop with no custom categories, or a keyword
      nothing matched. That is :data:`VERDICT_EMPTY`, never BLOCKED.

    Args:
        result: Result to annotate in place. ``status``, ``error``, ``error_msg``
            and ``items`` must already be filled in.
        payload: The decoded body, or None when the body was not a JSON object.
    """
    from scraper.client import has_v4_error, is_soft_block

    if payload is None:
        result.verdict = VERDICT_BLOCKED
        if not result.note:
            result.note = "body was not a JSON object (an HTML interstitial?)"
        return

    if is_soft_block(payload):
        result.verdict = VERDICT_BLOCKED
        if result.error == ANTIBOT_ERROR_CODE:
            # The status is reported, not assumed: the same refusal arrives as a
            # 200 from a browser-shaped session and as a 403 from raw httpx.
            served = (
                f"served with HTTP {result.status}"
                if result.status is not None
                else "no HTTP status"
            )
            result.note = (
                f"envelope error {result.error} — Shopee's anti-bot refusal ({served})"
            )
        elif result.error is not None or "error" in payload:
            result.note = (
                f"{_error_label(result, payload)} — a refusal envelope, "
                "not an endpoint error"
            )
        else:
            result.note = "Shopee's refusal envelope (no usable data, served with HTTP 200)"
        return

    if has_v4_error(payload):
        result.verdict = VERDICT_ERROR
        result.note = (
            f"{_error_label(result, payload)} — the endpoint's own error, not a block"
        )
        return

    if result.items <= 0:
        result.verdict = VERDICT_EMPTY
        result.note = "envelope reported success and carried no rows — an answer, not a refusal"
        return

    result.verdict = VERDICT_OK
    result.note = ""


def _run_probe(
    client: httpx.Client, probe: _EndpointProbe, targets: _ProbeTargets, session: Any
) -> _ProbeResult:
    """Issue one probe and classify its answer.

    Args:
        client: HTTP client to send with.
        probe: The endpoint to hit.
        targets: Current username/keyword/shop id.
        session: Session supplying cookies, UA and CSRF token.

    Returns:
        A fully populated :class:`_ProbeResult`. Never raises: a transport
        failure is itself a finding.
    """
    result = _ProbeResult(name=probe.name, method=probe.method, path=probe.path)
    referer = probe.referer(targets) if probe.referer else f"{SHOPEE_SITE}/"
    body = probe.body(targets) if probe.body else None
    params = probe.params(targets) if probe.params else None
    headers = _probe_headers(session, referer=referer, json_body=body is not None)

    try:
        response = client.request(
            probe.method,
            probe.path,
            params=params,
            json=body,
            headers=headers,
        )
    except httpx.HTTPError as exc:
        result.note = f"transport failure: {type(exc).__name__}: {exc}"
        _judge(result, None)
        return result

    result.status = response.status_code
    try:
        payload = response.json()
    except ValueError:
        result.note = "response body was not valid JSON (an HTML interstitial?)"
        _judge(result, None)
        return result
    if not isinstance(payload, dict):
        result.note = f"response body was a JSON {type(payload).__name__}, not an object"
        _judge(result, None)
        return result

    result.error = _envelope_error(payload)
    message = payload.get("error_msg")
    result.error_msg = str(message) if isinstance(message, str) else ""
    result.items = _count_items(payload)
    _judge(result, payload)

    if not targets.shop_id_discovered:
        discovered = _shop_id_from(payload)
        if discovered is not None:
            targets.shop_id = discovered
            targets.shop_id_discovered = True
    return result


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@app.command()
def bootstrap(
    force: bool = typer.Option(
        False, "--force", help="Re-mint cookies even if a valid jar already exists."
    ),
    login: bool = typer.Option(
        False, "--login/--no-login", help="Attempt an authenticated bootstrap. Requires credentials."
    ),
    headful: bool = typer.Option(
        False, "--headful", help="Show the browser. Use this to clear a challenge by hand."
    ),
) -> None:
    """Mint a fresh cookie jar with Playwright and write it to ``cookies.path``.

    Calls :meth:`scraper.session.ShopeeSession.bootstrap_cookies` and prints how
    many cookies were captured, whether the jar is authenticated, and where it
    landed. Cookie **values are never printed** — only names are inspected, and
    only to decide the authenticated flag. Run this once before the first
    ``run``; the client also self-heals mid-run, so manual bootstraps are
    normally only needed for debugging.

    Args:
        force: Ignore an existing valid jar.
        login: Force an authenticated bootstrap.
        headful: Override ``HEADLESS`` for this invocation only.

    Raises:
        typer.Exit: Code 2 if ``--login`` was passed without credentials, or if
            Chromium is not installed.
    """
    from scraper.session import ShopeeSession

    settings = _settings()
    if login and not settings.has_credentials:
        _fail("--login needs SHOPEE_USERNAME and SHOPEE_PASSWORD in .env")

    if headful:
        settings = settings.model_copy(update={"headless": False})

    session = ShopeeSession(settings)
    try:
        cookies = session.bootstrap_cookies(force=force, login=True if login else None)
    except ValueError as exc:
        _fail(str(exc))
        return
    except RuntimeError as exc:
        _fail(
            f"{exc}\nIf Chromium is missing, run: "
            ".venv/bin/python -m playwright install chromium"
        )
        return

    names = {str(cookie.get("name", "")) for cookie in cookies}
    authenticated = bool(names & _authenticated_cookie_names())

    table = Table(title="cookie bootstrap", header_style="bold")
    table.add_column("field")
    table.add_column("value")
    table.add_row("cookies captured", str(len(cookies)))
    table.add_row(
        "authenticated",
        "[green]yes[/green]" if authenticated else "[yellow]no (logged out)[/yellow]",
    )
    table.add_row("headless", str(settings.headless))
    table.add_row("jar path", str(session.cookies_path))
    console.print(table)

    if not cookies:
        _fail("bootstrap produced no cookies — re-run with --headful to see what happened")


@app.command()
def login(
    timeout: int = typer.Option(
        600, "--timeout", min=30, help="Seconds to wait for you to finish logging in."
    ),
    poll: float = typer.Option(
        2.0, "--poll", min=0.1, help="Seconds between cookie-jar checks while waiting."
    ),
) -> None:
    """Open a browser and wait while **you** log in; then keep the cookies.

    Shopee's search API answers a logged-out caller with HTTP 200 and a 119-byte
    ``{"error":90309999,...}`` refusal, and the page redirects to a "Masuk
    Diperlukan" login wall. This command is the way past it: a real Chromium
    window opens on the login page and the tool then does nothing but watch the
    cookie jar until a logged-in session cookie appears.

    **You type your own credentials.** This tool never sees, fills, stores or logs
    a username, password or OTP, never touches a CAPTCHA, and never asks you for a
    credential — it only reads cookie *names* out of the browser. On success it
    prints how many cookies were captured, whether the jar is authenticated and
    where it landed; cookie values are never printed.

    Run ``ecom-scraper doctor`` afterwards to see which endpoints the new jar
    unlocked.

    Args:
        timeout: Seconds to wait before giving up.
        poll: Seconds between cookie-jar checks.

    Raises:
        typer.Exit: Code 1 if the wait timed out, you cancelled, or the browser
            failed before the login could finish; code 2 if no visible browser
            could be opened at all.
    """
    from scraper.session import ManualLoginTimeout, ShopeeSession

    settings = _settings()
    session = ShopeeSession(settings)

    console.print(
        "[bold]Manual Shopee login[/bold]\n"
        "A real browser window is about to open on Shopee's login page.\n"
        "  · [bold]You[/bold] type your own username, password and any OTP. This tool "
        "never sees, types, saves or logs them, and will not touch a CAPTCHA.\n"
        "  · All it does is watch the browser's cookie jar and stop the moment a "
        "logged-in session cookie shows up.\n"
        f"  · It waits up to {timeout}s. Leave the window open until this command "
        "says it is done.\n"
        "  · Ctrl-C is safe at any point — the browser is always closed, and a "
        "cancelled login never overwrites the cookies you already have.\n"
    )

    try:
        cookies = session.manual_login(timeout_s=timeout, poll_s=poll)
    except ManualLoginTimeout as exc:
        _fail(str(exc), code=1)
        return
    except KeyboardInterrupt:
        _fail("manual login cancelled; the existing cookie jar is unchanged.", code=1)
        return
    except ValueError as exc:
        _fail(str(exc))
        return
    except RuntimeError as exc:
        _fail(str(exc))
        return
    except Exception as exc:  # noqa: BLE001 - a traceback is never the right answer here
        # Playwright's own errors (``playwright._impl._errors.Error`` and the
        # TimeoutError that subclasses it) are plain Exceptions: they are neither
        # RuntimeError nor ValueError, so without this arm a slow login page —
        # 45s nav timeout — or an unreachable host printed a raw stack trace
        # under a banner promising the browser is always closed.
        _fail(
            f"the manual login failed before you could finish ({type(exc).__name__}: {exc}). "
            "The browser has been closed and your existing cookie jar is unchanged. "
            "Check that you can reach Shopee in a normal browser, then re-run "
            "`ecom-scraper login`.",
            code=1,
        )
        return

    names = sorted({str(cookie.get("name", "")) for cookie in cookies} - {""})
    authenticated = bool(set(names) & _authenticated_cookie_names())

    table = Table(title="manual login", header_style="bold")
    table.add_column("field")
    table.add_column("value", overflow="fold")
    table.add_row("cookies captured", str(len(cookies)))
    table.add_row(
        "authenticated",
        "[green]yes[/green]" if authenticated else "[yellow]no (logged out)[/yellow]",
    )
    table.add_row("cookie names", escape(", ".join(names)) or "-")
    table.add_row("jar path", escape(str(session.cookies_path)))
    console.print(table)
    console.print(
        "[green]Saved.[/green] Cookie values were never printed or logged. "
        "Run [bold]ecom-scraper doctor[/bold] to see which endpoints this unlocked."
    )


@app.command()
def doctor(
    username: str = typer.Option(
        DOCTOR_DEFAULT_USERNAME, "--username", help="Shop slug the shop endpoints are probed with."
    ),
    keyword: str = typer.Option(
        DOCTOR_DEFAULT_KEYWORD, "--keyword", help="Search phrase search_items is probed with."
    ),
    shopid: int = typer.Option(
        DOCTOR_DEFAULT_SHOP_ID,
        "--shopid",
        help="Numeric shop id for get_shop_seo/get_categories. Overridden automatically "
        "when a shop probe reveals the id belonging to --username.",
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit machine-readable JSON instead."),
) -> None:
    """Probe every known endpoint with the saved cookies and report what works.

    Hits ``get_shop_base_v2``, ``get_shop_detail``, ``get_shop_seo``,
    ``get_categories`` and ``search_items`` exactly once each, a couple of seconds
    apart, using the jar at ``cookies.path`` exactly as it is on disk — no browser
    is launched and no cookie is re-minted, so the answer describes the session you
    actually have.

    **The verdict comes from the response envelope, never from the HTTP status.**
    A blocked Shopee endpoint replies ``200 OK`` with a 119-byte
    ``{"error":90309999,...}`` body; reading the status line would call that
    healthy. The four verdicts, with the reason printed under the table:

    * ``OK`` — the envelope reported success and carried rows;
    * ``EMPTY`` — success with nothing in it (a keyword nothing matched, a shop
      with no custom categories). The session works;
    * ``ERROR`` — the endpoint's own error, e.g. "shop not found". Fresh cookies
      cannot fix it;
    * ``BLOCKED`` — Shopee's refusal envelope, whatever status carried it. This
      is the only verdict that means "log in / re-bootstrap".

    ``BLOCKED`` is decided by :func:`scraper.client.is_soft_block`, the same
    function the scraper's transport uses, so doctor cannot disagree with the
    thing it is diagnosing.

    This is the command to run right after ``ecom-scraper login`` to see whether
    search actually unlocked.

    Args:
        username: Shop slug for the shop endpoints.
        keyword: Search phrase for ``search_items``.
        shopid: Shop id for the id-keyed endpoints.
        as_json: Emit JSON rather than a Rich table.

    Raises:
        typer.Exit: Code 2 if the configuration cannot be read.
    """
    from scraper.session import ShopeeSession

    settings = _settings()
    session = ShopeeSession(settings)
    jar = session.load_cookies()
    jar_names = sorted({str(cookie.get("name", "")) for cookie in jar} - {""})
    authenticated = bool(set(jar_names) & _authenticated_cookie_names())
    targets = _ProbeTargets(username=username.strip(), keyword=keyword.strip(), shop_id=shopid)

    if not as_json:
        console.print(
            f"probing with {len(jar)} saved cookie(s) from {escape(str(session.cookies_path))} "
            f"(authenticated: {'yes' if authenticated else 'no'})"
        )
        if not jar:
            console.print(
                "[yellow]no cookies on disk[/yellow] — run "
                "[bold]ecom-scraper login[/bold] (or bootstrap) first; probing logged out."
            )

    results: list[_ProbeResult] = []
    with httpx.Client(
        base_url=SHOPEE_SITE,
        http2=True,
        timeout=DOCTOR_TIMEOUT,
        follow_redirects=True,
    ) as client:
        for index, probe in enumerate(ENDPOINT_PROBES):
            if index:
                _pause_between_probes()
            results.append(_run_probe(client, probe, targets, session))

    if as_json:
        document = {
            "jar": {
                "path": str(session.cookies_path),
                "cookies": len(jar),
                "authenticated": authenticated,
                "names": jar_names,
            },
            "targets": {
                "username": targets.username,
                "keyword": targets.keyword,
                "shopid": targets.shop_id,
            },
            "probes": [result.as_dict() for result in results],
            "summary": {
                "ok": sum(1 for r in results if r.verdict == VERDICT_OK),
                "empty": sum(1 for r in results if r.verdict == VERDICT_EMPTY),
                "error": sum(1 for r in results if r.verdict == VERDICT_ERROR),
                "blocked": sum(1 for r in results if r.verdict == VERDICT_BLOCKED),
            },
        }
        typer.echo(jsonlib.dumps(document, indent=2))
        return

    table = Table(title="endpoint doctor", header_style="bold")
    table.add_column("endpoint")
    table.add_column("http status", justify="right")
    table.add_column("envelope error", justify="right")
    table.add_column("items found", justify="right")
    table.add_column("verdict")
    colours = {
        VERDICT_OK: "green",
        VERDICT_EMPTY: "yellow",
        VERDICT_ERROR: "yellow",
        VERDICT_BLOCKED: "red",
    }
    for result in results:
        colour = colours.get(result.verdict, "red")
        table.add_row(
            result.name,
            "-" if result.status is None else str(result.status),
            "-" if result.error is None else str(result.error),
            str(result.items),
            f"[{colour}]{result.verdict}[/{colour}]",
        )
    console.print(table)

    ok_count = sum(1 for r in results if r.verdict == VERDICT_OK)
    blocked_count = sum(1 for r in results if r.verdict == VERDICT_BLOCKED)
    console.print(
        f"[bold]{ok_count}/{len(results)} endpoint(s) usable[/bold], "
        f"{blocked_count} blocked · verdict is read from the response envelope, "
        "not the HTTP status"
    )
    for result in (r for r in results if r.verdict != VERDICT_OK):
        colour = colours.get(result.verdict, "red")
        console.print(f"  [{colour}]{result.name}[/{colour}]: {escape(result.note)}")


@app.command()
def run(
    mode: RunMode = typer.Option(..., "--mode", help="keyword: search phrases. store: shop listings."),
    keywords_file: Path = typer.Option(
        Path("config/keywords.txt"), "--keywords-file", help="Keyword list for --mode keyword."
    ),
    stores_file: Path = typer.Option(
        Path("config/stores.txt"), "--stores-file", help="Shop username list for --mode store."
    ),
    pages: int = typer.Option(1, "--pages", min=1, help="Result pages to walk per target."),
    target: list[str] = typer.Option(
        [],
        "--target",
        "--keyword",
        "--store",
        help="Scrape this target instead of reading the file. Repeatable. "
        "--keyword and --store are aliases of --target.",
    ),
    marketplace: Marketplace = typer.Option(
        Marketplace.SHOPEE, "--marketplace", help="Which marketplace to scrape."
    ),
) -> None:
    """Scrape every resolved target and persist snapshots to Postgres.

    Delegates wholly to :func:`scraper.runner.run`, then renders a Rich table of
    one row per target (target, status, items, duration, error) plus a totals
    line.

    Args:
        mode: keyword or store.
        keywords_file: Target file for keyword mode.
        stores_file: Target file for store mode.
        pages: Pages per target.
        target: Inline targets; when given, the file is not read.
        marketplace: Marketplace to scrape.

    Raises:
        typer.Exit: Code 1 when any target failed, code 2 on a missing target
            file, an empty target list, or an unimplemented marketplace.
    """
    from scraper import runner as runner_mod

    settings = _settings()
    try:
        result = runner_mod.run(
            mode,
            marketplace=marketplace,
            keywords_file=keywords_file,
            stores_file=stores_file,
            inline=list(target),
            pages=pages,
            settings=settings,
        )
    except FileNotFoundError as exc:
        _fail(f"{exc}\nCreate the file, or pass inline targets with --target.")
        return
    except ValueError as exc:
        _fail(str(exc))
        return
    except NotImplementedError as exc:
        _fail(f"marketplace '{marketplace.value}' has no adapter yet: {exc}")
        return

    table = Table(
        title=f"{marketplace.value} — {result.mode.value} mode, {pages} page(s) per target",
        header_style="bold",
    )
    table.add_column("target", overflow="fold")
    table.add_column("status")
    table.add_column("items", justify="right")
    table.add_column("duration", justify="right")
    table.add_column("error", overflow="fold")

    for scrape_run in result.runs:
        if scrape_run.started_at and scrape_run.finished_at:
            duration = f"{(scrape_run.finished_at - scrape_run.started_at).total_seconds():.1f}s"
        else:
            duration = "-"
        status = scrape_run.status.value
        table.add_row(
            scrape_run.target,
            f"[{_status_style(status)}]{status}[/{_status_style(status)}]",
            str(scrape_run.item_count),
            duration,
            (scrape_run.error or "")[:200],
        )
    console.print(table)

    ok_count = len(result.targets) - len(result.failed_targets)
    console.print(
        f"[bold]{ok_count}/{len(result.targets)} targets ok[/bold] · "
        f"{result.item_count} snapshots · {result.elapsed:.1f}s total"
    )

    if not result.ok:
        console.print(
            f"[yellow]failed targets:[/yellow] {', '.join(result.failed_targets)}"
        )
        raise typer.Exit(1)


@app.command()
def initdb() -> None:
    """Create the four tables. Idempotent — safe to re-run.

    Calls :func:`scraper.db.init_db`, then prints the tables that exist
    afterwards so the operator can see the schema landed.

    Raises:
        typer.Exit: Code 2 if Postgres is unreachable or ``DATABASE_URL`` is
            malformed. The message must include the host and database name (never
            the password) so the operator can fix their ``.env``.
    """
    from sqlalchemy import inspect

    from scraper import db

    settings = _settings()
    dsn = _safe_dsn(settings.database_url)

    try:
        db.init_db(settings.database_url)
        engine = db.get_engine(settings.database_url)
        tables = sorted(inspect(engine).get_table_names())
    except Exception as exc:  # noqa: BLE001 — every failure here is operator-fixable
        _fail(f"could not initialise {dsn}: {exc}")
        return

    table = Table(title=f"schema in {dsn}", header_style="bold")
    table.add_column("table")
    table.add_column("columns", justify="right")
    inspector = inspect(engine)
    for name in tables:
        table.add_row(name, str(len(inspector.get_columns(name))))
    console.print(table)
    console.print(f"[green]{len(tables)} table(s) ready.[/green]")


@app.command()
def stats(
    marketplace: Marketplace | None = typer.Option(
        None, "--marketplace", help="Restrict counts to one marketplace."
    ),
) -> None:
    """Print row counts and recency for the scraped data.

    Renders three Rich tables:

    1. per-marketplace counts — stores, products, snapshots, runs, last run and
       last snapshot times, plus the runs-by-status breakdown, from
       :func:`scraper.store.get_stats`;
    2. the most recent ``scrape_runs`` rows;
    3. the 10 most recent price changes — consecutive snapshots of one product
       whose price differs.

    Args:
        marketplace: Restrict to one marketplace, or None for all.

    Raises:
        typer.Exit: Code 2 if Postgres is unreachable.
    """
    from scraper import db, store as store_repo

    settings = _settings()
    dsn = _safe_dsn(settings.database_url)
    wanted = [marketplace] if marketplace else list(Marketplace)

    try:
        with db.session_scope(settings.database_url) as session:
            per_marketplace = {mp: store_repo.get_stats(session, marketplace=mp) for mp in wanted}
            overall = store_repo.get_stats(session) if marketplace is None else None
            recent_runs = store_repo.recent_runs(
                session, marketplace=marketplace, limit=RECENT_RUNS_LIMIT
            )
            recent_changes = store_repo.recent_price_changes(
                session, marketplace=marketplace, limit=RECENT_CHANGES_LIMIT
            )
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not read {dsn}: {exc}")
        return

    counts = Table(title=f"row counts — {dsn}", header_style="bold")
    counts.add_column("marketplace")
    for column in ("stores", "products", "snapshots", "runs"):
        counts.add_column(column, justify="right")
    counts.add_column("last run")
    counts.add_column("last snapshot")
    counts.add_column("runs by status", overflow="fold")

    def _row(label: str, data: dict[str, object]) -> None:
        by_status = data.get("runs_by_status") or {}
        rendered = (
            ", ".join(f"{k}={v}" for k, v in sorted(dict(by_status).items())) if by_status else "-"
        )
        counts.add_row(
            label,
            str(data.get("stores", 0)),
            str(data.get("products", 0)),
            str(data.get("snapshots", 0)),
            str(data.get("runs", 0)),
            _fmt_dt(data.get("last_run_at")),
            _fmt_dt(data.get("last_snapshot_at")),
            rendered,
        )

    for mp, data in per_marketplace.items():
        _row(mp.value, data)
    if overall is not None and len(per_marketplace) > 1:
        _row("[bold]all[/bold]", overall)
    console.print(counts)

    runs_table = Table(title=f"latest {RECENT_RUNS_LIMIT} scrape runs", header_style="bold")
    runs_table.add_column("started")
    runs_table.add_column("marketplace")
    runs_table.add_column("mode")
    runs_table.add_column("target", overflow="fold")
    runs_table.add_column("status")
    runs_table.add_column("items", justify="right")
    if recent_runs:
        for row in recent_runs:
            status = str(row.get("status") or "")
            item_count = row.get("item_count")
            runs_table.add_row(
                _fmt_dt(row.get("started_at")),
                str(row.get("marketplace") or "-"),
                str(row.get("mode") or "-"),
                str(row.get("target") or "-"),
                f"[{_status_style(status)}]{status}[/{_status_style(status)}]",
                str(item_count if item_count is not None else 0),
            )
    else:
        runs_table.add_row("-", "-", "-", "no runs recorded yet", "-", "-")
    console.print(runs_table)

    changes = Table(
        title=f"latest {RECENT_CHANGES_LIMIT} price changes", header_style="bold"
    )
    changes.add_column("observed")
    changes.add_column("shop", overflow="fold")
    changes.add_column("product", overflow="fold", max_width=48)
    changes.add_column("was", justify="right")
    changes.add_column("now", justify="right")
    changes.add_column("delta", justify="right")
    if recent_changes:
        for row in recent_changes:
            previous = row.get("previous_price")
            current = row.get("price")
            delta = "-"
            style = "white"
            if previous is not None and current is not None:
                diff = Decimal(str(current)) - Decimal(str(previous))
                pct = (diff / Decimal(str(previous)) * 100) if previous else Decimal(0)
                sign = "+" if diff > 0 else "-"
                style = "red" if diff > 0 else "green"
                delta = f"{sign}{_fmt_rupiah(abs(diff))} ({sign}{abs(pct):.1f}%)"
            changes.add_row(
                _fmt_dt(row.get("scraped_at")),
                str(row.get("username") or "-"),
                str(row.get("product_name") or "-"),
                _fmt_rupiah(previous),
                _fmt_rupiah(current),
                f"[{style}]{delta}[/{style}]",
            )
    else:
        changes.add_row("-", "-", "no price change observed yet", "-", "-", "-")
    console.print(changes)


def main() -> None:
    """Console-script entrypoint declared in ``pyproject.toml``.

    Thin wrapper so ``python -m scraper.cli`` and the ``ecom-scraper`` script
    behave identically.
    """
    app()


if __name__ == "__main__":
    main()
