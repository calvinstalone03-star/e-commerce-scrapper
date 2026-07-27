# ecom-scraper

Scrapes marketplace listings (Shopee Indonesia now, Tokopedia later) into
Postgres as a **time series**, so price movement and sales velocity can be
tracked across repeated runs.

Hybrid architecture: Playwright mints a real browser cookie session once, then
httpx walks the marketplace's own JSON API fast. A 403 re-mints the cookies once
and retries. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full spec.

## Install

```bash
git clone <this repo> ecom-scraper && cd ecom-scraper

uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m playwright install chromium

cp .env.example .env      # then edit DATABASE_URL if yours differs
```

Everything below assumes the venv is on your PATH:

```bash
source .venv/bin/activate
```

If you would rather not activate it, prefix every command with
`.venv/bin/` — `.venv/bin/ecom-scraper stats` works identically. Running
`python -m scraper.cli ...` is also equivalent to the `ecom-scraper` script.

## 1. Create the database and the schema

```bash
createdb ecom_scraper           # or point DATABASE_URL at an existing database
ecom-scraper initdb
```

`initdb` applies `migrations/*.sql` (falling back to the ORM metadata if the
migrations directory is empty), then prints what exists afterwards:

```
        schema in postgresql://calvin@127.0.0.1:5432/ecom_scraper
┏━━━━━━━━━━━━━━━━━┳━━━━━━━━━┓
┃ table           ┃ columns ┃
┡━━━━━━━━━━━━━━━━━╇━━━━━━━━━┩
│ price_snapshots │      11 │
│ products        │      10 │
│ scrape_runs     │       9 │
│ stores          │      10 │
└─────────────────┴─────────┘
4 table(s) ready.
```

It is idempotent — re-running it is the recovery path, not a mistake. On a
connection failure it exits `2` and prints the host and database name (never the
password) so you can fix `.env`.

## 2. Mint a cookie jar

```bash
ecom-scraper bootstrap            # reuse a valid jar if one exists
ecom-scraper bootstrap --force    # always re-mint
ecom-scraper bootstrap --headful  # watch the browser, clear a challenge by hand
```

Prints how many cookies were captured, whether the jar is authenticated, and
where it landed. **Cookie values are never printed or logged** — only names are
inspected, and only to decide the authenticated flag.

```
       cookie bootstrap
┏━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━┓
┃ field            ┃ value           ┃
┡━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━┩
│ cookies captured │ 21              │
│ authenticated    │ no (logged out) │
│ headless         │ True            │
│ jar path         │ cookies.json    │
└──────────────────┴─────────────────┘
```

Logged out is the default and supported posture. `--login` requires
`SHOPEE_USERNAME` and `SHOPEE_PASSWORD` in `.env` and exits `2` without them.
You rarely need to run this by hand: the client re-bootstraps itself once when it
gets blocked mid-run.

## 3. Run — keyword mode

"Who sells this, and at what price?" Walks `search_items` for each phrase.

```bash
# every keyword in config/keywords.txt, 2 result pages each
ecom-scraper run --mode keyword --keywords-file config/keywords.txt --pages 2

# ad-hoc keywords; --keyword is repeatable and overrides the file entirely
ecom-scraper run --mode keyword --keyword "sepatu pria" --keyword "tas kulit"
```

## 4. Run — store mode

"What is this seller doing?" Resolves each username to a shop id, then walks that
shop's listings.

```bash
# every shop in config/stores.txt, 5 listing pages each
ecom-scraper run --mode store --stores-file config/stores.txt --pages 5

# ad-hoc shops; --store is repeatable and overrides the file
ecom-scraper run --mode store --store erigostore --store eigerindostore
```

`--target`, `--keyword` and `--store` are three spellings of the same repeatable
option — use whichever reads better for the mode you are in. A pasted
`https://shopee.co.id/erigostore` or `@erigostore` is normalised to the bare slug.

Either mode prints one row per target plus a totals line:

