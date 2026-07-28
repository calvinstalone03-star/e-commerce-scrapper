"""Parse a browser-exported cookie jar into the canonical session shape.

Shopee's login is gated behind a CAPTCHA that an automation-controlled Chromium
is not realistically going to clear, so the supported way to obtain an
authenticated jar is for a human to log in normally, in their own browser, and
export the resulting cookies. This module turns whatever that export looks like
into the list-of-cookie-dicts shape :mod:`scraper.session` already persists.

Five export shapes are accepted, sniffed by content rather than by file
extension, because the extensions people use disagree with each other:

* **Netscape** ``cookies.txt`` — seven tab-separated fields, the format emitted
  by curl, wget and the "Get cookies.txt" family of extensions. ``#HttpOnly_``
  domain prefixes are honoured; other ``#`` lines are comments.
* **JSON array** — ``[{"name": ..., "value": ..., "domain": ...}, ...]``, as
  emitted by Cookie-Editor and EditThisCookie. ``expirationDate`` is accepted as
  an alias for ``expires``.
* **Playwright ``storage_state``** — ``{"cookies": [...]}``.
* **This project's own jar envelope** — same as above plus ``user_agent``, so a
  jar can be round-tripped between machines.
* **A raw ``Cookie:`` header** — ``a=b; c=d``, straight off the Network tab.

Nothing here touches the filesystem or the network, and nothing here logs a
cookie value. Parsing is total: malformed entries are dropped rather than
raising, because a half-readable export is still worth importing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable

__all__ = [
    "AUTHENTICATED_COOKIES",
    "CookieImportError",
    "ImportSummary",
    "SHOPEE_DOMAIN_SUFFIX",
    "filter_domain",
    "parse_cookies",
    "summarize",
]

#: Cookies Shopee only mints for a logged-in session. Kept in sync with
#: :data:`scraper.session.AUTHENTICATED_COOKIES`; imported here rather than
#: cross-imported to keep this module free of session-module side effects.
AUTHENTICATED_COOKIES: tuple[str, ...] = ("SPC_EC", "SPC_ST")

#: Only cookies on this suffix are worth importing. A browser export typically
#: carries the whole jar — analytics, ad networks, whatever else was open — and
#: sending those to Shopee is pointless noise at best.
SHOPEE_DOMAIN_SUFFIX = "shopee.co.id"

#: Netscape rows have exactly these seven fields, in this order.
_NETSCAPE_FIELDS = 7

#: Prefix some exporters put on the domain of an HttpOnly cookie.
_HTTPONLY_PREFIX = "#HttpOnly_"


class CookieImportError(ValueError):
    """The supplied text could not be understood as any known export format."""


@dataclass(frozen=True)
class ImportSummary:
    """What a parsed jar contains, with no values in it.

    Attributes:
        source_format: Which parser matched — for telling the user what was read.
        total: Cookies parsed before domain filtering.
        kept: Cookies remaining after domain filtering.
        names: Names of the kept cookies, sorted.
        authenticated: Whether any :data:`AUTHENTICATED_COOKIES` name is present,
            which is the only evidence available that the export came from a
            logged-in browser.
        user_agent: UA recorded in the export, when the format carries one.
    """

    source_format: str
    total: int
    kept: int
    names: tuple[str, ...] = field(default=())
    authenticated: bool = False
    user_agent: str | None = None


def parse_cookies(text: str) -> tuple[list[dict[str, Any]], str, str | None]:
    """Parse an export into cookie dicts, sniffing the format from the content.

    Args:
        text: Raw contents of the export.

    Returns:
        ``(cookies, source_format, user_agent)``. ``cookies`` are plain dicts in
        Playwright's cookie shape, ready for the session module's normaliser.
        ``user_agent`` is None for every format that does not carry one.

    Raises:
        CookieImportError: If the text is empty, or matches no known format, or
            matches one but yields no usable cookie.
    """
    stripped = text.strip()
    if not stripped:
        raise CookieImportError("The export is empty.")

    if stripped[0] in "[{":
        cookies, user_agent = _parse_json(stripped)
        return cookies, "json", user_agent

    if _looks_netscape(stripped):
        return _parse_netscape(stripped), "netscape", None

    if "=" in stripped and "\n" not in stripped.strip():
        return _parse_cookie_header(stripped), "cookie-header", None

    raise CookieImportError(
        "Unrecognised export format. Supported: Netscape cookies.txt, a JSON "
        "cookie array (Cookie-Editor / EditThisCookie), a Playwright "
        "storage_state file, or a raw 'Cookie:' header line."
    )


def _parse_json(text: str) -> tuple[list[dict[str, Any]], str | None]:
    """Parse the three JSON shapes: array, ``{"cookies": ...}``, flat mapping."""
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CookieImportError(f"The export looks like JSON but does not parse: {exc}") from exc

    user_agent: str | None = None
    if isinstance(document, dict):
        raw_ua = document.get("user_agent") or document.get("userAgent")
        if isinstance(raw_ua, str) and raw_ua.strip():
            user_agent = raw_ua.strip()
        document = document.get("cookies", document)

    if isinstance(document, dict):
        # Flat {"name": "value"} mapping. Reject the case where the values are
        # themselves dicts, which means we grabbed the wrong nesting level.
        entries = [
            {"name": name, "value": value}
            for name, value in document.items()
            if isinstance(name, str) and not isinstance(value, (dict, list))
        ]
        if not entries:
            raise CookieImportError("The JSON object carried no cookies.")
        return entries, user_agent

    if not isinstance(document, list):
        raise CookieImportError("The JSON export is neither a cookie array nor an object.")

    cookies = [_coerce_json_cookie(entry) for entry in document if isinstance(entry, dict)]
    cookies = [cookie for cookie in cookies if cookie]
    if not cookies:
        raise CookieImportError("The JSON array carried no cookie with a name.")
    return cookies, user_agent


def _coerce_json_cookie(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Normalise one JSON cookie entry, tolerating exporter-specific field names."""
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        return None

    cookie: dict[str, Any] = {
        "name": name,
        "value": str(entry.get("value", "")),
        "path": entry.get("path") or "/",
        "httpOnly": bool(entry.get("httpOnly", False)),
        "secure": bool(entry.get("secure", True)),
    }
    domain = entry.get("domain")
    if isinstance(domain, str) and domain:
        cookie["domain"] = domain

    # Cookie-Editor writes expirationDate; Playwright writes expires.
    expires = entry.get("expires", entry.get("expirationDate", -1))
    if isinstance(expires, (int, float)):
        cookie["expires"] = float(expires)

    same_site = entry.get("sameSite")
    if isinstance(same_site, str):
        # Chrome exports use lowercase ("no_restriction"/"lax"/"strict").
        canonical = {
            "lax": "Lax",
            "strict": "Strict",
            "none": "None",
            "no_restriction": "None",
            "unspecified": "Lax",
        }.get(same_site.lower())
        if canonical:
            cookie["sameSite"] = canonical
    return cookie


