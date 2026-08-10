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

Fill in **toko** as well and the run walks that shop's products instead of the
site's search results, on either marketplace. The box takes a username, a pasted
storefront URL, or the shop's display name — a display name is only a guess at a
slug, so each site's plausible spellings are tried in order (`lego indonesia` →
`legoindonesia`, `lego.indonesia`, `lego-indonesia`, `lego_indonesia`) and
whichever storefront answers with products is the one used.

With a keyword, the two sites are asked for their in-shop search in quite
different ways. Tokopedia keys everything on the slug already typed, so
`/<toko>/product?q=lego` is one page load.

Shopee's in-shop search is not a storefront route at all — it is the search page
filtered by numeric shop id, `/search?keyword=lego&shop=490338801` for an
ordinary shop and `/mall/search?…` for a Mall one — and the storefront does not
say which kind it is. So the term is typed into the shop's own "cari di toko
ini" box and Shopee navigates wherever it navigates; the address it lands on is
a real in-shop search by construction, and it becomes the template every later
page is built from. Building that address by hand is only the fallback, ordered
by whether the page wears Mall branding, because a wrong guess returns no
results — indistinguishable from a shop that does not stock the term, and
walking that emptiness page by page is what a run did before.

Either way a page counts only when the shop ids come back matching: a `shop`
filter that was ignored returns the whole marketplace, which would otherwise
look like a successful scrape of the wrong shop. If nothing answers, the shop's
catalogue is walked instead and the keyword filter below does the work — over
more pages, but over the right products.

A storefront opens on its home tab, which is vouchers, banners and a "kamu
mungkin suka" strip rather than the shop's catalogue, so a keyword-less run
clicks through to **Produk** first and pages that. The numeric shop id and the
shop's display name are read from the storefront either way.

That filter is a filter on the product name: every word has to appear, give or
take a couple of letters at the end of longer words, since a shopper types
"dinosaurus" and the seller wrote "Dinosaur". It runs only where this side is
the one matching — walking a catalogue. Results the site's own search returned
are kept as they came: a search for "dinosaurus" answers with "Jurassic World
76950 Triceratops", and re-checking that against the literal word discards the
row the shopper was looking for. The result line says how many were dropped,
because "3 produk" without "412 tidak cocok" reads as a broken scrape. Neither
shop route carries a search term the server can read back, so shop mode states
the keyword outright and `product_keywords` is recorded the same as for a
search.

Shop mode is also how a Shopee row gets a seller name. The storefront states the
shop's name and username; the shop-filtered search page does not state a seller
at all, so the job carries what the storefront said onto the rows whose shop id
matches — and only those, since a sponsored card from elsewhere must not be
filed under this shop.

| toko | kata kunci | what runs |
|---|---|---|
| — | `lego` | site search for "lego", paginated |
| `tokomainanku` | — | that shop's **Produk** tab, paginated |
| `tokomainanku` | `lego` | that shop's in-shop search, kept where the name matches |
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

#### Which database a run files into

**Lokal** / **Neon**, above the scrape button. Lokal is Postgres on this laptop;
Neon is the hosted database the deployed dashboard reads (section 7). The totals
under the button are counted in whichever is selected, which is the quickest way
to see how far apart the two have drifted.

The extension holds no database credential and never speaks to Neon. It sends
one header — `X-Ingest-Target: local|neon` — and the ingest server, which
already holds both connection strings, writes with the same parser and the same
upserts either way. That is the whole reason this is a header and not a second
implementation: a copy of the parser in JavaScript would drift from
`scraper/ingest.py` within a week, and a connection string shipped inside an
extension is a full write credential sitting in a Chrome profile.

The Neon button is disabled unless the server reports the target as available,
which it does by reading `NEON_DATABASE_URL`. Clicking it when the server has no
such variable would otherwise turn into a failed scrape instead of a control
that is visibly off; if the button is on and the write still fails, the popup
shows the server's own sentence rather than `HTTP 503`.

