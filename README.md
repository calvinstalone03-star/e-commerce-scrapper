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

### Logged out is not enough any more: `ecom-scraper login`

`/api/v4/search/search_items` now answers a logged-out caller with **HTTP 200 and
a 119-byte `{"error":90309999,...}` refusal**, and the page behind it redirects to
a *Masuk Diperlukan* ("Login Required") wall. Requests fired from inside a real
browser page are fully signed by Shopee's own SDK and are refused all the same —
signing is not the gate, being logged in is.

```bash
ecom-scraper login                 # opens a window, waits up to 10 minutes
ecom-scraper login --timeout 1200  # wait longer at the keyboard
```

A real browser window opens on Shopee's login page and then the tool keeps its
hands off it:

- **You** type your own username, password and OTP, and clear your own CAPTCHA.
  This tool never sees, fills, types, saves or logs a credential, never touches a
  challenge, and never asks you for one. It has no way to log in for you.
- All it does is poll the browser's cookie jar every couple of seconds, printing
  a heartbeat with the time left, and stop the moment a logged-in session cookie
  (`SPC_EC` / `SPC_ST`) appears.
- It then loads the homepage once so the jar settles, and saves it through the
  same `0600` path `bootstrap` uses — same envelope, same recorded user agent.

Ctrl-C is safe at any point: the browser is always closed, and a cancelled or
timed-out login never overwrites cookies you already have. Cookie **names** are
printed, values never are. `--headless` is not an option here and `HEADLESS` is
ignored — a login nobody can see is a contradiction.

### When the CAPTCHA will not let you in: `ecom-scraper import-cookies`

`login` frequently dead-ends. Playwright's Chromium is automation-flagged, so
Shopee escalates its login to a puzzle CAPTCHA that browser may never accept, no
matter how many times you solve it correctly. That is not a bug here and it is
not something this project will try to defeat.

The way through is to not be in that browser. Log into Shopee **normally, in
your own everyday browser** — clearing any challenge yourself, by hand, as a
person — then hand the resulting session over:

```bash
ecom-scraper import-cookies cookies.txt --user-agent "$(: paste navigator.userAgent )"
ecom-scraper import-cookies storage_state.json     # Playwright shape
pbpaste | ecom-scraper import-cookies -            # a raw "Cookie:" header
```

The challenge still gets cleared; it just gets cleared by a human in a normal
browser instead of by code in an automated one.

Four export shapes are accepted, sniffed from the content, not the extension:
Netscape `cookies.txt` (curl/wget and the "Get cookies.txt" extensions), a
Cookie-Editor / EditThisCookie JSON array, a Playwright `storage_state` file, or
a raw `Cookie:` header line copied off the Network tab.

Two things worth knowing before you export:

- **Use a `cookies.txt` exporter, not `document.cookie`.** The session cookies
  are `HttpOnly`, so a devtools copy of `document.cookie` silently omits exactly
  the ones that matter. The command refuses an export with no `SPC_EC`/`SPC_ST`
  rather than importing a jar that cannot work — pass `--allow-logged-out` if you
  really want it anyway.
- **Pass `--user-agent`.** Shopee compares the UA against the one that minted the
  session, and a mismatch reads as a hijacked jar. Run `navigator.userAgent` in
  the console of the browser you exported from and paste that.

Only `shopee.co.id` cookies are kept; the analytics and ad-network entries in a
browser export are dropped. The jar is written `0600` and marked as imported,
which makes every later bootstrap **refuse to replace it** — otherwise the
client's block-recovery path would swap your logged-in session for a fresh
anonymous one and every subsequent scrape would quietly run logged out. When
Shopee starts refusing an imported jar, it has expired: log in again in your
browser and re-import.

### The collector extension — Shopee and Tokopedia

Keyword search stays closed to this project's HTTP client no matter what. Four
hypotheses were tested and disproven: request signing (in-page requests *are*
fully SDK-signed and still refused), being logged out, session credentials (a
live logged-in jar behaves identically), and an automation-flagged browser (real
Chrome over CDP hits the same gate). What is left is an anti-bot CAPTCHA, and
this project does not solve it, work around it, or hand it to a solver service.

What *is* available is the rendered page. Both sites build their results
client-side — Shopee's search HTML is 157KB of app shell with zero listings in
it, Tokopedia's is 598KB without a single `Rp` — so the extension reads the DOM
after the browser has rendered it. That is also the copy the user can see, which
means a wrong result is visibly wrong.

```bash
ecom-scraper serve          # prints the ingest token
```

Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** →
`extension/`. Open the popup, click the gear, paste the token, Save.

Then type a keyword, set **jumlah produk**, and press **Mulai scrape**. The
extension opens the search, waits for the grid to actually render, scrolls it so
the lazily-rendered rows exist, files what it read, and moves to the next result
page — repeating until it has the number of products you asked for, the results
run out, or you press **Batal**. Leave the keyword empty to scrape only what the
tab is currently showing (that is the mode a shop page gets, since a shop page
has no search term to paginate); if the tab is already on a search, its keyword
is pre-filled.

Counting is by distinct product, so the repeats both sites sprinkle between
pages do not inflate the total, and the last page is trimmed rather than
overshot: asking for 100 files 100.

Fill in **toko** as well and the run walks that shop's own product grid instead
of the site's search results, on either marketplace. The box takes a username, a
pasted storefront URL, or the shop's display name — a display name is only a
guess at a slug, so each site's plausible spellings are tried in order and
whichever storefront answers with products is the one used. A keyword alongside
a shop becomes a filter on the product name: every word has to appear, and the
filter runs here rather than being left to the site's in-shop search, so it
holds whether or not that front end honours the parameter. The result line says
how many were dropped, because "3 produk" without "412 tidak cocok" reads as a
broken scrape. A shop grid's URL carries no search term, so shop mode states the
keyword outright and `product_keywords` is recorded the same as for a search.

