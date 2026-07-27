# ecom-scraper — Design Spec

Scrapes marketplace listings (Shopee Indonesia first, Tokopedia later) into
Postgres as a time series, so prices and sales velocity can be tracked over
repeated runs.

This document is the authority for cross-module behaviour. The module stubs are
the authority for exact signatures. Where they appear to disagree, the stub
docstring wins and this file should be corrected.

---

## 1. Hybrid architecture

Two transports, each doing what it is good at.

```
                  ┌──────────────────────────────────────────┐
                  │  scraper/session.py — ShopeeSession       │
   SLOW PATH      │  Playwright + Chromium                    │
   (once)         │  visit shopee.co.id, act human-ish,       │
                  │  harvest SPC_F / SPC_EC / csrftoken       │
                  └───────────────────┬──────────────────────┘
                                      │ cookies.json (gitignored)
                                      ▼
                  ┌──────────────────────────────────────────┐
                  │  scraper/client.py — ShopeeClient         │
   FAST PATH      │  httpx (http2) + tenacity                 │
   (every req)    │  inject Cookie + X-CSRFToken,             │
                  │  browser headers, random 2–5s delay       │
                  └───────────────────┬──────────────────────┘
                                      │ /api/v4/... JSON
                                      ▼
                  ┌──────────────────────────────────────────┐
                  │  scraper/adapters/shopee.py               │
                  │  raw JSON -> Store / Product / Snapshot   │
                  └───────────────────┬──────────────────────┘
                                      ▼
                     runner.py -> store.py -> Postgres
```

**Why hybrid.** Shopee's web frontend fetches its own `/api/v4/*` JSON
endpoints. Those endpoints are fast, paginated and structured — far better than
scraping rendered HTML. But they reject callers without a browser-minted cookie
set, and those cookies are produced by client-side anti-bot code we do not want
to reimplement. So: a real browser mints the session once (seconds), then plain
HTTP does thousands of requests against it (milliseconds each, plus the
deliberate delay).

**The 403 loop.** `ShopeeClient` is constructed with an `on_blocked` callback
that defaults to `session.bootstrap_cookies(force=True)`. On a 403, an HTML body
where JSON was expected, or a JSON block envelope, the client invokes the
callback **once**, then retries the request **once**. A second block raises
`BlockedError`, which the runner records as a FAILED `ScrapeRun` for that target
before continuing to the next one. This is the entire self-healing story — there
is no proxy rotation, no user-agent shuffling, no CAPTCHA solving.

**Sync, not async.** The whole package is synchronous. The anti-ban posture
mandates a single session with a 2–5 second gap between requests, so concurrency
would buy nothing while making delay accounting and single-flight re-bootstrap
harder to reason about. `pytest-asyncio` is installed and `asyncio_mode = "auto"`
is set purely so a future async adapter needs no harness change. Converting any
signature to `async def` requires changing the `MarketplaceAdapter` Protocol at
the same time.

---

## 2. Data model — four tables

Defined authoritatively in the module docstring of `scraper/db.py`;
`migrations/001_init.sql` must match it column for column.

| Table | Grain | Key |
|---|---|---|
| `stores` | one seller | unique `(marketplace, shop_id)` |
| `products` | one listing | unique `(marketplace, item_id)` |
| `price_snapshots` | one observation of one listing | append-only, index `(product_ref, scraped_at desc)` |
| `scrape_runs` | one target within one invocation | — |

```
stores(id serial pk, marketplace text, shop_id bigint, username text, name text,
       location text, follower_count int, rating_star numeric,
       first_seen timestamptz, last_seen timestamptz,
       unique(marketplace, shop_id))

products(id serial pk, marketplace text, item_id bigint,
         shop_ref int fk->stores(id), name text, url text, image text,
         category text, first_seen timestamptz, last_seen timestamptz,
         unique(marketplace, item_id))

price_snapshots(id bigserial pk, product_ref int fk->products(id),
                price numeric, price_min numeric, price_max numeric,
                stock int, sold int, historical_sold int,
                rating_star numeric, rating_count int, scraped_at timestamptz,
                index on (product_ref, scraped_at desc))

scrape_runs(id serial pk, marketplace text, mode text, target text,
            started_at timestamptz, finished_at timestamptz, status text,
            item_count int, error text)
```

