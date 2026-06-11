# Loss-Run Extraction (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an uploaded CSV/xlsx loss-run document into canonical, confidence-scored structured rows persisted as a review-only artifact (no auto-create of money rows), readable by broker + carrier.

**Architecture:** A pure deterministic pipeline — `readers.read_table(bytes, fmt) → RawTable`, then `loss_run_parser.parse_loss_run(table) → [ExtractedLossRunRow]` (header-synonym mapping + cell coercion + per-field confidence). A service persists `LossRunImport` + `LossRunImportRow` with an `AIProvenance` stamp + audit event; a router exposes upload/list/detail/link. An optional injected `extractor` is the future LLM/PDF seam (mirrors `app/ingestion/comms/classifier.py`). Eval scorers are deterministic + key-free (siblings of `app/evals/fraud_scorer.py`).

**Tech Stack:** Python, FastAPI, SQLModel/SQLAlchemy, Pydantic, `openpyxl` (new), stdlib `csv`. Tests: pytest + `fastapi.testclient.TestClient`.

**Spec:** `docs/superpowers/specs/2026-06-10-loss-run-extraction-design.md`

**Conventions (from CLAUDE.md):** money is `Decimal` / `Numeric(12,2)` / JSON-as-string (`app.money`); timestamps `Field(default_factory=now_utc, sa_type=DateTimeUTC)`; column-level FK → `session.flush()` parent before children; coerce `Column(JSON)` at the read boundary (Postgres returns strings); all bytes through `app/storage.py`; services raise typed errors, routers map to HTTP; services never `commit()` (the router owns it).

**All `pytest` commands run from `backend/`.**

---

### Task 1: Safe-filename helper