```
      shopee — keyword mode, 2 page(s) per target
┏━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━┳━━━━━━━━━━┳━━━━━━━┓
┃ target        ┃ status  ┃ items ┃ duration ┃ error ┃
┡━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━╇━━━━━━━━━━╇━━━━━━━┩
│ sepatu pria   │ success │   118 │    31.4s │       │
│ tas wanita    │ success │    97 │    28.9s │       │
└───────────────┴─────────┴───────┴──────────┴───────┘
2/2 targets ok · 215 snapshots · 60.3s total
```

**One failing target never stops the others.** Each target runs in its own
transaction and writes its own `scrape_runs` row, so a blocked keyword shows up
as one `failed` row while the rest still commit.

Options common to both modes:

| Option | Default | Meaning |
|---|---|---|
| `--mode` | _(required)_ | `keyword` or `store` |
| `--pages` | `1` | Result pages to walk per target |
| `--keywords-file` | `config/keywords.txt` | Keyword list for keyword mode |
| `--stores-file` | `config/stores.txt` | Shop list for store mode |
| `--target` / `--keyword` / `--store` | _(none)_ | Repeatable inline target; overrides the file |
| `--marketplace` | `shopee` | Which marketplace to scrape |

## 5. Inspect what you have

```bash
ecom-scraper stats                      # all marketplaces
ecom-scraper stats --marketplace shopee # just one
```

Three tables: per-marketplace row counts with last-run/last-snapshot recency and
a runs-by-status breakdown; the ten latest `scrape_runs`; and the ten most recent
**price changes** — consecutive snapshots of the same listing whose price moved.

```
                            latest 10 price changes
┏━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━━━━┳━━━━━━━━━━━━┳━━━━━━━━━━━━━┓
┃ observed            ┃ shop       ┃ product      ┃        was ┃        now ┃       delta ┃
┡━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━━━━╇━━━━━━━━━━━━╇━━━━━━━━━━━━━┩
│ 2026-07-27 12:36:19 │ erigostore │ Chino Pants  │ Rp 152.900 │ Rp 129.000 │  -Rp 23.900 │
│                     │            │              │            │            │    (-15.6%) │
└─────────────────────┴────────────┴──────────────┴────────────┴────────────┴─────────────┘
```

That table is empty until a listing has been scraped at least twice — which is
the whole point of the design: rerun on a schedule and the time series builds
itself.

The flat five-column view (`username`, `name`, `price`, `sold`, `rating_star`) is
a three-table join taking the latest snapshot per product:

```sql
SELECT s.username, p.name, ps.price, ps.sold, ps.rating_star
FROM products p
JOIN stores s ON s.id = p.shop_ref
JOIN LATERAL (
    SELECT * FROM price_snapshots
    WHERE product_ref = p.id
    ORDER BY scraped_at DESC LIMIT 1
) ps ON true;
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — every target scraped |
| `1` | Partial failure — some targets failed (`run` only) |
| `2` | Usage or configuration error — missing file, empty target list, unreachable Postgres, missing credentials |

Suitable for cron: `1` means "look at the log", `2` means "the setup is broken".

## Configuration

All settings come from the environment, backed by `.env` (see `.env.example`).
Real environment variables win over `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://calvin@127.0.0.1:5432/ecom_scraper` | Postgres connection |
| `SHOPEE_USERNAME` | _(unset)_ | Optional. Bootstrap stays logged out when unset |
| `SHOPEE_PASSWORD` | _(unset)_ | Optional |
| `HEADLESS` | `true` | Set `false` to watch the bootstrap or clear a challenge |
| `MIN_DELAY` | `2.0` | Lower bound of the per-request random delay, seconds |
| `MAX_DELAY` | `5.0` | Upper bound. Must be >= `MIN_DELAY` or startup fails |
| `COOKIES_PATH` | `cookies.json` | Where the cookie jar is persisted (gitignored) |

