"""Deterministic loss-run parser: RawTable -> [ExtractedLossRunRow].

Default path is pure + key-free. An injected `extractor` (same signature) is the
LLM/PDF seam — mirrors app/ingestion/comms/classifier.py. The parser NEVER persists.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Callable, Optional

from app.extraction.schema import ExtractedLossRunRow, RawTable
from app.extraction.synonyms import normalize_coverage_line, resolve_header

_MONEY_FIELDS = {"reserve", "paid", "incurred"}
_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d %H:%M:%S")


def _coerce(field_name: str, cell: str) -> tuple[object, bool]:
    """Coerce a cell for its field. Returns (value, ok). ok=False -> value None."""
    if field_name in _MONEY_FIELDS:
        cleaned = cell.replace("$", "").replace(",", "").replace("(", "-").replace(")", "").strip()
        try:
            return Decimal(cleaned).quantize(Decimal("0.01")), True
        except (InvalidOperation, ValueError):
            return None, False
    if field_name == "date_of_loss":
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(cell, fmt).date(), True
            except ValueError:
                continue
        return None, False
    return cell, True  # free-text fields pass through


def parse_loss_run(
    table: RawTable,
    *,
    extractor: Optional[Callable[[RawTable], list[ExtractedLossRunRow]]] = None,
) -> list[ExtractedLossRunRow]:
    if extractor is not None:
        return extractor(table)

    # First column wins on duplicate canonical mapping.
    col_map: dict[int, tuple[str, float]] = {}
    seen: set[str] = set()
    for idx, header in enumerate(table.header):
        field_name, conf = resolve_header(header)
        if field_name and field_name not in seen:
            col_map[idx] = (field_name, conf)
            seen.add(field_name)

    out: list[ExtractedLossRunRow] = []
    for raw_row in table.rows:
        fields: dict[str, object] = {}
        confidence: dict[str, float] = {}
        raw_values: dict[str, str] = {}
        for idx, (field_name, hconf) in col_map.items():
            cell = raw_row[idx] if idx < len(raw_row) else ""
            cell = "" if cell is None else str(cell).strip()
            if cell == "":
                continue
            raw_values[field_name] = cell
            value, ok = _coerce(field_name, cell)
            fields[field_name] = value
            confidence[field_name] = hconf if ok else 0.5
        if not raw_values:
            continue  # fully-empty row
        if "coverage_line" in fields and fields["coverage_line"] is not None:
            fields["coverage_line"] = normalize_coverage_line(str(fields["coverage_line"]))
        out.append(ExtractedLossRunRow(field_confidence=confidence, raw_values=raw_values, **fields))
    return out
