"""Tests for :mod:`scraper.shops` — parsing ``config/stores.txt``.

The file is the one place a human says which shops matter, and it is now read by
two consumers that cannot ask each other what a line meant: the CLI's
``--mode store`` and the browser extension's batch run, over ``GET /shops``. So
the rules are pinned here rather than in either caller.

Nothing in this module touches the network, the database or the filesystem
beyond a ``tmp_path`` file.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from scraper.models import Marketplace
from scraper.shops import ShopEntry, load_shop_entries, parse_shop_line


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "stores.txt"
    path.write_text(body, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# One line at a time
# ---------------------------------------------------------------------------


def test_a_bare_slug_is_shopee() -> None:
    """The format every existing stores.txt is written in still means what it did.

    Shopee was the only marketplace when the file was invented, so a line that
    names no marketplace is the old file, not an ambiguous one.
    """
    assert parse_shop_line("erigostore") == ShopEntry(Marketplace.SHOPEE, "erigostore")


def test_a_prefixed_line_names_its_marketplace() -> None:
    assert parse_shop_line("tokopedia/eiger-official") == ShopEntry(
        Marketplace.TOKOPEDIA, "eiger-official"
    )


def test_the_prefix_is_case_insensitive() -> None:
    """Typed by a human, so 'Shopee/erigostore' is the same instruction."""
    assert parse_shop_line("Shopee/Erigostore") == ShopEntry(Marketplace.SHOPEE, "erigostore")


@pytest.mark.parametrize(
    "line",
    [
        "https://shopee.co.id/erigostore",
        "https://shopee.co.id/erigostore?foo=bar#frag",
        "@erigostore",
        "  erigostore  ",
        "shopee/@erigostore",
    ],
)
def test_the_forms_a_human_pastes_all_reduce_to_the_slug(line: str) -> None:
    """A pasted storefront URL is the likeliest way this file gets filled in."""
    assert parse_shop_line(line) == ShopEntry(Marketplace.SHOPEE, "erigostore")


def test_a_pasted_tokopedia_url_keeps_its_marketplace() -> None:
    """The host says which site it is, so no prefix is needed to paste one in."""
    assert parse_shop_line("https://www.tokopedia.com/eiger-official") == ShopEntry(
        Marketplace.TOKOPEDIA, "eiger-official"
    )


def test_a_tokopedia_product_url_is_still_only_its_shop() -> None:
    """`/<shop>/<product-slug>` is a product page; the shop is the first segment."""
    assert parse_shop_line(
        "https://www.tokopedia.com/eiger-official/tas-gunung-40l"
    ) == ShopEntry(Marketplace.TOKOPEDIA, "eiger-official")


def test_an_unknown_marketplace_is_not_a_shop() -> None:
    """Returned as None so the caller can drop the line and keep the other 19."""
    assert parse_shop_line("lazada/whatever") is None


def test_a_prefix_with_no_slug_is_not_a_shop() -> None:
    assert parse_shop_line("tokopedia/") is None


# ---------------------------------------------------------------------------
# The file
# ---------------------------------------------------------------------------


def test_blank_lines_and_comments_are_ignored(tmp_path: Path) -> None:
    path = write(
        tmp_path,
        "# a comment\n\n  \nshopee/erigostore\n# another\ntokopedia/eiger-official\n",
    )
    assert load_shop_entries(path) == [
        ShopEntry(Marketplace.SHOPEE, "erigostore"),
        ShopEntry(Marketplace.TOKOPEDIA, "eiger-official"),
    ]


def test_file_order_is_the_run_order(tmp_path: Path) -> None:
    """A batch walks these in order, so the file is also the schedule."""
    path = write(tmp_path, "c\nb\na\n")
    assert [entry.slug for entry in load_shop_entries(path)] == ["c", "b", "a"]


def test_repeats_are_dropped_but_the_same_slug_on_two_sites_is_not(tmp_path: Path) -> None:
    """`erigostore` on Shopee and on Tokopedia are two shops, not one."""
    path = write(
        tmp_path,
        "shopee/erigostore\nerigostore\nshopee/ERIGOSTORE\ntokopedia/erigostore\n",
    )
    assert load_shop_entries(path) == [
        ShopEntry(Marketplace.SHOPEE, "erigostore"),
        ShopEntry(Marketplace.TOKOPEDIA, "erigostore"),
    ]


def test_one_bad_line_does_not_lose_the_good_ones(tmp_path: Path) -> None:
    """The whole point of a 20-shop list: a typo costs one shop, not the sweep."""
    path = write(tmp_path, "shopee/erigostore\nlazada/nope\ntokopedia/eiger-official\n")
    assert [entry.slug for entry in load_shop_entries(path)] == [
        "erigostore",
        "eiger-official",
    ]


def test_a_missing_file_is_an_error_the_caller_can_answer(tmp_path: Path) -> None:
    """`/shops` turns this into an empty list; the CLI turns it into exit 2."""
    with pytest.raises(FileNotFoundError):
        load_shop_entries(tmp_path / "not-here.txt")


def test_the_repo_default_file_parses(tmp_path: Path) -> None:
    """`config/stores.txt` as committed is a valid list, not just an example."""
    entries = load_shop_entries(Path("config/stores.txt"))
    assert entries, "the committed stores.txt should hold at least one shop"
    assert all(isinstance(entry, ShopEntry) for entry in entries)