Target files (`config/keywords.txt`, `config/stores.txt`): one entry per line,
blank lines and `#` comment lines ignored, duplicates collapsed. A `#` only
starts a comment at the beginning of a line, since Indonesian listing titles can
contain one.

## Scheduling

Nothing about the tool is stateful between runs beyond the database and the
cookie jar, so cron is enough:

```cron
# every morning at 06:00, refresh both modes
0 6 * * * cd /path/to/ecom-scraper && .venv/bin/ecom-scraper run --mode store  --pages 5 >> logs/store.log 2>&1
30 6 * * * cd /path/to/ecom-scraper && .venv/bin/ecom-scraper run --mode keyword --pages 3 >> logs/keyword.log 2>&1
```

Budget the wall clock: every request sleeps `MIN_DELAY`–`MAX_DELAY` seconds, so
~60 listings per page at 2–5s per request is minutes, not seconds. That pacing is
the anti-ban posture, not an accident — do not tune it to zero.

## How to add a marketplace

Everything downstream of the adapter is marketplace-neutral: `stores`,
`products` and `scrape_runs` all carry a `marketplace` column and both natural
keys are scoped by it, so two marketplaces coexist without collision. Adding one
is three steps and touches no existing module's logic.

**1. Write the adapter.** Create `scraper/adapters/<name>.py` with a class
implementing the `MarketplaceAdapter` Protocol from
[`scraper/adapters/__init__.py`](scraper/adapters/__init__.py):

```python
class TokopediaAdapter:
    marketplace: Marketplace = Marketplace.TOKOPEDIA

    def search_keyword(self, keyword: str, pages: int = 1) -> list[ScrapedItem]: ...
    def search_shop(self, username: str, pages: int = 1) -> list[ScrapedItem]: ...
    def get_shop(self, username: str) -> Store: ...
```

All three return the `ScrapedItem(store, product, snapshot)` triple built from
`scraper.models`. The rules the runner relies on:

- leave `first_seen` / `last_seen` / `scraped_at` as `None` — the repository
  stamps them;
- convert prices to whole rupiah `Decimal` inside the adapter (Shopee ships
  integer micro-units; Tokopedia ships a preformatted `"Rp1.500.000"` string —
  both are the adapter's problem, nobody else's);
- **skip, do not raise, on a single malformed item** — one bad entry in a page of
  60 must not lose the other 59;
- let `BlockedError` propagate so the runner can fail that one target cleanly;
- a missing number is `None`, never `0`;
- if your parser has to invent a `Store.username` because the payload carries no
  slug, publish an `is_placeholder_username(username)` predicate at module level.
  The runner looks it up by convention and will then not waste a request trying
  to resolve a slug you made up.

**2. Register it.** Add one entry to the registry in `adapters.get_adapter`.
That is the only place mapping an enum member to an implementation — the runner
and the CLI never import a concrete adapter.

**3. Add the enum member** to `Marketplace` in `scraper/models.py` if it is not
there already. Its *value* is what lands in the `marketplace` text column, so it
is part of the database contract and must not be renamed later.

Then it just works: `ecom-scraper run --mode keyword --marketplace tokopedia`.

If the new marketplace needs its own cookie/session story, give it its own
session class and have the adapter compose it, exactly as `ShopeeAdapter`
composes `ShopeeClient`. Nothing outside `scraper/adapters/` should learn about it.

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
migrations/    001_init.sql (must match db.py)
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
- **Upserts never overwrite a non-null value with NULL** — a sparse keyword-search
  payload must not erase richer data an earlier store-mode run recorded.

## Testing

```bash
.venv/bin/pytest
```

HTTP is mocked with `respx`; no test hits the network or launches a browser.
`tests/test_runner.py` additionally exercises the orchestration against a real
local Postgres when one is reachable — set `TEST_DATABASE_URL` to point it
somewhere (default `postgresql://calvin@127.0.0.1:5432/ecom_scraper_test`). Those
tests skip cleanly when Postgres is unavailable, and they only ever touch rows
they created themselves, so they are safe to run against a shared test database.
