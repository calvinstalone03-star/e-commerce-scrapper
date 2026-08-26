# Batch shop scrape — one press, every shop on the list

Date: 2026-08-18
Status: implemented

## The problem

Scraping twenty tracked shops meant opening each storefront by hand and pressing
**Scrape toko ini** twenty times. The extension already knows how to walk one
shop's catalogue page by page; nothing above it knew about a list.

## What was built

A queue over the existing single-shop run, fed by a list the ingest server reads
from `config/stores.txt`, with a dashboard button that drafts that file from the
shops already in the database.

```
dashboard (Next.js)          ingest server (FastAPI)          extension (MV3)
  /stores screen                   GET /shops                    "Scrape semua toko"
  Unduh stores.txt          ←──    reads config/stores.txt  ──→   walks the list in order
        │                                  ▲                              │
        └── GET /api/stores/export         │                              └── POST /ingest-dom, unchanged
            (reads the stores table)  a human saves the file
```

The list is half-manual on purpose. The `stores` table records every seller a
scrape walked past; a sweep driven off it would grow without anyone choosing to
grow it. So the database proposes (export) and the file decides (`stores.txt`).

## Decisions

| Question | Answer | Why |
|---|---|---|
| Where does the list live? | `config/stores.txt`, served by the ingest server at `GET /shops` | One file for the CLI and the extension. Editing it changes what the button does with no reload |
| How does the file get filled? | Dashboard exports a draft from the `stores` table; a human trims and saves it | Keeps a scrape from enrolling shops nobody chose |
| Line format | `marketplace/slug`; bare line = Shopee; pasted URL accepted | Existing Shopee-only files keep working, Tokopedia becomes expressible |
| A shop fails | Record it, continue, report at the end, offer a retry of just those | One bad slug must not cost the other nineteen |
| Products per shop | One number from the popup, applied to each shop | One control; the existing box already means this |
| Interruption | Save the place, offer **Lanjutkan batch** | MV3 evicts idle workers. Nothing resumes on its own: a sweep navigates a tab for hours |

## Structure

`job` still means one shop — every popup progress path, `saveResume`, and
`runJob` keep their meaning. A second object, owned by `extension/batch.js`,
means the sweep:

```js
batch = { running, cancelled, target, shops[], index, results[], startedAt }
```

`startJob` was split so the queue can await a shop:

- `beginJob(spec, {site, tabId, resume})` — runs one shop, resolves with its
  finished snapshot. The body that used to be abandoned inside `startJob`.
- `startJob(spec)` — the fire-and-forget wrapper the popup still calls.
- `resolveRunTab(marketplace)` — the tab and site for a run. A single scrape
  reads them off the active tab; a sweep is told the marketplace and reuses one
  tab for the whole list, opening one only if the active tab is not a
  marketplace tab.

`batch.js` is a factory over injected dependencies (`fetchShops`, `runShop`,
`saveState`, `sleep`, `now`, …) so the sequencing is testable in Node without
Chrome. `dashboard/src/lib/extension-batch.test.ts` drives it through `node:vm`.

## Persistence

Two keys, two questions:

- `resume` (existing) — which page of which shop.
- `batch` (new) — which shop of the list, plus what each finished shop filed.

`batch` is written *before* a shop starts as well as after it ends, so an
eviction mid-shop resumes at that shop rather than skipping it; the per-shop
resume then continues its walk. Both expire after 12 hours.

## Error handling

- Shop-level failure (`slug not found`, grid never rendered, tab closed): the
  row is marked failed with the worker's own message, and the sweep continues.
- `runShop` rejecting is treated identically — a closed tab rejects rather than
  resolving.
- List-level failure (`/shops` unreachable, 401, a server too old to have the
  route, an empty list): the sweep never starts and the popup states the fix.
- **Batal** during a sweep cancels the sweep and the storefront in flight;
  cancelling only the storefront would start the next shop a second later.

## Server and dashboard

- `scraper/shops.py` — `ShopEntry`, `parse_shop_line`, `load_shop_entries`,
  `resolve_stores_path`. `runner.resolve_targets` keeps only Shopee entries for
  `--mode store`, which has no other adapter.
- `GET /shops` — token-authorised like `/stats`, re-reads the file per request
  (a cached list would make an edit look like it did nothing — the same lesson
  `stale` in `/health` records), and answers a missing file with `200` and an
  empty list rather than a `404`.
- `STORES_FILE` setting, relative paths resolved against the repository root
  because launchd and Vercel do not start the server from the checkout.
- `GET /api/stores/export` — `text/plain` attachment named `stores.txt`, built
  by the pure `formatStoresFile`, ordered by product count, dropping placeholder
  `shop-<id>` usernames the extension could not navigate to.

## Tests

- `tests/test_shops.py` — 18 cases pinning the line format.
- `tests/test_ingest.py` — `/shops` needs a token, returns file order, re-reads
  per request, missing file is an empty list.
- `dashboard/src/lib/stores-export.test.ts` — the export format, from the
  reader's side of the same agreement.
- `dashboard/src/lib/extension-batch.test.ts` — 20 cases over the queue:
  skip-and-continue, resume index, cancel, retry, double-start.

## Not built

- No `chrome.alarms`. A sweep runs while the user is there and offers to
  continue when they come back; a worker waking itself to navigate tabs is a
  different promise than the one this extension makes.
- No per-shop target or keyword in `stores.txt`. One number, one control.
- The dashboard does not write `config/stores.txt`. It is deployed; the file is
  in someone's checkout.