| toko | kata kunci | what runs |
|---|---|---|
| — | `lego` | site search for "lego", paginated |
| `tokomainanku` | — | that shop's whole grid |
| `tokomainanku` | `lego` | that shop's grid, kept where the name matches |
| — | — | just the page the tab is showing |

Two things the page decides for you. A product name is read from the image's
`alt` only when that alt is a name: Tokopedia labels every listing image
`alt="product-image"`, so names there come from the card's own text instead.
And a seller is recorded only where the page states one — Tokopedia's URL
carries the shop slug, but a Shopee **search** card carries price, sold, rating
and a city and no seller at all, which is why Shopee stores collected from
search read `shop-<id>` with no name. To put real names on them, scrape the
shop's own page (`shopee.co.id/<username>`): there the URL is the username and
the title is the display name, and both are attached to every card on the page
that keys on that shop. Names fill in on re-scrape, so an existing row is
corrected rather than duplicated.

The job lives in the service worker, not the popup — closing the popup does not
stop it, and re-opening re-attaches to the run in progress. It is still
user-triggered: nothing runs on a timer, and the only requests made to the
marketplace are the page loads a person clicking through results would make.

| File | Job |
|---|---|
| `extension/sites.js` | Per-marketplace config: hosts, product-link shape, and how the site numbers result pages (Shopee from 0, Tokopedia from 1). |
| `extension/dom-scraper.js` | Generic extractor: wait for the first card, scroll the grid, find product links, walk out to the card, read the text. |
| `extension/background.js` | Owns the job — navigate, scrape, POST, next page — and streams progress to the popup. |
| `scraper/ingest.py` | Turns cards into rows, reusing `models.parse_sold` rather than a second copy in JS. |

The one genuinely site-specific piece is how a product link identifies itself:

```
Shopee     /<slug>-i.<shopId>.<itemId>   both ids sit in the URL
Tokopedia  /<shopSlug>/<productSlug>     no numeric ids anywhere
```

So links yield string keys and the server resolves them: numeric ones pass
through unchanged (keeping Shopee ids matching rows the API and scraping paths
wrote), slugs go through `stable_id`, a truncated BLAKE2b. Not `hash()` — that is
salted per process and would mint a fresh id, and therefore a fresh product row,
on every server restart, forking each listing's price history.

Guards: loopback bind, shared token compared with `compare_digest`, and an
unknown `marketplace` is a 422 rather than a silent default.

Product image URLs come along with everything else, in `products.image`. They
are stored as the CDN base URL and are directly usable — no referer header, no
token. Shopee's CDN takes a size suffix, which matters more than it sounds:

```
<url>            467 KB  JPEG   full size
<url>_tn          40 KB  JPEG   thumbnail
<url>_tn.webp     28 KB  WebP   thumbnail
```

A 60-product grid is ~28 MB at full size and ~1.7 MB with `_tn.webp`. The base
URL is what gets stored, so append the suffix at render time and full resolution
stays one string concatenation away.

Its honest limit: it collects only what you actually browse. No browsing, no
data, and nothing to schedule.

### Did that actually unlock anything? `ecom-scraper doctor`

```bash
ecom-scraper doctor                      # human-readable table
ecom-scraper doctor --json               # machine-readable
ecom-scraper doctor --username erigostore --keyword "sepatu pria"
```

Probes the five known endpoints once each, a few seconds apart, using the jar on
disk exactly as it is — no browser is launched, no cookie is re-minted.

```
                          endpoint doctor
┏━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━┳━━━━━━━━━┓
┃ endpoint         ┃ http status ┃ envelope error ┃ items found ┃ verdict ┃
┡━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━╇━━━━━━━━━┩
│ get_shop_base_v2 │         200 │              0 │           1 │ OK      │
│ get_shop_detail  │         200 │              0 │           1 │ OK      │
│ get_shop_seo     │         200 │              0 │           1 │ OK      │
│ get_categories   │         200 │              0 │          20 │ OK      │
│ search_items     │         200 │       90309999 │           0 │ BLOCKED │
└──────────────────┴─────────────┴────────────────┴─────────────┴─────────┘
4/5 endpoint(s) usable, 1 blocked · verdict is read from the response envelope, not the HTTP status
  search_items: envelope error 90309999 — Shopee's anti-bot refusal (served with HTTP 200)
```

**The verdict comes from the payload envelope, never from the status line** — as
the last row shows, a refusal arrives as `200 OK`. Four verdicts:

| verdict | means |
| --- | --- |
| `OK` | success, with rows |
| `EMPTY` | success with nothing in it — a keyword nothing matched, a shop with no custom categories. The session works |
| `ERROR` | the endpoint's own error ("shop not found"). Fresh cookies cannot fix it |
| `BLOCKED` | Shopee's refusal envelope, whatever status carried it. **The only verdict that means "log in / re-bootstrap"** |

`BLOCKED` is decided by the same `scraper.client.is_soft_block` the scraper's
transport uses, so `doctor` cannot disagree with the thing it is diagnosing — and
an empty-but-successful answer is never reported as a block. Run it right after
`login` to see whether search opened up.

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
| `0` | Success — every target scraped (`doctor` always exits `0`; read the verdicts) |
| `1` | Partial failure — some targets failed (`run`), or the manual `login` timed out or was cancelled |
| `2` | Usage or configuration error — missing file, empty target list, unreachable Postgres, missing credentials, no window available for `login` |

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
| `COOKIES_PATH` | `cookies.json` | Where the cookie jar is persisted. Always written `0600`; `.gitignore` covers `*cookies*.json`, so a path outside that pattern is yours to add |

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
