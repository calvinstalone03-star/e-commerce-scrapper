"""Typer command-line interface.

Commands::

    ecom-scraper bootstrap [--force] [--login/--no-login] [--headful]
    ecom-scraper run --mode keyword|store [--keywords-file P] [--stores-file P]
                     [--pages N] [--target T ...] [--marketplace shopee]
    ecom-scraper initdb
    ecom-scraper stats [--marketplace shopee]

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

from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import typer
from rich.console import Console
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

    Args:
        message: Operator-facing message. Must never contain a secret.
        code: Process exit code. Defaults to 2 (usage/configuration error).

    Raises:
        typer.Exit: Always.
    """
    console.print(f"[bold red]error:[/bold red] {message}")
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