A shared `sanitize_filename` (the evidence route has a private copy; v1 gets its own in a neutral module so the service layer doesn't import from a route module). Same defense: basename only, strip control chars/quotes/leading dots.

**Files:**
- Create: `backend/app/files.py`
- Test: `backend/tests/test_files.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_files.py
from app.files import sanitize_filename


def test_strips_path_traversal_and_separators():
    assert sanitize_filename("../../etc/passwd") == "passwd"
    assert sanitize_filename(r"..\\..\\windows\\sys.ini") == "sys.ini"


def test_strips_control_chars_and_quotes_and_leading_dots():
    assert sanitize_filename('lo"ss\r\nrun.csv') == "lossrun.csv"
    assert sanitize_filename("..") == "upload"
    assert sanitize_filename(None) == "upload"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_files.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.files'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/files.py
"""Filename safety helper shared by upload paths (path-traversal + header injection).

A neutral home so service-layer code can import it without depending on a route
module. The evidence route keeps its own private `_sanitize_filename` for now
(security-critical, separately TDD'd); consolidate in a follow-up.
"""
from __future__ import annotations

import re

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def sanitize_filename(raw: str | None) -> str:
    """Reduce a client-supplied filename to a safe basename (falls back to 'upload')."""
    if not raw:
        return "upload"
    basename = raw.replace("\\", "/").split("/")[-1]
    cleaned = _CONTROL_CHARS.sub("", basename).replace('"', "")
    cleaned = cleaned.lstrip(". ").strip()
    return cleaned or "upload"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_files.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/files.py backend/tests/test_files.py
git commit -m "feat(files): shared sanitize_filename helper"
```

---

### Task 2: Extraction schema + header synonyms

Typed dataclasses (`ExtractedLossRunRow`, `RawTable`) and the canonical-field ↔ header-synonym map — the deterministic brain. No file I/O.

**Files:**
- Create: `backend/app/extraction/__init__.py` (empty)
- Create: `backend/app/extraction/schema.py`
- Create: `backend/app/extraction/synonyms.py`
- Test: `backend/tests/test_loss_run_synonyms.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_loss_run_synonyms.py
from app.extraction.synonyms import normalize_coverage_line, resolve_header


def test_exact_canonical_header_is_full_confidence():
    assert resolve_header("Date of Loss") == ("date_of_loss", 1.0)


def test_known_synonym_is_high_confidence():
    assert resolve_header("DOL") == ("date_of_loss", 0.9)
    assert resolve_header("Net Paid") == ("paid", 0.9)
    assert resolve_header("Outstanding") == ("reserve", 0.9)


def test_unknown_header_is_unmapped():
    assert resolve_header("Random Column") == (None, 0.0)


def test_coverage_line_normalization():
    assert normalize_coverage_line("A&B") == "assault_battery"
    assert normalize_coverage_line("General Liability") == "general_liability"
    assert normalize_coverage_line("Mystery Line") == "mystery line"  # unmapped → normalized raw
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_synonyms.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.extraction'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/extraction/__init__.py
```

```python
# backend/app/extraction/schema.py
"""Typed loss-run extraction primitives — pure, no I/O."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal


@dataclass
class RawTable:
    """Format-agnostic handoff from a reader to the parser."""
    header: list[str]
    rows: list[list[str]]


@dataclass
class ExtractedLossRunRow:
    """One canonical loss row. `field_confidence` maps canonical field -> 0..1;
    `raw_values` retains the original cell text per mapped field (audit)."""
    date_of_loss: date | None = None
    coverage_line: str | None = None
    claim_status: str | None = None
    claimant: str | None = None
    description: str | None = None
    carrier_claim_number: str | None = None
    reserve: Decimal | None = None
    paid: Decimal | None = None
    incurred: Decimal | None = None
    field_confidence: dict = field(default_factory=dict)
    raw_values: dict = field(default_factory=dict)
```

```python
# backend/app/extraction/synonyms.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_synonyms.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/extraction/__init__.py backend/app/extraction/schema.py backend/app/extraction/synonyms.py backend/tests/test_loss_run_synonyms.py
git commit -m "feat(extraction): loss-run schema + header synonym map"
```

---

### Task 3: Deterministic parser

`parse_loss_run(table) -> [ExtractedLossRunRow]`: map columns, coerce cells (money/date), assign per-field confidence (coercion failure on a mapped field drops confidence to 0.5, raw retained). Optional `extractor` is the LLM/PDF seam.

**Files:**
- Create: `backend/app/extraction/loss_run_parser.py`
- Test: `backend/tests/test_loss_run_parser.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_loss_run_parser.py
from datetime import date
from decimal import Decimal

from app.extraction.schema import RawTable
from app.extraction.loss_run_parser import parse_loss_run


def test_maps_synonym_headers_and_coerces_values():
    table = RawTable(
        header=["DOL", "Coverage", "Net Paid", "Outstanding", "Claim No"],
        rows=[["05/01/2026", "A&B", "$1,200.50", "500", "CL-9"]],
    )
    [row] = parse_loss_run(table)
    assert row.date_of_loss == date(2026, 5, 1)
    assert row.coverage_line == "assault_battery"
    assert row.paid == Decimal("1200.50")
    assert row.reserve == Decimal("500.00")
    assert row.carrier_claim_number == "CL-9"
    assert row.field_confidence["paid"] == 0.9          # synonym header
    assert row.raw_values["paid"] == "$1,200.50"


def test_bad_money_cell_lowers_confidence_and_keeps_raw():
    table = RawTable(header=["Date of Loss", "Paid"], rows=[["2026-05-01", "N/A"]])
    [row] = parse_loss_run(table)
    assert row.paid is None
    assert row.field_confidence["paid"] == 0.5          # coercion failed on a mapped field
    assert row.raw_values["paid"] == "N/A"
    assert row.field_confidence["date_of_loss"] == 1.0  # exact header


def test_skips_rows_with_no_mapped_data():
    table = RawTable(header=["Paid"], rows=[["100"], ["   "], ["TOTAL"]])
    rows = parse_loss_run(table)
    assert [r.paid for r in rows] == [Decimal("100.00"), None]  # blank skipped; TOTAL kept (raw 'TOTAL' -> paid None? see note)


def test_extractor_seam_overrides_deterministic():
    sentinel = object()
    assert parse_loss_run(RawTable(header=[], rows=[]), extractor=lambda t: sentinel) is sentinel
```

> Note for `test_skips_rows_with_no_mapped_data`: a row whose only mapped cell is non-empty (`"TOTAL"`) is **kept** but coerces to `paid=None` (conf 0.5). A row that is entirely blank/whitespace is skipped. If you prefer to drop a `TOTAL`-only row, that's a follow-up heuristic — v1 keeps it visible with low confidence rather than silently dropping data.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_parser.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.extraction.loss_run_parser'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/extraction/loss_run_parser.py
"""Deterministic loss-run parser: RawTable -> [ExtractedLossRunRow].

Default path is pure + key-free. An injected `extractor` (same signature) is the
LLM/PDF seam — mirrors app/ingestion/comms/classifier.py. The parser NEVER persists.
"""
from __future__ import annotations

from datetime import date, datetime
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_parser.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/extraction/loss_run_parser.py backend/tests/test_loss_run_parser.py
git commit -m "feat(extraction): deterministic loss-run parser + confidence"
```

---

### Task 4: CSV + xlsx readers

`read_table(bytes, fmt) -> RawTable`. CSV via stdlib; xlsx via `openpyxl` with header-row detection (skip leading logo/metadata rows).

**Files:**
- Create: `backend/app/extraction/readers.py`
- Modify: `backend/requirements.txt` (add `openpyxl`)
- Test: `backend/tests/test_loss_run_readers.py`

- [ ] **Step 1: Add the dependency**

Append to `backend/requirements.txt`:
```
openpyxl>=3.1
```
Run: `pip install "openpyxl>=3.1"`
Expected: `Successfully installed openpyxl-...`

- [ ] **Step 2: Write the failing test**

```python
# backend/tests/test_loss_run_readers.py
import io

import openpyxl

from app.extraction.readers import read_table


def test_read_csv_uses_first_row_as_header_and_skips_blank_lines():
    data = b"Date of Loss,Paid\n2026-05-01,100\n\n2026-05-02,200\n"
    table = read_table(data, "csv")
    assert table.header == ["Date of Loss", "Paid"]
    assert table.rows == [["2026-05-01", "100"], ["2026-05-02", "200"]]


def test_read_xlsx_detects_header_row_past_metadata():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Acme Insurance — Loss Run"])   # logo/metadata row
    ws.append([])                               # blank
    ws.append(["Date of Loss", "Paid"])         # real header
    ws.append(["2026-05-01", 100])
    buf = io.BytesIO()
    wb.save(buf)
    table = read_table(buf.getvalue(), "xlsx")
    assert table.header == ["Date of Loss", "Paid"]
    assert table.rows == [["2026-05-01", "100"]]


def test_unsupported_format_raises():
    import pytest
    with pytest.raises(ValueError):
        read_table(b"x", "pdf")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_readers.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.extraction.readers'`

- [ ] **Step 4: Write minimal implementation**

```python
# backend/app/extraction/readers.py
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_readers.py -q`
Expected: PASS (3 passed)

- [ ] **Step 6: Commit**

```bash
git add backend/app/extraction/readers.py backend/requirements.txt backend/tests/test_loss_run_readers.py
git commit -m "feat(extraction): csv + xlsx loss-run readers"
```

---

### Task 5: Persistence models

`LossRunImport` (header) + `LossRunImportRow`. New tables → created by `SQLModel.metadata.create_all` (no `_COLUMN_MIGRATIONS` entry needed; that allowlist is only for new columns on existing tables).

**Files:**
- Modify: `backend/app/models.py` (append the two classes)
- Test: `backend/tests/test_loss_run_import_models.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_loss_run_import_models.py
from decimal import Decimal

from app.database import get_session
from app.models import LossRunImport, LossRunImportRow


def test_import_and_row_roundtrip_money_and_json():
    session = next(get_session())
    try:
        imp = LossRunImport(
            id="lri-test1", filename="lr.csv", storage_key="loss_runs/lri-test1_lr.csv",
            source_format="csv", uploaded_by="user-x", row_count=1,
            provenance={"provider": "deterministic", "model": "loss-run-parser-v1"},
        )
        session.add(imp)
        session.flush()  # parent before child (column FK)
        session.add(LossRunImportRow(
            id="lrr-test1", import_id="lri-test1", row_index=0,
            coverage_line="assault_battery", paid=Decimal("1200.50"),
            field_confidence={"paid": 0.9}, raw_values={"paid": "$1,200.50"},
        ))
        session.commit()

        got = session.get(LossRunImportRow, "lrr-test1")
        assert got.paid == Decimal("1200.50")
        assert got.field_confidence == {"paid": 0.9}
        assert session.get(LossRunImport, "lri-test1").status == "extracted"
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_import_models.py -q`
Expected: FAIL with `ImportError: cannot import name 'LossRunImport'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/app/models.py` (the file already imports `Column`, `JSON`, `Numeric`, `now_utc`, `DateTimeUTC`, `Decimal`, `datetime`, `date`, `SQLModel`, `Field`):

```python
class LossRunImport(SQLModel, table=True):
    """A parsed external loss-run document (review-only artifact; no Claim rows)."""
    id: str = Field(primary_key=True)
    filename: str
    storage_key: str
    source_format: str                      # "csv" | "xlsx"
    venue_id: str | None = None
    submission_id: str | None = None
    uploaded_by: str
    row_count: int = 0
    status: str = "extracted"
    provenance: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=now_utc, sa_type=DateTimeUTC)


class LossRunImportRow(SQLModel, table=True):
    """One canonical row extracted from a LossRunImport."""
    id: str = Field(primary_key=True)
    import_id: str = Field(foreign_key="lossrunimport.id", index=True)
    row_index: int
    date_of_loss: date | None = None
    coverage_line: str | None = None
    claim_status: str | None = None
    claimant: str | None = None
    description: str | None = None
    carrier_claim_number: str | None = None
    reserve: Decimal | None = Field(default=None, sa_column=Column(Numeric(12, 2), nullable=True))
    paid: Decimal | None = Field(default=None, sa_column=Column(Numeric(12, 2), nullable=True))
    incurred: Decimal | None = Field(default=None, sa_column=Column(Numeric(12, 2), nullable=True))
    field_confidence: dict = Field(default_factory=dict, sa_column=Column(JSON))
    raw_values: dict = Field(default_factory=dict, sa_column=Column(JSON))
```

> If `date` is not already imported in `models.py`, add `from datetime import date, datetime` (it uses `datetime` already; confirm `date` is included).

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_import_models.py -q`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/tests/test_loss_run_import_models.py
git commit -m "feat(models): LossRunImport + LossRunImportRow"
```

---

### Task 6: Import service

`create_loss_run_import(...)` orchestrates store → read → parse → persist + provenance + audit. `link_to_submission(...)`. Typed `LossRunImportError`. Service never commits.

**Files:**
- Create: `backend/app/services/loss_run_import.py`
- Test: `backend/tests/test_loss_run_import_service.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_loss_run_import_service.py
from decimal import Decimal

import pytest

from app.database import get_session
from app.models import AuditEvent, LossRunImportRow
from app.services.loss_run_import import LossRunImportError, create_loss_run_import, link_to_submission

_CSV = b"Date of Loss,Coverage,Net Paid,Outstanding\n2026-05-01,A&B,$1,200.50,500\n"


def test_create_persists_rows_provenance_and_audit():
    session = next(get_session())
    try:
        imp = create_loss_run_import(
            session, file_bytes=_CSV, filename="../lr.csv", source_format="csv", uploaded_by="user-x",
        )
        session.flush()
        assert imp.filename == "lr.csv"                       # sanitized
        assert imp.row_count == 1
        assert imp.provenance["provider"] == "deterministic"
        assert imp.provenance["model"] == "loss-run-parser-v1"

        rows = session.query(LossRunImportRow).filter_by(import_id=imp.id).all()
        assert rows[0].paid == Decimal("1200.50")
        assert rows[0].coverage_line == "assault_battery"

        events = session.query(AuditEvent).filter_by(entity_id=imp.id).all()
        assert any(e.event_type == "loss_run_import.extracted" for e in events)
    finally:
        session.rollback()
        session.close()


def test_unsupported_format_raises():
    session = next(get_session())
    try:
        with pytest.raises(LossRunImportError):
            create_loss_run_import(session, file_bytes=b"x", filename="x.pdf",
                                   source_format="pdf", uploaded_by="u")
    finally:
        session.rollback()
        session.close()


def test_empty_loss_run_raises():
    session = next(get_session())
    try:
        with pytest.raises(LossRunImportError):
            create_loss_run_import(session, file_bytes=b"Date of Loss,Paid\n",
                                   source_format="csv", filename="empty.csv", uploaded_by="u")
    finally:
        session.rollback()
        session.close()


def test_link_to_submission_sets_id_and_audits():
    session = next(get_session())
    try:
        imp = create_loss_run_import(session, file_bytes=_CSV, filename="lr.csv",
                                     source_format="csv", uploaded_by="u")
        session.flush()
        link_to_submission(session, imp.id, "sub-123")
        session.flush()
        assert session.get(type(imp), imp.id).submission_id == "sub-123"
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_import_service.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.loss_run_import'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/loss_run_import.py
"""Loss-run import service: store -> parse -> persist (review-only artifact).

Never creates Claim/money rows. Never commits (the router owns the transaction).
"""
from __future__ import annotations

import hashlib
from uuid import uuid4

from sqlmodel import Session

from app.ai_provenance import make_provenance
from app.extraction.loss_run_parser import parse_loss_run
from app.extraction.readers import read_table
from app.files import sanitize_filename
from app.models import LossRunImport, LossRunImportRow
from app.packet_core import _add_audit_event
from app.storage import get_storage

_SUPPORTED = ("csv", "xlsx")
_PARSER_VERSION = "loss-run-parser-v1"


class LossRunImportError(Exception):
    """Bad format / unreadable file / empty document. Router maps to 400."""


def create_loss_run_import(
    session: Session,
    *,
    file_bytes: bytes,
    filename: str,
    source_format: str,
    uploaded_by: str,
    venue_id: str | None = None,
    submission_id: str | None = None,
) -> LossRunImport:
    if source_format not in _SUPPORTED:
        raise LossRunImportError(f"unsupported format {source_format!r} (supported: {_SUPPORTED})")

    safe = sanitize_filename(filename)
    import_id = f"lri-{uuid4().hex[:12]}"
    storage_ref = get_storage().save(f"loss_runs/{import_id}_{safe}", file_bytes)

    try:
        table = read_table(file_bytes, source_format)
    except Exception as exc:  # reader failure -> typed error, not a 500
        raise LossRunImportError(f"could not read {source_format} file: {exc}") from exc

    rows = parse_loss_run(table)
    if not rows:
        raise LossRunImportError("no data rows found in the loss run")

    provenance = make_provenance(
        provider="deterministic",
        model=_PARSER_VERSION,
        prompt_version=_PARSER_VERSION,
        inputs={"sha256": hashlib.sha256(file_bytes).hexdigest(), "format": source_format},
    ).model_dump()

    imp = LossRunImport(
        id=import_id, filename=safe, storage_key=storage_ref, source_format=source_format,
        venue_id=venue_id, submission_id=submission_id, uploaded_by=uploaded_by,
        row_count=len(rows), provenance=provenance,
    )
    session.add(imp)
    session.flush()  # parent visible before child FK insert (project_postgres_fk_ordering)

    for i, r in enumerate(rows):
        session.add(LossRunImportRow(
            id=f"lrr-{uuid4().hex[:12]}", import_id=import_id, row_index=i,
            date_of_loss=r.date_of_loss, coverage_line=r.coverage_line, claim_status=r.claim_status,
            claimant=r.claimant, description=r.description, carrier_claim_number=r.carrier_claim_number,
            reserve=r.reserve, paid=r.paid, incurred=r.incurred,
            field_confidence=r.field_confidence, raw_values=r.raw_values,
        ))

    _add_audit_event(
        session=session, actor_id=uploaded_by, actor_type="user",
        entity_type="loss_run_import", entity_id=import_id,
        event_type="loss_run_import.extracted",
        event_metadata={"row_count": len(rows), "format": source_format, "provenance": provenance},
    )
    return imp


def link_to_submission(session: Session, import_id: str, submission_id: str) -> LossRunImport:
    imp = session.get(LossRunImport, import_id)
    if imp is None:
        raise LossRunImportError(f"loss-run import {import_id!r} not found")
    imp.submission_id = submission_id
    session.add(imp)
    _add_audit_event(
        session=session, actor_id="system", actor_type="user",
        entity_type="loss_run_import", entity_id=import_id,
        event_type="loss_run_import.linked", event_metadata={"submission_id": submission_id},
    )
    return imp
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_import_service.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/loss_run_import.py backend/tests/test_loss_run_import_service.py
git commit -m "feat(services): loss-run import (store/parse/persist + provenance/audit)"
```

---

### Task 7: Auth gate + API router + mount

Add `require_broker_or_carrier` to `app/auth.py`; build the router (upload/list/detail/link) with JSON-read coercion + money-as-string serialization; mount in `main.py`.

**Files:**
- Modify: `backend/app/auth.py` (add `require_broker_or_carrier`)
- Create: `backend/app/api/v1/loss_run_imports.py`
- Modify: `backend/app/main.py` (mount router)
- Test: `backend/tests/test_loss_run_imports_api.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_loss_run_imports_api.py
import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app

_CSV = b"Date of Loss,Coverage,Net Paid,Outstanding\n2026-05-01,A&B,$1,200.50,500\n"


def _headers(role, venue=None):
    return {"Authorization": f"Bearer {create_token('u-'+role, role+'@x.com', role, venue)}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_broker_can_upload_and_read_back(client):
    up = client.post(
        "/api/loss-run-imports",
        files={"file": ("lr.csv", _CSV, "text/csv")},
        data={"source_format": "csv"},
        headers=_headers("broker"),
    )
    assert up.status_code == 201, up.text
    body = up.json()
    assert body["row_count"] == 1
    import_id = body["id"]

    detail = client.get(f"/api/loss-run-imports/{import_id}", headers=_headers("carrier"))
    assert detail.status_code == 200
    row = detail.json()["rows"][0]
    assert row["paid"] == "1200.50"                      # money serialized as string
    assert row["coverage_line"] == "assault_battery"
    assert row["field_confidence"]["paid"] == 0.9        # JSON coerced at read boundary


def test_operator_is_forbidden(client):
    r = client.post(
        "/api/loss-run-imports",
        files={"file": ("lr.csv", _CSV, "text/csv")},
        data={"source_format": "csv"},
        headers=_headers("venue_operator", "elsewhere-brooklyn"),
    )
    assert r.status_code == 403


def test_bad_format_returns_400(client):
    r = client.post(
        "/api/loss-run-imports",
        files={"file": ("x.pdf", b"x", "application/pdf")},
        data={"source_format": "pdf"},
        headers=_headers("broker"),
    )
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_imports_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api.v1.loss_run_imports'`

- [ ] **Step 3a: Add the auth gate**

Append to `backend/app/auth.py` (after `require_carrier`):

```python
def require_broker_or_carrier(authorization: str = Header(None)):
    """Raises 401 without a valid token, or 403 unless broker/carrier/admin.

    The loss-run import artifact is read by both the placing broker and the
    underwriting carrier, so the gate admits either persona (+ admin)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    decoded = verify_token(authorization.split(" ")[1])
    if not decoded:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if decoded.get("role") not in ("broker", "carrier", "admin"):
        raise HTTPException(status_code=403, detail="Broker or carrier access required")
    return decoded
```

- [ ] **Step 3b: Write the router**

```python
# backend/app/api/v1/loss_run_imports.py
"""Loss-run import endpoints (broker + carrier). Mounted at /api by main.py.

  POST /api/loss-run-imports                    (multipart upload)
  GET  /api/loss-run-imports                    (list)
  GET  /api/loss-run-imports/{id}               (detail + rows)
  POST /api/loss-run-imports/{id}/link-submission

LossRunImportError -> 400, mirroring the other v1 routers.
"""
from __future__ import annotations

import json
from typing import NoReturn, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth import require_broker_or_carrier
from app.database import get_session
from app.models import LossRunImport, LossRunImportRow
from app.money import usd_to_json
from app.services.loss_run_import import LossRunImportError, create_loss_run_import, link_to_submission

router = APIRouter()


class LinkSubmissionBody(BaseModel):
    submission_id: str = Field(..., min_length=1)


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, LossRunImportError):
        raise HTTPException(status_code=400, detail=str(e))
    raise e


def _as_dict(value) -> dict:
    """Coerce a Column(JSON) read: Postgres returns a string, SQLite a dict."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value or {}


def _import_to_dict(imp: LossRunImport) -> dict:
    return {
        "id": imp.id, "filename": imp.filename, "source_format": imp.source_format,
        "venue_id": imp.venue_id, "submission_id": imp.submission_id,
        "uploaded_by": imp.uploaded_by, "row_count": imp.row_count, "status": imp.status,
        "provenance": _as_dict(imp.provenance), "created_at": imp.created_at.isoformat(),
    }


def _row_to_dict(r: LossRunImportRow) -> dict:
    return {
        "id": r.id, "row_index": r.row_index,
        "date_of_loss": r.date_of_loss.isoformat() if r.date_of_loss else None,
        "coverage_line": r.coverage_line, "claim_status": r.claim_status,
        "claimant": r.claimant, "description": r.description,
        "carrier_claim_number": r.carrier_claim_number,
        "reserve": usd_to_json(r.reserve) if r.reserve is not None else None,
        "paid": usd_to_json(r.paid) if r.paid is not None else None,
        "incurred": usd_to_json(r.incurred) if r.incurred is not None else None,
        "field_confidence": _as_dict(r.field_confidence), "raw_values": _as_dict(r.raw_values),
    }


@router.post("/loss-run-imports", status_code=201)
async def api_create_loss_run_import(
    file: UploadFile = File(...),
    source_format: str = Form(...),
    venue_id: Optional[str] = Form(None),
    submission_id: Optional[str] = Form(None),
    user: dict = Depends(require_broker_or_carrier),
    session: Session = Depends(get_session),
) -> dict:
    data = await file.read()
    try:
        imp = create_loss_run_import(
            session, file_bytes=data, filename=file.filename or "upload",
            source_format=source_format, uploaded_by=user.get("sub", "unknown"),
            venue_id=venue_id, submission_id=submission_id,
        )
        session.commit()
        session.refresh(imp)
        return _import_to_dict(imp)
    except LossRunImportError as e:
        session.rollback()
        _map_service_error(e)


@router.get("/loss-run-imports", dependencies=[Depends(require_broker_or_carrier)])
def api_list_loss_run_imports(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.exec(select(LossRunImport).order_by(LossRunImport.created_at.desc())).all()
    return [_import_to_dict(i) for i in rows]


@router.get("/loss-run-imports/{import_id}", dependencies=[Depends(require_broker_or_carrier)])
def api_get_loss_run_import(import_id: str, session: Session = Depends(get_session)) -> dict:
    imp = session.get(LossRunImport, import_id)
    if imp is None:
        raise HTTPException(status_code=404, detail=f"loss-run import {import_id} not found")
    rows = session.exec(
        select(LossRunImportRow).where(LossRunImportRow.import_id == import_id)
        .order_by(LossRunImportRow.row_index)
    ).all()
    return {**_import_to_dict(imp), "rows": [_row_to_dict(r) for r in rows]}


@router.post("/loss-run-imports/{import_id}/link-submission",
             dependencies=[Depends(require_broker_or_carrier)])
def api_link_submission(
    import_id: str, body: LinkSubmissionBody, session: Session = Depends(get_session),
) -> dict:
    try:
        imp = link_to_submission(session, import_id, body.submission_id)
        session.commit()
        session.refresh(imp)
        return _import_to_dict(imp)
    except LossRunImportError as e:
        session.rollback()
        _map_service_error(e)
```

> The token's user id key is `sub` (as minted by `create_token`); if `_broker_user_id` or another helper is the house pattern in sibling routers, match it. `user.get("sub", ...)` is the safe default.

- [ ] **Step 3c: Mount the router**

In `backend/app/main.py`, after the existing `loss_run_router` mount (~line 448), add:

```python
from app.api.v1.loss_run_imports import router as loss_run_imports_router  # noqa: E402
app.include_router(loss_run_imports_router, prefix="/api", tags=["loss-run-imports"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_imports_api.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth.py backend/app/api/v1/loss_run_imports.py backend/app/main.py backend/tests/test_loss_run_imports_api.py
git commit -m "feat(api): loss-run import upload/list/detail/link (broker+carrier)"
```

---

### Task 8: Eval scorers + fixtures

Deterministic, key-free scorers over labeled fixtures — sibling of `app/evals/fraud_scorer.py`. Pure (no DB) → runs in the `unit` tier.

**Files:**
- Create: `backend/app/evals/loss_run_scorers.py`
- Test: `backend/tests/test_loss_run_eval.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_loss_run_eval.py
from app.evals.loss_run_scorers import score_confidence_calibration, score_field_mapping


def test_field_mapping_accuracy_is_perfect_on_known_synonyms():
    result = score_field_mapping()
    assert result["accuracy"] == 1.0, result["misses"]


def test_confidence_separates_clean_from_garbled():
    result = score_confidence_calibration()
    assert result["passed"] is True, result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_loss_run_eval.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.evals.loss_run_scorers'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/evals/loss_run_scorers.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_loss_run_eval.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/loss_run_scorers.py backend/tests/test_loss_run_eval.py
git commit -m "feat(evals): loss-run field-mapping + confidence-calibration scorers"
```

---

### Task 9: Full-suite regression + wrap-up

- [ ] **Step 1: Run the full backend suite**

Run: `python -m pytest -q`
Expected: all green (prior count + the new tests; no regressions). If the new tables perturb a count-based assertion elsewhere, investigate — new tables should be additive.

- [ ] **Step 2: Run only the new slice for a fast confirmation**

Run: `python -m pytest tests/test_files.py tests/test_loss_run_synonyms.py tests/test_loss_run_parser.py tests/test_loss_run_readers.py tests/test_loss_run_import_models.py tests/test_loss_run_import_service.py tests/test_loss_run_imports_api.py tests/test_loss_run_eval.py -q`
Expected: all PASS.

- [ ] **Step 3: Update the backlog**

In `docs/backlog.md`, mark the Theme A loss-run extraction line / Track 14 "Document intelligence" as **v1 shipped (CSV+xlsx, review-only artifact)**, with follow-ups: PDF via the LLM seam, feed the underwriting memo/risk view, promote scorers into `--compare-baseline`, web/mobile review UI.

- [ ] **Step 4: Commit**

```bash
git add docs/backlog.md
git commit -m "docs(backlog): loss-run extraction v1 shipped; name follow-ups"
```

---

## Self-Review

**Spec coverage:**
- CSV+xlsx readers → Task 4 ✓ · column-mapping/synonyms → Task 2 ✓ · per-field confidence → Task 3 ✓ · persisted review-only artifact (no money rows) → Tasks 5–6 ✓ · AIProvenance stamp → Task 6 ✓ · audit event → Task 6 ✓ · broker+carrier gate → Task 7 ✓ · LossRunImportError→400 → Task 7 ✓ · link-to-submission → Tasks 6–7 ✓ · deterministic key-free eval scorers → Task 8 ✓ · injectable LLM/PDF seam → Task 3 (`extractor` param) ✓ · storage abstraction → Task 6 ✓ · JSON read-boundary coercion → Task 7 (`_as_dict`) ✓ · FK flush ordering → Task 6 ✓. **No gaps.**

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `RawTable(header, rows)`, `ExtractedLossRunRow` field names, `parse_loss_run(table, *, extractor)`, `read_table(data, fmt)`, `resolve_header→(field,conf)`, `create_loss_run_import(...)` kwargs, and the model field names (`field_confidence`, `raw_values`, `import_id`, money `reserve/paid/incurred`) are used identically across Tasks 2→8. `require_broker_or_carrier` added in Task 7 before use. Consistent.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-11-loss-run-extraction.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session via executing-plans, batch with checkpoints.