The choice is fixed when a run starts. Switching mid-walk would split one shop's
catalogue across two databases and leave neither able to say so, so the toggle
is locked while a job is running.

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

## 6. Price against the competition

The dashboard's **Posisi harga** screen answers one question over a whole
catalogue: which of our prices is somebody else beating, and by how much. Two
things have to be true before it can.

Mark more than one shop as ours and the dashboard does not add them together:
**Ringkasan**, **Posisi harga**, and **Analitik** each report on one shop at a
time, picked from the topbar.

**Say which shop is ours.** The marketplace does not record it and no scrape can
work it out, so it is an operator decision and a stored column rather than
something inferred:

```bash
ecom-scraper own-shop shopee i_bricks   # mark it
ecom-scraper own-shop                   # list what is marked
ecom-scraper own-shop shopee i_bricks --unset
```

The shop has to have been scraped once first — there is nothing to mark
otherwise.

**Scrape the competition.** Any shop-mode run will do; the comparison happens in
the database afterwards, so the cost of scraping does not grow with the number
of products we sell.

Listings are paired on the **LEGO set number** carried in the title, extracted on
the way in by `scraper/set_code.py`. Two listings sharing one are the same box
whatever words surround it, which is the one thing trigram similarity cannot
manage: `42217` and `42218` score 0.86 against each other and are different
products. Titles carrying no set number — accessories, bundles, knock-offs —
fall back to trigram similarity at 0.45, and the dashboard marks those rows as
the weaker match they are.

The extraction rules are an argument with how sellers write titles, and they will
be tuned again. That is cheap, because the names are already stored:

```bash
ecom-scraper backfill-set-codes --dry-run   # what would change
ecom-scraper backfill-set-codes             # recompute the column
```

```
                   set codes
┏━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━━━━━━┳━━━━━━━━━┓
┃ products ┃ changed ┃ newly matched ┃ cleared ┃
┡━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━━━━━━╇━━━━━━━━━┩
│       70 │      45 │            45 │       0 │
└──────────┴─────────┴───────────────┴─────────┘
```

## 7. Deploy the dashboard (Vercel + Neon)

The dashboard runs anywhere Next.js does; the scraper does not, and that shapes
the whole arrangement. Scraping happens in a browser on a machine you control —
that is the point of the extension — so a deployment splits into three parts:

    extension (your Chrome)  →  ingest server (your machine)  →  Postgres
                                                                   ↑
                                              dashboard (Vercel) ──┘

Only the last leg moves. The ingest server keeps running locally and writes to
whichever database `DATABASE_URL` names, so pointing it at Neon is what puts
scraped data somewhere Vercel can read.

**1. A database.** Create a Neon project and take **both** connection strings —
they differ by `-pooler` in the host. The dashboard gets the pooled one: a
serverless deployment is many short-lived instances, and the direct endpoint
gives each one its own connection. Schema work and bulk loading get the direct
one, because a pooler in transaction mode is the wrong place for either.

The dashboard is built for that pooled endpoint specifically: it sends no
connection-level startup parameters, since Neon's pooler refuses the whole
connection over one — `unsupported startup parameter in options`. The trigram
threshold the price matching needs is set per transaction instead
(`withNameMatching` in `dashboard/src/lib/queries.ts`).

**2. The schema and the data.** Put the **direct** endpoint in the repo root
`.env` — `ecom-scraper sync` reads it from there, and so does the ingest server's
Neon destination:

```bash
NEON_DATABASE_URL=postgresql://…@ep-….neon.tech/…?sslmode=require
```

Then:

```bash
ecom-scraper sync --dry-run   # what would change, writes nothing
ecom-scraper sync             # migrations, then the rows
```

`sync` mirrors: afterwards the target's `stores`, `products`,
`product_keywords`, `price_snapshots` and `scrape_runs` are exactly what this
laptop holds, **ids included**. Ids rather than natural keys because
`notify_seen` stores an id and nothing else here would survive being
renumbered; copying them verbatim also means the two databases agree on what row
8134 is.

