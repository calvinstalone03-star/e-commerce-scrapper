"""Typer command-line interface.

Commands::

    ecom-scraper bootstrap [--force] [--login/--no-login] [--headful]
    ecom-scraper run --mode keyword|store [--keywords-file P] [--stores-file P]
                     [--pages N] [--target T ...] [--marketplace shopee]
    ecom-scraper initdb
    ecom-scraper stats [--marketplace shopee]

The CLI is a thin shell: it parses options, calls exactly one function in
:mod:`scraper.runner`, :mod:`scraper.session`, :mod:`scraper.db` or
:mod:`scraper.store`, and renders the result with Rich. No scraping, parsing or
SQL logic belongs in this module.

Exit codes: ``0`` success, ``1`` partial failure (some targets failed), ``2``
usage/configuration error. Typer raises :class:`typer.Exit` to set these.
"""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from scraper.models import Marketplace, RunMode

__all__ = ["app", "main", "console"]

app = typer.Typer(
    name="ecom-scraper",
    help="Scrape marketplace listings (Shopee first) into Postgres.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


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
    many cookies were captured and where they landed. Run this once before the
    first ``run``; the client also self-heals mid-run, so manual bootstraps are
    normally only needed for debugging.

    Args:
        force: Ignore an existing valid jar.
        login: Force an authenticated bootstrap.
        headful: Override ``HEADLESS`` for this invocation only.

    Raises:
        typer.Exit: Code 2 if ``--login`` was passed without credentials, or if
            Chromium is not installed.
    """
    raise NotImplementedError


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
        [], "--target", help="Scrape this target instead of reading the file. Repeatable."
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
    raise NotImplementedError


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
    raise NotImplementedError


@app.command()
def stats(
    marketplace: Marketplace | None = typer.Option(
        None, "--marketplace", help="Restrict counts to one marketplace."
    ),
) -> None:
    """Print row counts and recency for the scraped data.

    Calls :func:`scraper.store.get_stats` inside a read-only session and renders
    a Rich table: stores, products, snapshots, runs, last run time, last snapshot
    time, and a runs-by-status breakdown.

    Args:
        marketplace: Restrict to one marketplace, or None for all.

    Raises:
        typer.Exit: Code 2 if Postgres is unreachable.
    """
    raise NotImplementedError


def main() -> None:
    """Console-script entrypoint declared in ``pyproject.toml``.

    Thin wrapper so ``python -m scraper.cli`` and the ``ecom-scraper`` script
    behave identically.
    """
    raise NotImplementedError


if __name__ == "__main__":
    main()
