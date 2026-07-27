# ecom-scraper

Scrapes marketplace listings (Shopee Indonesia now, Tokopedia later) into
Postgres as a **time series**, so price movement and sales velocity can be
tracked across repeated runs.

Hybrid architecture: Playwright mints a real browser cookie session once, then
httpx walks the marketplace's own JSON API fast. A 403 re-mints the cookies once
and retries. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full spec.

## Status

**Scaffold.** Every module under `scraper/` is a stub: complete imports, complete
type-annotated signatures, complete docstrings, `raise NotImplementedError`
bodies. The signatures are the contract — fill in bodies, do not change
signatures without updating `docs/DESIGN.md` in the same commit.

## Setup

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m playwright install chromium

cp .env.example .env      # then edit DATABASE_URL
createdb ecom_scraper     # or point DATABASE_URL at an existing database
.venv/bin/ecom-scraper initdb
```

## Usage

```bash
# mint cookies (once; the client also self-heals mid-run)
ecom-scraper bootstrap

# keyword mode — who sells this, at what price
ecom-scraper run --mode keyword --keywords-file config/keywords.txt --pages 3

# store mode — what is this seller doing
ecom-scraper run --mode store --stores-file config/stores.txt --pages 5

# ad-hoc target, no file
ecom-scraper run --mode keyword --target "sepatu pria" --pages 2

# row counts and recency
ecom-scraper stats
```

Exit codes: `0` success, `1` some targets failed, `2` usage/config error.

## Configuration

All settings come from `.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://calvin@127.0.0.1:5432/ecom_scraper` | Postgres connection |
| `SHOPEE_USERNAME` | _(unset)_ | Optional. Bootstrap stays logged out when unset |
| `SHOPEE_PASSWORD` | _(unset)_ | Optional |
| `HEADLESS` | `true` | Set `false` to watch the bootstrap or clear a challenge |
| `MIN_DELAY` | `2.0` | Lower bound of the per-request random delay, seconds |
| `MAX_DELAY` | `5.0` | Upper bound |

Target files (`config/keywords.txt`, `config/stores.txt`): one entry per line,
blank lines and `#` comment lines ignored.

## Layout

```
scraper/
  config.py    Settings + keyword/store loaders
  models.py    Pydantic v2 domain models — the contract
  db.py        Engine, session factory, ORM tables, schema truth
  store.py     Repository writes (never commits; caller owns the transaction)
  session.py   ShopeeSession — Playwright cookie bootstrap
  client.py    ShopeeClient — httpx + delay + retry + re-bootstrap
  adapters/    MarketplaceAdapter Protocol + shopee.py
  runner.py    Orchestration, continue-on-error per target
  cli.py       Typer commands: bootstrap, run, initdb, stats
migrations/    001_init.sql (placeholder; must match db.py)
docs/DESIGN.md Full design spec
tests/         One test module per build agent
```

## Conventions

- **Sync, not async.** Deliberate — the anti-ban posture is one session with a
  2–5s gap between requests, so concurrency buys nothing.
- **`*_id` is the marketplace's, `*_ref` is ours.** `shop_id`/`item_id` are
  natural keys; `shop_ref`/`product_ref` are our serial PKs.
- **Money and ratings are `Decimal`**, never float. Shopee's integer micro-prices
  are divided by 100 000 inside the adapter.
- **All timestamps are timezone-aware UTC** via `models.utcnow()`.
- **Parsing lives in the adapter**, never in `models.py`, never in `client.py`.
- **A missing number is `None`, not `0`.**

## Testing

```bash
.venv/bin/pytest
```

HTTP is mocked with `respx`; no test may hit the network or a real Shopee
endpoint.
