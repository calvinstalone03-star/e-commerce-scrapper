"""Set-number extraction, over the shapes sellers actually type.

A wrong answer here is worse than a missing one: a title whose piece count is
read as a set number matches our product against an unrelated box, and the
dashboard then reports a price gap that does not exist. So the negative cases
carry as much weight as the positive ones.
"""

from __future__ import annotations

import pytest

from scraper.set_code import extract_set_code


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # Straightforward: theme, number, description.
        ("LEGO Technic 42218 John Deere 9RX", "42218"),
        ("LEGO Jurassic World 76950 Triceratops Pickup", "76950"),
        ("LEGO Creator 31379 Fierce Dinosaur (2 in 1)", "31379"),
        # Number first, theme after — equally common in Indonesian listings.
        ("42218 LEGO Technic John Deere Tractor", "42218"),
        ("Lego Technic 42218 - John Deere 9RX Tractor Mainan Anak", "42218"),
        # A piece count in the same title must not win.
        ("LEGO City 60486 EV Supercar (109 Pieces)", "60486"),
        ("LEGO Minifigures 71052 Series 29 (8 Pieces)", "71052"),
        ("LEGO DUPLO 10451 3in1 Dinosaurs usia 2-5 tahun", "10451"),
        # Four-digit sets exist; they are simply outranked when a five-digit
        # number is also present.
        ("LEGO Classic 4002 Small Brick Box", "4002"),
        # Case and separators are noise.
        ("lego technic 42218", "42218"),
        ("LEGO#76950 Triceratops", "76950"),
        ("LEGO (76950) Triceratops Pickup", "76950"),
    ],
)
def test_extracts_the_set_number(name: str, expected: str) -> None:
    assert extract_set_code(name) == expected


@pytest.mark.parametrize(
    "name",
    [
        # Piece counts glued to the unit — the single most common false positive.
        "1000Pcs Mainan Balok Minicraft 3D Model Puzzle",
        "Mainan Blok 1442Pcs Besar kapal induk Ship",
        "Balok Susun 2000 pieces edukasi anak",
        # Money.
        "Mainan Edukasi Anak Rp 145000 Free Ongkir",
        "Promo Balok IDR 250000",
        # Grouped numbers are money or counts, never catalogue numbers.
        "Mainan Balok 1.500 pcs Besar",
        "Diskon Mainan 145.000 Termurah",
        # Nothing numeric that could be a set at all.
        "Kidstiful Mainan 6IN1 Tiger SWAT Model Mainan Anak",
        "Mainan Balok Susun Edukasi Anak Laki Laki",
        # Too short and too long to be a set number.
        "LEGO Series 29",
        "SKU 123456789 Mainan Balok",
    ],
)
def test_rejects_numbers_that_are_not_set_codes(name: str) -> None:
    assert extract_set_code(name) is None


@pytest.mark.parametrize("name", [None, "", "   "])
def test_handles_missing_names(name: str | None) -> None:
    assert extract_set_code(name) is None


def test_prefers_the_five_digit_candidate() -> None:
    # A five-digit set beside a bare four-digit number: the set wins, because a
    # title holding both is nearly always one set plus one stray figure.
    assert extract_set_code("LEGO 76950 Triceratops 2022 Edition") == "76950"


def test_does_not_bite_into_a_longer_number() -> None:
    # The tail of an item id is not a set number.
    assert extract_set_code("Mainan Balok i.312618972.11873898243") is None
