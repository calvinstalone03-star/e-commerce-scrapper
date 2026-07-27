"""ecom-scraper — marketplace product/price scraper.

Architecture (see docs/DESIGN.md for the full spec):

    Playwright  ->  bootstraps a real browser session, harvests cookies to disk
    httpx       ->  fast JSON loop against the marketplace's own internal API
    403/blocked ->  callback re-bootstraps cookies once, then the request retries

Package layout:

    scraper.config    Settings + keyword/store file loaders
    scraper.models    Pydantic v2 domain models (the wire/DB contract)
    scraper.db        SQLAlchemy engine, session factory, ORM tables
    scraper.store     Repository functions (all take an explicit Session)
    scraper.session   ShopeeSession — Playwright cookie bootstrap/load/save
    scraper.client    ShopeeClient — httpx wrapper with retry + delay + re-auth
    scraper.adapters  MarketplaceAdapter Protocol + per-marketplace impls
    scraper.runner    Orchestrates a scrape run end to end
    scraper.cli       Typer entrypoint

Every module in this package is currently a stub. Signatures, type annotations
and docstrings are the contract; only the bodies are missing.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
