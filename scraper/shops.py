"""The list of shops worth watching, read from ``config/stores.txt``.

One file, two consumers that never speak to each other: ``ecom-scraper run
--mode store`` walks it from the terminal, and the browser extension's batch run
asks the ingest server for it over ``GET /shops``. Parsing it in one module is
what keeps them from disagreeing about what a line meant — a disagreement that
would show up as "the extension scraped a shop the CLI has never heard of".

The file is deliberately hand-editable and deliberately not the ``stores`` table.
The table records every shop a scrape happened to walk past; this file records
the shops someone chose. The dashboard bridges the two by *exporting* a
stores.txt from the table for a human to trim and save — see
``dashboard/src/app/api/stores/export``.

Line format::

    shopee/erigostore              marketplace named
    tokopedia/eiger-official
    erigostore                     no marketplace: Shopee, the format that
                                   predates Tokopedia support
    https://shopee.co.id/erigostore   a pasted storefront URL
    # a comment                    ignored, as are blank lines

A line that names a marketplace this project does not scrape is dropped rather
than raised on: the list is twenty lines maintained by hand, and one typo should
cost one shop, not the other nineteen.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from scraper.config import DEFAULT_STORES_FILE, load_lines, normalise_store_entry
from scraper.models import Marketplace

__all__ = [
    "ShopEntry",
    "parse_shop_line",
    "load_shop_entries",
    "resolve_stores_path",
    "DEFAULT_STORES_FILE",
]

log = logging.getLogger(__name__)

#: Hostname fragments that identify a marketplace in a pasted URL. Matched as a
#: suffix, so ``www.tokopedia.com`` and ``tokopedia.com`` both answer. Kept here
#: rather than imported from the adapters because this module is read by the
#: ingest server, whose import chain deliberately stays small (see
#: ``requirements.txt``).
_HOSTS: tuple[tuple[str, Marketplace], ...] = (
    ("shopee.co.id", Marketplace.SHOPEE),
    ("tokopedia.com", Marketplace.TOKOPEDIA),
)


@dataclass(frozen=True, slots=True)
class ShopEntry:
    """One line of the file: which marketplace, and the shop's URL slug.

    Frozen and hashable so de-duplication is a set membership test rather than a
    hand-rolled key, and so a parsed list can be shared without a caller being
    able to edit another caller's copy.
    """

    marketplace: Marketplace
    slug: str


def _marketplace_from_url(text: str) -> Marketplace | None:
    """Which marketplace a pasted URL points at, or None if it is not one."""
    host = urlsplit(text).hostname or ""
    host = host.lower()
    for suffix, marketplace in _HOSTS:
        if host == suffix or host.endswith(f".{suffix}"):
            return marketplace
    return None


def parse_shop_line(line: str) -> ShopEntry | None:
    """Reduce one raw line to a :class:`ShopEntry`, or None if it names no shop.

    Args:
        line: One line from the file, comments and blanks already dropped by
            :func:`scraper.config.load_lines` — though this tolerates surrounding
            whitespace so it can also be called on something typed inline.

    Returns:
        The entry, or None when the marketplace is unknown or nothing is left
        after the prefix (``tokopedia/`` names no shop). The caller drops it.
    """
    text = line.strip()
    if not text:
        return None

    # A URL says which site it is by itself, and it is the likeliest thing to be
    # pasted here. Checked before the prefix split, because `https://` contains
    # the same slash the prefix uses.
    if "://" in text:
        marketplace = _marketplace_from_url(text)
        if marketplace is None:
            log.warning("stores.txt: not a marketplace this project scrapes: %s", text)
            return None
        # Tokopedia storefronts live at `/<shop>` and products at
        # `/<shop>/<product>`, so the shop is the first path segment. Shopee
        # storefronts are `/<shop>` too, and `normalise_store_entry` takes the
        # last segment — which is the same thing for a storefront URL and the
        # wrong thing for a product URL.
        path = urlsplit(text).path.strip("/")
        slug = path.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
        return ShopEntry(marketplace, slug.lower()) if slug else None

    marketplace = Marketplace.SHOPEE
    if "/" in text:
        prefix, _, rest = text.partition("/")
        try:
            marketplace = Marketplace(prefix.strip().lower())
        except ValueError:
            log.warning("stores.txt: unknown marketplace %r, line ignored", prefix)
            return None
        text = rest

    slug = normalise_store_entry(text).lower()
    return ShopEntry(marketplace, slug) if slug else None


def resolve_stores_path(path: str | Path = DEFAULT_STORES_FILE) -> Path:
    """Turn a configured list path into one that does not depend on the CWD.

    The CLI runs from the checkout, so ``config/stores.txt`` finds itself. The
    ingest server does not: launchd starts it from ``/``, and Vercel from its own
    build root. An absolute path is honoured as given — that is how a list kept
    outside the repository is pointed at.

    Args:
        path: Configured path, absolute or relative.

    Returns:
        An absolute path, relative ones anchored at the repository root.
    """
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate
    return Path(__file__).resolve().parent.parent / candidate


def load_shop_entries(path: str | Path = DEFAULT_STORES_FILE) -> list[ShopEntry]:
    """Read the shop list, in file order, without repeats.

    Order matters: a batch run walks these top to bottom, so the file is also the
    schedule. De-duplication is per ``(marketplace, slug)`` — the same slug on
    two marketplaces is two different shops, and one of this project's tracked
    brands really does hold both.

    Args:
        path: The list file. Defaults to ``config/stores.txt``.

    Returns:
        Ordered, de-duplicated entries. A file of nothing but comments yields an
        empty list, which is a real answer: "no shops chosen yet".

    Raises:
        FileNotFoundError: If ``path`` does not exist. The ingest server turns
            that into an empty list with an explanation; the CLI turns it into a
            usage error.
    """
    seen: set[ShopEntry] = set()
    entries: list[ShopEntry] = []
    for line in load_lines(path):
        entry = parse_shop_line(line)
        if entry is None or entry in seen:
            continue
        seen.add(entry)
        entries.append(entry)
    return entries