It is safe to re-run, and it is the command to reach for whenever the two have
drifted apart — which they will, since the laptop keeps collecting.

Three things it will not do. It never touches `app_credentials`: a deployment's
login is meant to be its own, seeded from `DASHBOARD_PASSWORD`, not the laptop's.
It refuses outright when the target holds shops or listings this database does
not — a mirror would delete them, so it names them and stops unless you pass
`--force`. And it reseeds the target's `notify_seen` to the newest snapshot id it
just copied, for the reason `migrations/006_notify_seen.sql` gives: what was
copied is history, not news, and a read marker left behind would show 18,000
long-known listings as unread on the notifications page.

The whole thing runs in one transaction on the target, so a connection dropped
partway leaves it exactly as it was rather than half-mirrored.

```bash
# Fresh rows, no statistics: without this the planner guesses and the price
# screens pay for it.
psql "$NEON_DATABASE_URL" -c 'ANALYZE'
```

The equivalent by hand is a per-table `pg_dump --data-only` in foreign-key order
(`stores`, `products`, then the rest) — parents before children, or `products`
fails on its foreign key.

**3. The dashboard.** Point Vercel at this repo with **Root Directory =
`dashboard`**, and set two environment variables:

```bash
vercel env add DATABASE_URL production        # paste the pooled Neon URL
vercel env add DASHBOARD_PASSWORD production  # anything but the default below
vercel --prod
```

`DATABASE_URL` is required rather than optional: deployed, the dashboard refuses
to start without it instead of falling back to a localhost Postgres that is not
there — a fallback whose error message sends you debugging the wrong machine.

**4. `DASHBOARD_PASSWORD` is what keeps the URL private.** The login seeds
itself on first run, and without that variable it seeds the default printed
below — which is in this README, on the public internet, next to your
deployment. Setting it means the dashboard is never briefly open. Optionally set
`DASHBOARD_USERNAME` too; both are read only when the credential row does not
exist yet, so changing the password later on `/settings` is not undone by the
next cold start.

| | |
|---|---|
| Default login | `admin` / `ecom123` |
| Changed at | `/settings` |
| Warned about | topbar and `/settings`, until it is no longer the default |

Everything the dashboard serves is behind that login — the pages by the route
group they sit in, and the JSON routes (`/api/products`, `/api/stores`,
`/api/filter-options`, `/api/products/<id>/history`) by an explicit guard, since
no layout runs for those. Unauthenticated, each answers `401`.

**5. Keep scraping into the same database.** Set `DATABASE_URL` to the Neon URL
in the repo root `.env` and restart the ingest server, or the extension will go
on filling the local database while the dashboard reads the hosted one and
reports that nothing has changed since the day you deployed.

What this costs, measured against `ap-southeast-1` with 12.4k listings and 32
shops in the database:

| Screen | Local socket | Neon pooled |
|---|---|---|
| Ringkasan, Produk, Toko, Pengaturan | ~0.05s | 0.12 – 0.17s |
| Posisi harga, Analitik | ~0.4s | 2.9 – 3.3s |

The two slow ones are the trigram pairing, and they are slow because that work is
paid on a compute smaller than the laptop's — not because of the round trip. The
same pairing takes 12s at the threshold this app sets and 40s at pg_trgm's
default, which is what the per-transaction `SET LOCAL` is for. If those three
seconds matter more than remote access, run the dashboard locally — it is the
same code, and `scripts/dashboard-server.sh` already does it.

## 8. Notifications

The dashboard tells you where you stand when you open it. `/notifications` tells
you what changed while you were not looking: every rival that moved a price on a
`set_code` one of our own shops carries. A bell in the topbar carries the unread
count, so the answer is visible from whichever screen you are already on.

**There is nothing to configure.** No bot, no token, no shared secret, no
trigger, no timer. The page reads the same database every other screen reads,
and how far you have read is one row in `notify_seen`
(`migrations/006_notify_seen.sql`, applied by `ecom-scraper initdb` like every
other migration). Setting up section 7 is all the setup there is.