def _looks_netscape(text: str) -> bool:
    """True when any non-comment line has the seven tab-separated Netscape fields."""
    for line in text.splitlines():
        if not line.strip() or (line.startswith("#") and not line.startswith(_HTTPONLY_PREFIX)):
            continue
        if len(line.split("\t")) == _NETSCAPE_FIELDS:
            return True
    return False


def _parse_netscape(text: str) -> list[dict[str, Any]]:
    """Parse Netscape ``cookies.txt`` rows into cookie dicts."""
    cookies: list[dict[str, Any]] = []
    for line in text.splitlines():
        raw = line.strip("\n")
        if not raw.strip():
            continue

        http_only = raw.startswith(_HTTPONLY_PREFIX)
        if http_only:
            raw = raw[len(_HTTPONLY_PREFIX) :]
        elif raw.lstrip().startswith("#"):
            continue

        parts = raw.split("\t")
        if len(parts) != _NETSCAPE_FIELDS:
            continue

        domain, _include_sub, path, secure, expires, name, value = parts
        if not name:
            continue

        try:
            expiry = float(expires)
        except ValueError:
            expiry = -1.0

        cookies.append(
            {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path or "/",
                "expires": expiry,
                "secure": secure.strip().upper() == "TRUE",
                "httpOnly": http_only,
            }
        )
    if not cookies:
        raise CookieImportError("No Netscape cookie rows were readable.")
    return cookies


def _parse_cookie_header(text: str) -> list[dict[str, Any]]:
    """Parse a raw ``Cookie: a=b; c=d`` header into cookie dicts."""
    body = text.strip()
    if body.lower().startswith("cookie:"):
        body = body.split(":", 1)[1]

    cookies: list[dict[str, Any]] = []
    for pair in body.split(";"):
        chunk = pair.strip()
        if not chunk or "=" not in chunk:
            continue
        name, _, value = chunk.partition("=")
        name = name.strip()
        if name:
            cookies.append({"name": name, "value": value.strip()})
    if not cookies:
        raise CookieImportError("No name=value pairs were readable from the header.")
    return cookies


def filter_domain(
    cookies: Iterable[dict[str, Any]], *, suffix: str = SHOPEE_DOMAIN_SUFFIX
) -> list[dict[str, Any]]:
    """Keep only cookies on ``suffix``, plus any that carry no domain at all.

    A raw ``Cookie:`` header has no domain field — those entries were copied off
    a Shopee request by hand, so they are kept and the session module stamps the
    default domain on them later.

    Args:
        cookies: Parsed cookies.
        suffix: Domain suffix to keep, without a leading dot.

    Returns:
        The kept cookies, order preserved.
    """
    kept: list[dict[str, Any]] = []
    for cookie in cookies:
        domain = cookie.get("domain")
        if not isinstance(domain, str) or not domain:
            kept.append(cookie)
            continue
        if domain.lstrip(".").lower().endswith(suffix.lower()):
            kept.append(cookie)
    return kept


def summarize(
    parsed: Iterable[dict[str, Any]],
    kept: Iterable[dict[str, Any]],
    *,
    source_format: str,
    user_agent: str | None = None,
) -> ImportSummary:
    """Describe an import without exposing a single cookie value.

    Args:
        parsed: Cookies before domain filtering.
        kept: Cookies after domain filtering.
        source_format: Which parser matched.
        user_agent: UA carried by the export, if any.

    Returns:
        A value-free summary suitable for printing.
    """
    parsed_list = list(parsed)
    kept_list = list(kept)
    names = tuple(sorted({str(cookie.get("name", "")) for cookie in kept_list} - {""}))
    return ImportSummary(
        source_format=source_format,
        total=len(parsed_list),
        kept=len(kept_list),
        names=names,
        authenticated=any(name in names for name in AUTHENTICATED_COOKIES),
        user_agent=user_agent,
    )
