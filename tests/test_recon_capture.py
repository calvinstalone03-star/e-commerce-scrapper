"""Guards on the throwaway recon capture in ``.recon/``.

``.recon/capture.py`` is not part of the package — it is the one-off Playwright
script that recorded the live ``/api/v4/`` traffic every classification rule in
:mod:`scraper.client` is justified against. It is still worth a test, because it
writes to disk: its stated policy is "cookies: NAMES ONLY, never values", and it
quietly broke that policy for everything that is a credential without being
spelled ``Cookie``.

The whole directory is gitignored, so a fresh clone has neither the script nor
its output; every test here skips when the file it guards is absent.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
from pathlib import Path
from typing import Any

import pytest

RECON_DIR = Path(__file__).resolve().parent.parent / ".recon"
CAPTURE_SCRIPT = RECON_DIR / "capture.py"
CAPTURE_JSON = RECON_DIR / "browser_capture.json"

#: Header names whose *values* must never reach disk: the session credentials,
#: the CSRF token (which is the ``csrftoken`` cookie value verbatim) and the
#: anti-bot SDK signatures. Recon established that signing is not the gate — a
#: login wall is — so a stored signature is pure liability.
MUST_BE_REDACTED = (
    "Cookie",
    "Set-Cookie",
    "Authorization",
    "X-CSRFToken",
    "x-sap-sec",
    "x-sap-ri",
    "af-ac-enc-dat",
    "af-ac-enc-sz-token",
    "d-nonptcha-sync",
)


def load_capture_module() -> Any:
    """Import ``.recon/capture.py`` by path, or skip when it is not there."""
    if not CAPTURE_SCRIPT.exists():
        pytest.skip(".recon/capture.py is not present (the directory is gitignored)")
    spec = importlib.util.spec_from_file_location("recon_capture", CAPTURE_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_redact_masks_every_credential_and_signature_header() -> None:
    """Names are the finding; values are the liability. Regression.

    The original list covered only ``cookie``/``authorization``, so the recorder
    wrote a live ``x-csrftoken`` (the csrftoken cookie value under another name)
    and a ~2.5KB ``x-sap-sec`` signature per request straight to disk, on 31
    requests — half-enforcing the script's own stated policy.
    """
    capture = load_capture_module()
    headers = {name: f"live-value-for-{name}" for name in MUST_BE_REDACTED}
    headers["user-agent"] = "Mozilla/5.0"
    headers["referer"] = "https://shopee.co.id/search?keyword=kaos%20polos"

    redacted = capture.redact(headers)

    assert set(redacted) == set(headers), "header NAMES are the whole point of the capture"
    for name in MUST_BE_REDACTED:
        assert redacted[name] == capture.REDACTED, name
    assert redacted["user-agent"] == "Mozilla/5.0", "harmless headers stay readable"
    assert redacted["referer"].startswith("https://")


def test_the_stored_capture_carries_no_credential_or_signature_values() -> None:
    """The artifact already on disk must be scrubbed too, not just future runs.

    0600 does not survive a tar to another machine, a Dropbox sync or a bug
    report attachment, and ``git add -f`` would put the signatures in history —
    exactly the "signature caching outside a live page" this project forbids.
    """
    if not CAPTURE_JSON.exists():
        pytest.skip(".recon/browser_capture.json is not present")
    capture = load_capture_module()

    records = json.loads(CAPTURE_JSON.read_text(encoding="utf-8"))
    leaked = [
        (index, name)
        for index, record in enumerate(records)
        for section in ("request_headers", "response_headers")
        for name, value in (record.get(section) or {}).items()
        if str(name).lower() in capture.SENSITIVE_HEADERS and value != capture.REDACTED
    ]

    assert leaked == [], f"unredacted credential/signature values in the capture: {leaked}"
    assert stat.S_IMODE(os.stat(CAPTURE_JSON).st_mode) == 0o600