This replaced a Telegram bot, and the trade it makes is worth knowing. A bot
pushes; a page waits to be opened. What was bought with that is a worklist that
survives being read — the old digest was a message you scrolled past once,
whereas this is the same rows tomorrow, still there, still linked to the screen
that answers what to do about them.

### What is on it

A rolling **14-day window**, newest first, with two tabs. *Semua* is the landing
view and always renders the whole window. *Baru* is the same list narrowed to
what arrived above your read marker, and it is allowed to be empty — you got
there by asking a question whose honest answer is sometimes "nothing".

The read marker **never filters Semua**, which is the rule the whole screen is
built around. A marker that filtered could only ever be read once: one glance on
a phone would erase a 56-row worklist that then existed nowhere. It decides
which rows are styled as new and what the bell counts, and nothing else. Opening
the page advances it (`POST /api/notifications/seen`) to the top of the window
rather than to the last row rendered, which is the only way it moves forward
through a list ordered by consequence instead of by id.

That has a cost, and it lands on the **display cap**. The page prints the top 200
rows and has no next page, so a row ranked below that is not shown — and because
the marker advanced over the whole window regardless, it stops counting as new
too. The cap is a real limit, not a display detail: such a row reappears only
once enough rows above it age out of the 14-day window. Today the window is 56
rows, so nothing is being lost; pagination is what fixes it when that changes.

A row qualifies when a rival's price moved by at least **5%** against a
comparison snapshot **at least 24 hours and at most 7 days** older. Rows where
that rival went *under* our price sort first, because that is the one that
demands a decision; a big move on a set we are still comfortably winning is
news, not a decision. A shop that repriced its whole catalogue at once folds
into a single entry that carries its members, so 33 identical rows cannot bury
everything else — and the fold happens *within* the undercut partition, never
across it, so a group cannot straddle "went under us" and "did not".

Each row states its own real comparison age rather than claiming "24 jam". The
24-hour floor is a guard against the noise between captures a few hours apart,
not a description of what any given row compared against: measured against this
database, the window returns the same 56 rows at 1, 6, 12, 24, 48 and 72 hours,
and the comparisons actually chosen range from 78 to 140 hours old. What binds
is the scrape spacing, so the page reports what it used.

Cross-marketplace by design, like `/products` and `/stores`: a rival's move
matters whichever marketplace it happens on. Every link it builds still carries
`?kanal=`, because the screens it points at are scoped.

### What counts as a price change

Everywhere in this project a snapshot is compared against the newest one at
least some hours older, never against whatever came immediately before it.

Captures taken hours apart disagree about price without anything having been
repriced. In this database, 37 of 38 snapshot pairs taken 1.5–3.5 hours apart
differ, against 3 of 1,335 pairs taken a day apart — and `sold` is byte-identical
across the near pairs, which no genuinely repriced listing would be. Comparing
against the immediate predecessor reports mostly artefacts.

The product table's movement badge reads its floor from
`NOTIFY_MIN_GAP_HOURS` (12), through `dashboard/src/lib/price-change.ts` — one
module rather than a copy in each query, so the badge cannot come to disagree
with what the rest of the app calls a change. The variable keeps its `NOTIFY_`
name from the notifier that first needed it. Set `NOTIFY_MIN_GAP_HOURS=0` to
turn the rule off and see the artefacts for yourself.

`/notifications` applies the same rule with its own, wider floor of 24 hours
(`DEFAULT_WINDOW` in `dashboard/src/lib/notify/rival-moves.ts`), which is also
what the read marker advances over — one constant read by both, because a marker
that moved over a different window from the one the page renders would strand
exactly the rows nobody had read.

### If it is empty

An empty *Baru* means nothing new since you last looked, which is the ordinary
case. An empty *Semua* does not: the window is 14 days wide and unfiltered, so
nothing there at all means nothing is being written to the database this
dashboard reads.