Invariants:

- **Stable vs volatile is the whole point of the split.** A listing's title and
  URL live on `products` and are updated in place; its price, stock, sold count
  and rating live on `price_snapshots` and are only ever appended. Diffing two
  consecutive snapshots for a `product_ref` gives price movement and units sold
  in between.
- **`*_id` is theirs, `*_ref` is ours.** `shop_id` / `item_id` are the
  marketplace's numeric ids and form the natural keys. `shop_ref` / `product_ref`
  are our serial primary keys and are the only things used in foreign keys.
- **Timestamps are all `timestamptz`, always written as timezone-aware UTC** via
  `models.utcnow()`.
- **Money and ratings are `numeric` mapped to `Decimal`.** Never float. Shopee
  ships integer micro-units (`price * 100_000`); the adapter divides down.
- **Upserts never overwrite a non-null value with NULL.** A sparse search payload
  must not erase richer data a previous store-mode scrape recorded.
- **`scrape_runs` is one row per target, not per invocation.** A run over 3
  keywords writes 3 rows, so one bad keyword shows as one FAILED row without
  hiding the two that worked.

---

## 3. Keyword mode vs store mode

Both modes end at the same place — `ScrapedItem(store, product, snapshot)` —
and differ only in how targets are chosen and which endpoint is walked.

| | keyword mode | store mode |
|---|---|---|
| Target source | `config/keywords.txt` or `--target` | `config/stores.txt` or `--target` |
| Target looks like | `sepatu pria` | `erigostore` |
| Adapter method | `search_keyword(keyword, pages)` | `search_shop(username, pages)` |
| Endpoint | `/api/v4/search/search_items` | `/api/v4/recommend/recommend` (after `get_shop_base`) |
| Page size | 60, paginated by `newest` offset | 30, paginated by `offset` |
| Shop data | thin — often just `shopid`, sometimes no username | rich — one `get_shop` call reused for every item |
| Answers | "who sells this, at what price?" — market/competitor discovery | "what is this seller doing?" — competitor monitoring over time |

Target files use the same syntax: one entry per line, blank lines ignored, lines
starting with `#` ignored. `#` only starts a comment at the beginning of a line,
since Indonesian listing titles can contain one. `load_stores` additionally
tolerates a pasted `https://shopee.co.id/<username>` URL or a leading `@` and
strips them down to the bare slug.

Keyword mode's thin shop data is why upserts must not null out existing columns:
a keyword run that finds a product from a shop already scraped in store mode
must not blank that shop's name and follower count.

---

## 4. The five required output fields

The deliverable is a row per listing carrying these five. Each has exactly one
home:

| # | Field | Model | Column | Source |
|---|---|---|---|---|
| 1 | shop username | `Store.username` | `stores.username` | `get_shop_base` → `data.account.username`. In keyword mode may be absent on first sight and backfilled by a later store-mode run. |
| 2 | product name | `Product.name` | `products.name` | item payload `name` |
| 3 | price | `PriceSnapshot.price` | `price_snapshots.price` | item payload `price`, divided by 100 000 into whole rupiah. `price_min`/`price_max` carry the variation spread. |
| 4 | sold | `PriceSnapshot.sold` | `price_snapshots.sold` | item payload `sold` (recent window, ~30d). `historical_sold` holds lifetime. |
| 5 | rating star | `PriceSnapshot.rating_star` | `price_snapshots.rating_star` | item payload `item_rating.rating_star`. **Product** rating — distinct from `stores.rating_star`, which is the *shop's* rating. |

Fields 3–5 are on the snapshot precisely because they move; that is what makes
the dataset a time series rather than a catalogue. Reconstructing the flat
five-column view is a three-table join taking the latest snapshot per product:

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

A missing numeric means "not exposed by the marketplace", not zero. Adapters
leave it `None` rather than defaulting to `0`, so an absent rating is never
mistaken for a one-star product.

---

