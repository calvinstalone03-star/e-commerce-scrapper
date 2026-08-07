#!/usr/bin/env python3
"""
daily_scrape.py — Automated daily scrape via Chrome extension + CDP.

Flow per toko:
1. Launch Chrome with --remote-debugging-port (reuse if already open)
2. Open tab to store URL (Shopee or Tokopedia)
3. Wait for page to load
4. Inject 'start' message directly into extension service worker via CDP
5. Poll job progress until done or timeout
6. Log result, move to next store

Extension ID: fkcfblocmhlfbkdgfmgbaogfglmgfmkf
Ingest server: http://127.0.0.1:8787
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_CDP_PORT = 9223  # 9222 often taken; use 9223 for dedicated scrape instance
CHROME_PROFILE = os.path.expanduser(
    "~/Library/Application Support/Google/Chrome/Default"
)
EXTENSION_ID = "fkcfblocmhlfbkdgfmgbaogfglmgfmkf"
INGEST_URL = "http://127.0.0.1:8787"
CDP_BASE = f"http://127.0.0.1:{CHROME_CDP_PORT}"

# Products to scrape per store (matches extension default)
TARGET_PRODUCTS = 60

# Max seconds to wait for one store scrape to finish
SCRAPE_TIMEOUT = 300  # 5 minutes

# Delay between stores (seconds) — be polite to marketplaces
INTER_STORE_DELAY = 10

LOG_FILE = Path(__file__).parent.parent / "logs" / "daily_scrape.log"

STORES = [
    # Shopee — URL format: https://shopee.co.id/{username}
    {"marketplace": "shopee", "username": "brickzproject"},
    {"marketplace": "shopee", "username": "cupliss.kelapagading"},
    {"marketplace": "shopee", "username": "i_bricks"},
    {"marketplace": "shopee", "username": "inspoint"},
    {"marketplace": "shopee", "username": "kaveshop"},
    {"marketplace": "shopee", "username": "kenjiro_13"},
    {"marketplace": "shopee", "username": "kidzstationofficial"},
    {"marketplace": "shopee", "username": "lego.indonesia"},
    {"marketplace": "shopee", "username": "menta.toys"},
    {"marketplace": "shopee", "username": "toyskingdomofficial"},
    # Tokopedia — URL format: https://www.tokopedia.com/{username}
    {"marketplace": "tokopedia", "username": "brickzproject"},
    {"marketplace": "tokopedia", "username": "cupliss"},
    {"marketplace": "tokopedia", "username": "i-bricks"},
    {"marketplace": "tokopedia", "username": "inspoint"},
    {"marketplace": "tokopedia", "username": "kaveshop"},
    {"marketplace": "tokopedia", "username": "kenjiro13"},
    {"marketplace": "tokopedia", "username": "luxasia-lego-auth-distributor"},
    {"marketplace": "tokopedia", "username": "menta-hobbies"},
    {"marketplace": "tokopedia", "username": "menta-toys"},
    {"marketplace": "tokopedia", "username": "toyskingdom"},
]


def store_url(store: dict) -> str:
    if store["marketplace"] == "shopee":
        return f"https://shopee.co.id/{store['username']}"
    return f"https://www.tokopedia.com/{store['username']}"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("daily_scrape")


# ---------------------------------------------------------------------------
# Chrome / CDP helpers
# ---------------------------------------------------------------------------

def chrome_already_running_with_cdp() -> bool:
    try:
        r = httpx.get(f"{CDP_BASE}/json/version", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def launch_chrome() -> subprocess.Popen:
    """Launch Chrome with CDP enabled, reusing existing profile (stays logged in)."""
    cmd = [
        CHROME_BIN,
        f"--remote-debugging-port={CHROME_CDP_PORT}",
        f"--user-data-dir={CHROME_PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",  # don't pop sync dialog
        "about:blank",
    ]
    log.info("launching Chrome with CDP on port %d", CHROME_CDP_PORT)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Wait for CDP to be ready
    for _ in range(30):
        time.sleep(1)
        if chrome_already_running_with_cdp():
            log.info("Chrome CDP ready")
            return proc
    raise RuntimeError("Chrome did not expose CDP within 30s")


def cdp_call(session_id: str, method: str, params: dict | None = None) -> dict:
    payload = {"id": 1, "method": method, "params": params or {}}
    if session_id:
        payload["sessionId"] = session_id
    r = httpx.post(f"{CDP_BASE}/json/command", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def get_targets() -> list[dict]:
    r = httpx.get(f"{CDP_BASE}/json/list", timeout=10)
    r.raise_for_status()
    return r.json()


def get_or_create_tab(url: str) -> str:
    """Navigate to URL in existing tab or open new tab. Returns target id."""
    targets = get_targets()
    # Prefer existing page tab (not extensions)
    page_tabs = [t for t in targets if t.get("type") == "page"]
    if page_tabs:
        target_id = page_tabs[0]["id"]
        # Navigate existing tab
        r = httpx.get(f"{CDP_BASE}/json/activate/{target_id}", timeout=5)
    else:
        # Open new tab
        r = httpx.put(f"{CDP_BASE}/json/new?{url}", timeout=10)
        r.raise_for_status()
        return r.json()["id"]

    # Navigate via CDP
    attach_r = httpx.post(f"{CDP_BASE}/json/command", json={
        "id": 1,
        "method": "Target.attachToTarget",
        "params": {"targetId": target_id, "flatten": True}
    }, timeout=10)
    attach_r.raise_for_status()
    session_id = attach_r.json().get("result", {}).get("sessionId", "")

    httpx.post(f"{CDP_BASE}/json/command", json={
        "id": 2,
        "method": "Page.navigate",
        "params": {"url": url},
        "sessionId": session_id
    }, timeout=10)

    return target_id


def find_extension_worker() -> str | None:
    """Find the service worker target for our extension."""
    targets = get_targets()
    for t in targets:
        url = t.get("url", "")
        if EXTENSION_ID in url and t.get("type") in ("service_worker", "background_page"):
            return t["id"]
    return None


def attach_to_target(target_id: str) -> str:
    """Attach to a CDP target. Returns sessionId."""
    r = httpx.post(f"{CDP_BASE}/json/command", json={
        "id": 1,
        "method": "Target.attachToTarget",
        "params": {"targetId": target_id, "flatten": True}
    }, timeout=10)
    r.raise_for_status()
    return r.json().get("result", {}).get("sessionId", "")


def eval_in_target(session_id: str, expression: str) -> dict:
    r = httpx.post(f"{CDP_BASE}/json/command", json={
        "id": 2,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        },
        "sessionId": session_id,
    }, timeout=30)
    r.raise_for_status()
    return r.json().get("result", {})


def wake_service_worker() -> str | None:
    """
    MV3 service workers sleep. Sending a runtime message via a page tab wakes them.
    Returns session ID of the worker once awake.
    """
    # Open extension popup page to wake worker
    targets = get_targets()
    page_tabs = [t for t in targets if t.get("type") == "page"]
    if not page_tabs:
        return None

    tab_session = attach_to_target(page_tabs[0]["id"])
    wake_expr = f"""
    new Promise((resolve) => {{
        chrome.runtime.sendMessage('{EXTENSION_ID}', {{type: 'ping'}}, (r) => resolve(r || 'pong'));
    }})
    """
    try:
        eval_in_target(tab_session, wake_expr)
    except Exception:
        pass

    # Now look for worker
    for _ in range(10):
        time.sleep(1)
        worker_id = find_extension_worker()
        if worker_id:
            return attach_to_target(worker_id)
    return None


# ---------------------------------------------------------------------------
# Extension messaging
# ---------------------------------------------------------------------------

def start_scrape(worker_session: str, shop: str, keyword: str = "", target: int = TARGET_PRODUCTS) -> dict:
    """Send start message to extension service worker."""
    expr = f"""
    new Promise((resolve) => {{
        const msg = {{type: 'start', keyword: {json.dumps(keyword)}, shop: {json.dumps(shop)}, target: {target}}};
        // Dispatch via service worker's own message handler
        self.dispatchEvent(new MessageEvent('message', {{data: msg}}));
        // Also try via runtime message bus
        chrome.runtime.onMessage._listeners?.forEach?.(fn => {{
            try {{
                const reply = fn(msg, {{id: 'automation'}}, (r) => resolve(r || {{ok: true}}));
                if (reply && typeof reply.then === 'function') reply.then(resolve);
            }} catch(e) {{}}
        }});
        setTimeout(() => resolve({{ok: true, note: 'timeout-resolve'}}), 5000);
    }})
    """
    result = eval_in_target(worker_session, expr)
    return result.get("result", {}).get("value", {})


def get_job_status(worker_session: str) -> dict | None:
    """Poll job state from service worker."""
    expr = """
    new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'context'}, (ctx) => resolve(ctx));
        setTimeout(() => resolve(null), 3000);
    })
    """
    result = eval_in_target(worker_session, expr)
    return result.get("result", {}).get("value")


def trigger_start_via_page(tab_session: str, shop: str, keyword: str = "", target: int = TARGET_PRODUCTS) -> dict:
    """
    Alternative: trigger scrape by sending message from a page context.
    More reliable since it goes through Chrome's proper extension messaging.
    """
    expr = f"""
    new Promise((resolve) => {{
        chrome.runtime.sendMessage(
            '{EXTENSION_ID}',
            {{type: 'start', keyword: {json.dumps(keyword)}, shop: {json.dumps(shop)}, target: {target}}},
            (reply) => resolve(reply || {{ok: false, error: 'no reply'}})
        );
        setTimeout(() => resolve({{ok: false, error: 'timeout'}}), 10000);
    }})
    """
    result = eval_in_target(tab_session, expr)
    return result.get("result", {}).get("value", {})


def poll_until_done(tab_session: str, timeout: int = SCRAPE_TIMEOUT) -> dict:
    """Poll job status until running=false or timeout."""
    deadline = time.time() + timeout
    last_status = ""
    while time.time() < deadline:
        time.sleep(5)
        ctx_expr = f"""
        new Promise((resolve) => {{
            chrome.runtime.sendMessage('{EXTENSION_ID}', {{type: 'context'}}, (ctx) => resolve(ctx));
            setTimeout(() => resolve(null), 5000);
        }})
        """
        result = eval_in_target(tab_session, ctx_expr)
        ctx = result.get("result", {}).get("value")
        if not ctx:
            log.warning("no context reply from extension")
            continue

        job = ctx.get("job")
        if not job:
            # Job cleared = done
            return {"done": True, "job": None}

        status = job.get("status", "")
        if status != last_status:
            log.info("  job status: %s | items: %d/%d | page: %d",
                     status, job.get("unique", 0), job.get("target", 0), job.get("page", 0))
            last_status = status

        if not job.get("running"):
            return {"done": True, "job": job}

    return {"done": False, "job": None, "error": "timeout"}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def scrape_store(store: dict, tab_session: str) -> dict:
    url = store_url(store)
    username = store["username"]
    marketplace = store["marketplace"]

    log.info("→ [%s] %s — navigating to %s", marketplace, username, url)

    # Navigate tab to store URL
    nav_expr = f"window.location.href = {json.dumps(url)};"
    eval_in_target(tab_session, nav_expr)

    # Wait for page to settle
    log.info("  waiting for page load...")
    time.sleep(8)

    # Extra wait for SPA hydration (Shopee/Tokopedia both SPA)
    wait_expr = """
    new Promise((resolve) => {
        if (document.readyState === 'complete') { resolve('ready'); return; }
        window.addEventListener('load', () => resolve('loaded'), {once: true});
        setTimeout(() => resolve('timeout'), 20000);
    })
    """
    eval_in_target(tab_session, wait_expr)
    time.sleep(3)

    # Trigger scrape via extension messaging from page context
    log.info("  triggering scrape...")
    reply = trigger_start_via_page(tab_session, shop=username, target=TARGET_PRODUCTS)
    log.info("  start reply: %s", reply)

    if not reply.get("ok"):
        err = reply.get("error", "unknown")
        log.warning("  start failed: %s", err)
        return {"marketplace": marketplace, "username": username, "status": "FAILED", "error": err}

    # Poll until done
    log.info("  polling until done (timeout %ds)...", SCRAPE_TIMEOUT)
    result = poll_until_done(tab_session)

    job = result.get("job") or {}
    if not result.get("done"):
        return {
            "marketplace": marketplace,
            "username": username,
            "status": "TIMEOUT",
            "error": "scrape did not finish within timeout",
        }

    if job.get("error"):
        return {
            "marketplace": marketplace,
            "username": username,
            "status": "FAILED",
            "error": job["error"],
            "items": job.get("unique", 0),
        }

    return {
        "marketplace": marketplace,
        "username": username,
        "status": "OK",
        "items": job.get("unique", 0),
        "stored": job.get("stored", 0),
        "unchanged": job.get("unchanged", 0),
        "pages": job.get("pagesDone", 0),
    }


def main() -> None:
    started_at = datetime.now()
    log.info("=" * 60)
    log.info("daily scrape started: %s", started_at.isoformat())
    log.info("%d stores to scrape", len(STORES))

    # Check ingest server
    try:
        r = httpx.get(f"{INGEST_URL}/health", timeout=5)
        r.raise_for_status()
        log.info("ingest server OK: %s", INGEST_URL)
    except Exception as e:
        log.error("ingest server not reachable at %s: %s", INGEST_URL, e)
        log.error("run: ecom-scraper serve")
        sys.exit(1)

    # Launch or reuse Chrome with CDP
    chrome_proc = None
    if chrome_already_running_with_cdp():
        log.info("Chrome CDP already on port %d — reusing", CHROME_CDP_PORT)
    else:
        chrome_proc = launch_chrome()
        time.sleep(3)

    # Get a page tab session
    targets = get_targets()
    page_tabs = [t for t in targets if t.get("type") == "page"]
    if not page_tabs:
        # Open blank tab
        r = httpx.put(f"{CDP_BASE}/json/new?about:blank", timeout=10)
        r.raise_for_status()
        tab_id = r.json()["id"]
    else:
        tab_id = page_tabs[0]["id"]

    tab_session = attach_to_target(tab_id)
    log.info("tab session ready: %s", tab_session[:16] + "...")

    # Run each store
    results = []
    for i, store in enumerate(STORES, 1):
        log.info("[%d/%d] %s / %s", i, len(STORES), store["marketplace"], store["username"])
        try:
            result = scrape_store(store, tab_session)
            results.append(result)
            status = result["status"]
            if status == "OK":
                log.info("  ✓ OK — %d items, %d new, %d pages",
                         result.get("items", 0), result.get("stored", 0), result.get("pages", 0))
            else:
                log.warning("  ✗ %s — %s", status, result.get("error", ""))
        except Exception as exc:
            log.exception("  exception scraping %s/%s: %s", store["marketplace"], store["username"], exc)
            results.append({"marketplace": store["marketplace"], "username": store["username"],
                            "status": "EXCEPTION", "error": str(exc)})

        if i < len(STORES):
            log.info("  sleeping %ds before next store...", INTER_STORE_DELAY)
            time.sleep(INTER_STORE_DELAY)

    # Summary
    elapsed = (datetime.now() - started_at).total_seconds()
    ok = sum(1 for r in results if r["status"] == "OK")
    failed = len(results) - ok
    total_items = sum(r.get("items", 0) for r in results)
    total_stored = sum(r.get("stored", 0) for r in results)

    log.info("=" * 60)
    log.info("DONE in %.0fs — %d/%d OK, %d failed, %d items scraped, %d new",
             elapsed, ok, len(results), failed, total_items, total_stored)

    # Print summary JSON for cronjob delivery
    summary = {
        "started_at": started_at.isoformat(),
        "elapsed_seconds": round(elapsed),
        "stores_ok": ok,
        "stores_failed": failed,
        "total_items": total_items,
        "total_new": total_stored,
        "results": results,
    }
    print("\n--- SUMMARY ---")
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    # Cleanup: if we launched Chrome, close it
    if chrome_proc:
        log.info("closing Chrome (launched by this script)")
        chrome_proc.terminate()

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