The usual cause is step 5 of section 7 — the ingest server still writing to the
laptop while the deployment reads Neon. Compare the row counts:
`ecom-scraper doctor` against this machine, and the Ringkasan screen on the
deployment.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — every target scraped (`doctor` always exits `0`; read the verdicts) |
| `1` | Partial failure — some targets failed (`run`), or the manual `login` timed out or was cancelled |
| `2` | Usage or configuration error — missing file, empty target list, unreachable Postgres, missing credentials, no window available for `login` |

Suitable for cron: `1` means "look at the log", `2` means "the setup is broken".

## 9. Deploy the ingest server (optional, for other people's machines)

The ingest server is a local service by default, and for your own machine it
should stay one: the extension reaches it over loopback, nothing crosses the
internet, and a twenty-shop sweep costs nothing. This section is for the other
case — someone else's Chrome, on someone else's laptop, with no Python on it.

It is the **same application**, deployed a second time. `app.py` is the whole
port:

```python
from scraper.ingest import build_app

app = build_app()
```

**A second Vercel project**, root set to this repository — not the dashboard's
project, whose root is `dashboard/` and which none of this touches. Vercel
detects FastAPI, `vercel.json` points the install at `requirements-vercel.txt`
(no Playwright, which would otherwise dominate the bundle) and excludes
everything the server does not import.

Three environment variables:

| variable | value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** endpoint — the one with `-pooler` in the host |
| `NEON_DATABASE_URL` | the same pooled endpoint, so both destinations the popup offers resolve |
| `INGEST_TOKEN` | a token you generate; every extension sends it back |
| `INGEST_ALLOWED_ORIGINS` | `chrome-extension://<your extension id>` |

Both database variables point at the same place on a hosted deployment, and that
is not redundancy: the popup's destination switch sends `local` or `neon`, and a
server that only understands one of them turns the other into a failed scrape.
Locally they stay what they have always been — the laptop's Postgres and the
hosted one.

What the code does differently when it is up there, keyed off the `VERCEL`
variable the platform sets on every deployment:

* **`/pair` is refused.** It hands a database write credential to whoever asks,
  and its only safety argument is that nothing off this machine can ask. Hosted,
  the token comes from the dashboard's Panduan page instead.
* **The engine stops pooling** (`NullPool`). Every invocation is its own
  process, so per-process pools multiply while each serves one request; Neon's
  pooler is what should be holding connections.

`INGEST_ALLOWED_ORIGINS` has no default and takes no wildcard. Loopback needs no
CORS at all — the popup and the server share an origin — so an allowlist that
defaulted to "anyone" would only ever weaken the hosted case it exists for.

Worth being plain about the trade: on loopback the token is a second lock behind
a door only this machine can reach. Hosted, it is the *only* lock on a write
path into the shared catalogue. Rotate it by changing the variable and
re-issuing it; add a Vercel WAF rate-limit rule on the ingest paths (the Hobby
plan allows three).

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
| `NEON_DATABASE_URL` | _(unset)_ | The hosted database (section 7). Target of `ecom-scraper sync`, and the second destination the extension can pick. Use the direct, non-pooler endpoint |

The dashboard reads its own environment, not this one — see
`dashboard/.env.example`. `NOTIFY_MIN_GAP_HOURS` (12) lives there: it is how old
a comparison snapshot must be before the product table calls a price difference
a change (section 8).

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

The dashboard's price comparison is tested where it lives — in SQL, against the
same scratch database:

```bash
cd dashboard && npm test
```

Those cases are built as traps rather than happy paths: a set number one digit
away from ours, our own second shop sitting in the rival pool, a title close
enough to be tempting and not close enough to be right. A mocked database would
only prove the query string was assembled; what can actually go wrong here is a
join quietly pairing the wrong listings, and only Postgres can tell us that.
**These tests truncate their tables**, so `ECOM_SCRAPER_TEST_DATABASE_URL` must
never point at the real database.
