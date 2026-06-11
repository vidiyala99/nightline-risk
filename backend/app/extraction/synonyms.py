"""Canonical-field <-> header-synonym map + coverage-line normalization.

The deterministic brain of loss-run extraction: the LLM seam later AUGMENTS this
(unknown headers), it does not replace it. The eval scorers guard this table.
"""
from __future__ import annotations

import re

# canonical_field -> set of header synonyms (the canonical name itself scores 1.0)
CANONICAL_HEADERS: dict[str, set[str]] = {
    "date_of_loss": {"date of loss", "loss date", "dol", "date of occurrence", "occurrence date"},
    "coverage_line": {"coverage", "coverage line", "line of business", "lob", "coverage type"},
    "claim_status": {"status", "claim status", "open closed"},
    "claimant": {"claimant", "claimant name", "injured party"},
    "description": {"description", "loss description", "cause", "narrative", "loss detail"},
    "carrier_claim_number": {"claim number", "claim no", "carrier claim number", "claim id"},
    "reserve": {"reserve", "reserves", "outstanding", "outstanding reserve", "case reserve"},
    "paid": {"paid", "total paid", "paid total", "indemnity paid", "net paid", "loss paid", "amount paid"},
    "incurred": {"incurred", "total incurred", "incurred total", "net incurred"},
}

COVERAGE_LINE_MAP: dict[str, str] = {
    "gl": "general_liability", "cgl": "general_liability", "general liability": "general_liability",
    "liquor": "liquor_liability", "liquor liability": "liquor_liability", "dram shop": "liquor_liability",
    "assault": "assault_battery", "a b": "assault_battery", "assault and battery": "assault_battery",
    "assault battery": "assault_battery", "property": "property", "prop": "property",
}


def _norm(s: str) -> str:
    """Lowercase, collapse any non-alphanumeric run to a single space, trim."""
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def resolve_header(raw_header: str) -> tuple[str | None, float]:
    """Map a raw header to (canonical_field, confidence). Exact canonical name -> 1.0;
    known synonym -> 0.9; unknown -> (None, 0.0)."""
    n = _norm(raw_header)
    for field_name in CANONICAL_HEADERS:
        if n == field_name.replace("_", " "):
            return field_name, 1.0
    for field_name, syns in CANONICAL_HEADERS.items():
        if n in {_norm(s) for s in syns}:
            return field_name, 0.9
    return None, 0.0


def normalize_coverage_line(raw: str) -> str:
    """Map a coverage-line cell to a canonical line; unmapped -> normalized raw."""
    return COVERAGE_LINE_MAP.get(_norm(raw), _norm(raw))
