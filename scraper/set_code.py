"""Pull a LEGO set number out of a listing title.

Why this exists rather than a ``similarity()`` call at query time: two listings
that carry the same set number are the same box, whatever words surround it,
while trigram similarity is least trustworthy exactly where it matters most.
``LEGO Technic 42217 John Deere`` and ``LEGO Technic 42218 John Deere 9RX``
score 0.86 against each other and are different products; ``LEGO 42218`` and the
full title of the same set score 0.31 and are the same one. The number decides,
and names are only the fallback for listings that carry no number at all.

The rules below are all consequences of what sellers actually type. A title is
not a catalogue entry — it is a keyword-stuffed advertisement, and most of the
digits in it are not the set:

    "1000Pcs Mainan Balok Minicraft 3D Model Puzzle"
    "LEGO City 60486 EV Supercar (109 Pieces)"
    "Lego Duplo 10451 3in1 Dinosaurs usia 2-5 tahun"
    "LEGO Minifigures 71052 Series 29 (8 Pieces)"

So: a run of 4-7 digits standing on its own, rejected when a unit follows it or
a currency marker precedes it, and when more than one candidate survives, the
five-digit one wins — modern LEGO sets are almost always five digits, and a
title carrying both a set number and some other four-digit number is far more
often a set plus a piece count than two sets.

Extraction happens on the way in, into ``products.set_code``, so the rules can
be tuned and re-run over stored names (``ecom-scraper backfill-set-codes``)
without re-scraping anything.
"""

from __future__ import annotations

import re

__all__ = ["extract_set_code", "SET_CODE_PATTERN"]


#: A standalone run of 4-7 digits. The lookarounds keep it from biting into a
#: longer number or an alphanumeric code: the 7 in "76950-7" is not a set, and
#: neither is the tail of "SKU12345678".
SET_CODE_PATTERN = re.compile(r"(?<![\w\d])(\d{4,7})(?![\w\d])")

#: Words that turn the number before them into a count, a size or a weight.
#: "109 Pieces" is how many bricks are in the box, not which box it is. ``rb``
#: and ``jt`` are Indonesian thousands/millions and mark a price or a sold count.
#:
#: The trailing lookahead is what makes the single-letter units safe. Without it
#: the ``l`` of litre matched the L of "42218 LEGO Technic" and threw away the
#: set number of every listing that put the number first.
#:
#: "set" is deliberately absent. It is a unit in "2 set", but sellers also write
#: "42218 Set Technic", and losing a real set number costs more than admitting
#: the occasional count.
_UNIT_AFTER = re.compile(
    r"^\s*(?:"
    r"pieces|piece|pcs|pc|buah|biji|"
    r"cm|mm|kg|gram|gr|ml|"
    r"rb|jt|"
    r"tahun|thn|bulan|hari|"
    r"watt|volt|"
    r"[mklwv]"
    r")(?![a-z])",
    re.IGNORECASE,
)

#: Markers that turn the number after them into money. Indonesian listings write
#: "Rp 145000" and "IDR145.000" with equal enthusiasm.
_MONEY_BEFORE = re.compile(r"(?:rp|idr|harga|price)\s*$", re.IGNORECASE)

#: A number written with thousands separators is money or a piece count, never a
#: set: "145.000" and "1,500" are not catalogue numbers.
_GROUPED_NUMBER = re.compile(r"[.,]\s*$")


def _is_candidate(text: str, match: re.Match[str]) -> bool:
    """Decide whether one digit run is plausibly a set number.

    Args:
        text: The full title the run was found in.
        match: The regex match for the run.

    Returns:
        True when nothing around the run marks it as a count, a price, a size or
        part of a grouped number.
    """
    before = text[: match.start()]
    after = text[match.end() :]

    if _MONEY_BEFORE.search(before):
        return False
    # "145.000" arrives here as a match on "000" preceded by "145." — and as a
    # match on "145" followed by ".000" when the run is long enough. Both halves
    # are rejected by looking for the separator on either side.
    if _GROUPED_NUMBER.search(before):
        return False
    if re.match(r"^[.,]\d", after):
        return False
    if _UNIT_AFTER.match(after):
        return False
    return True


def extract_set_code(name: str | None) -> str | None:
    """Return the LEGO set number in ``name``, or None when there is none.

    Args:
        name: Listing title as the marketplace rendered it.

    Returns:
        The set number as a string — it is an identifier, not a quantity, and
        leading zeros in older sets are part of it — or None when the title
        carries no number that survives the rules above.

    Examples:
        >>> extract_set_code("LEGO Technic 42218 John Deere 9RX")
        '42218'
        >>> extract_set_code("LEGO City 60486 EV Supercar (109 Pieces)")
        '60486'
        >>> extract_set_code("1000Pcs Mainan Balok Minicraft") is None
        True
    """
    if not name:
        return None

    text = str(name)
    candidates = [
        match.group(1) for match in SET_CODE_PATTERN.finditer(text) if _is_candidate(text, match)
    ]
    if not candidates:
        return None

    # Five digits first: that is the shape of every LEGO set from the last two
    # decades, and a title holding both a five-digit and a four-digit number is
    # nearly always one set plus one piece count.
    for width in (5, 6, 4, 7):
        for candidate in candidates:
            if len(candidate) == width:
                return candidate

    return candidates[0]
