"""Vercel entrypoint for the ingest server.

The same FastAPI application the laptop runs — not a second implementation of
it. Everything this project knows about reading a Shopee or Tokopedia payload
lives in one Python parser shared by the CLI and the extension, and a hosted
copy that drifted from it would be worse than no hosted copy at all.

What differs is only where it runs, and `scraper.ingest` reads that off the
environment: on Vercel `/pair` is refused (it hands out a write credential and
is safe only over loopback) and the database engine stops pooling, because each
invocation is its own process and Neon's pooler is the thing that should be
holding connections.

Deployed as a **second** Vercel project whose root is this repository, so the
dashboard's own project — root `dashboard/`, and the thing people actually look
at — is untouched by any of it.
"""

from scraper.ingest import build_app

app = build_app()