## 5. Anti-ban posture

Current, deliberate, and minimal:

- **Randomized delay before every request.** `random.uniform(MIN_DELAY,
  MAX_DELAY)`, default 2.0–5.0 seconds, applied in `ShopeeClient._random_delay`
  before *every* outbound request including retries. Never burst.
- **One session for the whole invocation.** The runner builds one adapter, one
  client and one cookie jar and reuses them across every target. A warm,
  long-lived, consistent session looks more like a human than a fresh identity
  per keyword.
- **Browser-shaped headers.** Realistic desktop Chrome `User-Agent`,
  `Accept-Language: id-ID`, `X-Requested-With: XMLHttpRequest`, `X-API-SOURCE:
  pc`, `Sec-Fetch-*`, and a plausible per-request `Referer` matching the page a
  human would have been on. HTTP/2 is enabled so the TLS/ALPN fingerprint is
  less obviously scripted.
- **Bounded retries.** Tenacity with exponential backoff plus jitter on
  transport errors and 429/5xx. Bounded — a blocked scraper that keeps hammering
  gets the IP banned rather than unbanned.
- **Exactly one re-bootstrap per request.** On block: re-mint cookies once, retry
  once, then give up on the target with `BlockedError`. No loops.
- **No proxies, yet.** Single egress IP. This is a size-appropriate choice for
  scraping a handful of keywords and shops on a schedule. Repeated
  `BlockedError`s across targets are the signal to first raise the delays, and
  only then consider a proxy pool — which would slot in as an `httpx` mount on
  `ShopeeClient` without touching any other module.
- **Logged out by default.** Public search and shop endpoints do not need a
  login, and an anonymous session cannot get an account banned. Credentials are
  optional and, when present, still degrade to the logged-out jar if login hits
  a CAPTCHA or OTP.
- **No CAPTCHA solving.** If a challenge blocks the bootstrap the tool says so
  and the operator re-runs with `HEADLESS=false` to clear it by hand.
- **Respect the shape of the data.** Only public listing data is collected; no
  buyer information, no accounts, no PII.

---

## 6. Tokopedia as a future adapter

`scraper/adapters/__init__.py` defines `MarketplaceAdapter` as a `Protocol` with
three methods — `search_keyword`, `search_shop`, `get_shop` — all returning the
marketplace-neutral `ScrapedItem` triple. Nothing downstream imports a concrete
adapter: the runner and CLI go through `adapters.get_adapter(marketplace)`.

Adding Tokopedia is therefore:

1. Write `scraper/adapters/tokopedia.py` with a `TokopediaAdapter` whose
   `marketplace = Marketplace.TOKOPEDIA`.
2. Add one entry to the registry in `get_adapter`.
3. Nothing else. The schema already carries `marketplace` on `stores`,
   `products` and `scrape_runs`, and both natural keys are already scoped by it,
   so two marketplaces coexist without collision.

Expected differences to absorb *inside* that adapter, not outside it: Tokopedia
serves a GraphQL API rather than REST paths, prices arrive as plain rupiah
rather than micro-units, and shop identity is a `shopDomain` string. All three
are exactly the kind of detail the Protocol exists to contain. The one open
question is whether Tokopedia needs its own session/bootstrap class — if so it
gets one, and `TokopediaAdapter` composes it the same way `ShopeeAdapter`
composes `ShopeeClient`.

---

## 7. Module ownership

| Module | Owns | Must not |
|---|---|---|
| `config.py` | env parsing, target file loading | know about HTTP or SQL |
| `models.py` | domain shapes | know any marketplace's payload |
| `db.py` | engine, session factory, ORM tables, schema truth | contain business logic |
| `store.py` | all writes to Postgres | commit (the caller owns transactions) |
| `session.py` | cookie minting via Playwright | make API calls |
| `client.py` | HTTP transport, delay, retry, re-bootstrap | parse payloads |
| `adapters/shopee.py` | Shopee URLs and payload parsing | touch the database |
| `runner.py` | orchestration, per-target error isolation | parse payloads or build SQL |
| `cli.py` | option parsing and Rich rendering | anything else |
