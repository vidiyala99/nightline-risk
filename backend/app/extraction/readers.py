"""Format readers: bytes -> RawTable. The ONLY extraction unit touching file I/O.

CSV is stdlib + deterministic. xlsx uses openpyxl and detects the header row
(carrier loss runs often lead with a logo/metadata row). PDF is intentionally
absent in v1 (the LLM/OCR seam, per the spec)."""
from __future__ import annotations

import csv
import io

from app.extraction.schema import RawTable
from app.extraction.synonyms import resolve_header


def read_table(data: bytes, fmt: str) -> RawTable:
    if fmt == "csv":
        return _read_csv(data)
    if fmt == "xlsx":
        return _read_xlsx(data)
    raise ValueError(f"unsupported loss-run format {fmt!r} (v1 supports csv, xlsx)")


def _nonblank(grid: list[list[str]]) -> list[list[str]]:
    return [row for row in grid if any(c.strip() for c in row)]


def _read_csv(data: bytes) -> RawTable:
    text = data.decode("utf-8-sig", errors="replace")
    grid = _nonblank([list(r) for r in csv.reader(io.StringIO(text))])
    if not grid:
        return RawTable(header=[], rows=[])
    return RawTable(header=grid[0], rows=grid[1:])


def _detect_header(grid: list[list[str]]) -> int:
    """First row (within the first 10) matching >=2 known headers; else row 0."""
    for i, row in enumerate(grid[:10]):
        if sum(1 for c in row if resolve_header(c)[0]) >= 2:
            return i
    return 0


def _read_xlsx(data: bytes) -> RawTable:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.active
    grid = _nonblank([
        ["" if c is None else str(c) for c in row]
        for row in ws.iter_rows(values_only=True)
    ])
    if not grid:
        return RawTable(header=[], rows=[])
    h = _detect_header(grid)
    return RawTable(header=grid[h], rows=grid[h + 1:])
