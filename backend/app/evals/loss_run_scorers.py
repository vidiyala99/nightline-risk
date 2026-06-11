"""Deterministic, key-free eval for loss-run extraction. Mirrors fraud_scorer.py.

- score_field_mapping: header synonyms resolve to the right canonical field.
- score_confidence_calibration: a clean cell keeps high confidence; a garbled
  money cell on a mapped field drops to <=0.5 (raw retained)."""
from __future__ import annotations

from app.extraction.loss_run_parser import parse_loss_run
from app.extraction.schema import RawTable
from app.extraction.synonyms import resolve_header

# (raw_header, expected_canonical_field)
_HEADER_FIXTURES: list[tuple[str, str]] = [
    ("Date of Loss", "date_of_loss"), ("DOL", "date_of_loss"), ("Loss Date", "date_of_loss"),
    ("Coverage", "coverage_line"), ("Line of Business", "coverage_line"),
    ("Net Paid", "paid"), ("Total Paid", "paid"), ("Indemnity Paid", "paid"),
    ("Outstanding", "reserve"), ("Case Reserve", "reserve"),
    ("Total Incurred", "incurred"), ("Claim No", "carrier_claim_number"), ("Status", "claim_status"),
]


def score_field_mapping() -> dict:
    correct, misses = 0, []
    for header, expected in _HEADER_FIXTURES:
        got, _conf = resolve_header(header)
        if got == expected:
            correct += 1
        else:
            misses.append(f"{header!r}: expected {expected}, got {got}")
    return {"accuracy": round(correct / len(_HEADER_FIXTURES), 3), "n": len(_HEADER_FIXTURES), "misses": misses}


def score_confidence_calibration() -> dict:
    table = RawTable(header=["Date of Loss", "Paid"], rows=[["2026-05-01", "$100.00"], ["2026-05-02", "N/A"]])
    clean, garbled = parse_loss_run(table)
    passed = clean.field_confidence["paid"] >= 0.9 and garbled.field_confidence["paid"] <= 0.5
    return {"passed": bool(passed),
            "clean_paid_conf": clean.field_confidence["paid"],
            "garbled_paid_conf": garbled.field_confidence["paid"]}
