# Loss-Run Extraction (v1) — Design

**Date:** 2026-06-10
**Status:** Approved design, pre-implementation
**Layer:** Broker platform (front-of-funnel intake) — Track 12 Theme A keystone / Track 14
"Document intelligence." First shipped slice of document extraction.

## Goal

Turn an uploaded **loss-run document** (the carrier-format claims-history file a venue/broker
brings into a new account) into **canonical, structured rows with per-field confidence**, persisted
as a **reviewable artifact** that the underwriting memo / risk view can read as prior-loss context.

This is the inverse of `app/services/loss_run.py` (which *produces* a loss run from claims Nightline
already owns). External loss runs cover accounts whose claims are **not** in Nightline — so the
consumer is underwriting a *new submission*, never our carrier-side claim model.

The hard part of a loss run is not reading cells — it is **column mapping**: carriers label the same
field differently (`Date of Loss` / `Loss Date` / `DOL`; `Paid` / `Indemnity Paid` / `Net Paid`;
`Reserve` / `Outstanding`). v1 solves exactly that, deterministically and key-free.

## Non-goals

- **No auto-creation of Claim / money / lifecycle rows.** The artifact is review-only. (House rule:
  suggestion → human-confirm → audit, never autonomous on money.)
- **No PDF in v1.** PDF (esp. scanned) needs OCR + the LLM extraction path; it is the quality tier the
  provider seam is *for*, deferred deliberately so the v1 core stays deterministic + subscription-free.
- **No reserving / loss-ratio math here.** v1 produces structured rows; the existing loss-ratio /
  underwriting consumers read them. (Feeding them is a follow-up, not this slice.)
- **No new extraction for SOV / ACORD / inbound email.** Separate slices, separate specs.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| First document type | **Loss-run** (bounded; canonical schema already exists; feeds real underwriting) |
| Write boundary | **Persisted artifact, no auto-create** of Claim/money rows |
| Formats in v1 | **CSV + xlsx** (both deterministic); **PDF deferred** to the LLM seam |
| Readers | Broker **and** carrier/underwriter |
| Execution | **Deterministic** synonym-map parser; optional LLM `extractor` injected behind the same `bytes → (rows, confidence)` signature (mirrors `classifier.py`) |
| Eval | Deterministic, **key-free** scorers (field-mapping accuracy + confidence calibration), sibling of `fraud_scorer.py` / `vision_scorers.py` |

## Architecture & components

Each unit has one purpose and a well-defined interface; the format-readers and the column-mapper are
isolated so the mapper (the real brain) is testable without any file I/O.

- **`app/extraction/schema.py`** — typed `ExtractedLossRunRow` dataclass: canonical fields +
  `field_confidence: dict[str, float]` + `raw_values: dict[str, str]` (original cell text retained for
  audit). Plus `RawTable` (`header: list[str]`, `rows: list[list[str]]`) — the format-agnostic handoff.
- **`app/extraction/readers.py`** — `read_table(data: bytes, fmt: Literal["csv","xlsx"]) -> RawTable`.
  CSV via stdlib `csv`; xlsx via `openpyxl` (first sheet; detect the header row by scanning for the
  first row whose cells match ≥2 known synonyms, skipping leading logo/metadata rows). **Only** unit
  that touches file bytes/dependencies.
- **`app/extraction/synonyms.py`** — the canonical-field ↔ header-synonym map + canonical coverage-line
  normalization. The deterministic brain; what the eval guards and the LLM later augments (not replaces).
- **`app/extraction/loss_run_parser.py`** — pure: `parse_loss_run(table: RawTable, *, extractor=None)
  -> list[ExtractedLossRunRow]`. Maps headers via `synonyms`, coerces cells (dates, money via
  `app.money`), assigns per-field confidence. `extractor` (optional, default `None` → deterministic)
  is the LLM/PDF injection point — same return type, so routing/eval never change.
- **`app/models.py`** — `LossRunImport` + `LossRunImportRow` (below).
- **`app/services/loss_run_import.py`** — orchestrator + typed `LossRunImportError`. Stores bytes,
  parses, persists artifact+rows (flush parent before children), stamps provenance, emits audit event.
- **`app/api/v1/loss_run_imports.py`** — upload + list + detail + link-to-submission; `require` gate
  for broker **or** carrier; `LossRunImportError → 400`.
- **`app/evals/loss_run_scorers.py`** + fixtures — deterministic key-free scorers over labeled docs.

## Data model

Money is `Decimal` / `Numeric(12, 2)`, JSON money as strings; timestamps `DateTimeUTC`; JSON columns
coerced at the read boundary (Neon returns strings). FK is column-level → `session.flush()` the parent
before adding rows.

**`LossRunImport`** (header)
- `id: str` PK, `"lri-<uuid>"` prefix
- `filename: str` — **`_sanitize_filename`'d** (reuse the evidence-upload helper)
- `storage_key: str` — bytes live behind `app/storage.py::get_storage()`
- `source_format: str` — `"csv" | "xlsx"`
- `venue_id: str | None`, `submission_id: str | None` (link is optional + late-bindable)
- `uploaded_by: str` (actor id from token)
- `created_at: datetime` (`default_factory=now_utc, sa_type=DateTimeUTC`)
- `row_count: int`
- `status: str` = `"extracted"` (only state in v1; linking sets `submission_id`, not a new state)
- **provenance** (`AIProvenance` shared primitive): `model` = `"deterministic-loss-run-parser"`,
  `prompt_version` = parser version, `input_hash` = `sha256(file_bytes)` — proves lineage, and flips
  to the LLM model id the day the PDF/LLM path runs.

**`LossRunImportRow`**
- `id: str` PK, `import_id: str` FK → `LossRunImport.id` (column-level), `row_index: int`
- `date_of_loss: date | None`, `coverage_line: str | None` (canonical), `claim_status: str | None`,
  `claimant: str | None`, `description: str | None`, `carrier_claim_number: str | None`
- `reserve / paid / incurred: Numeric(12, 2) | None`
- `field_confidence: JSON` (`{field: 0.0–1.0}`) — **coerce on read**
- `raw_values: JSON` (`{canonical_field: original_cell_text}`) — **coerce on read**

## Extraction pipeline (data flow)

```
upload (csv|xlsx bytes)
  → service: _sanitize_filename + get_storage().save(bytes)          # storage abstraction
  → readers.read_table(bytes, fmt)            → RawTable             # only file-I/O unit
  → loss_run_parser.parse_loss_run(table)     → [ExtractedLossRunRow] # synonym map + coercion + confidence
  → persist LossRunImport (flush) + LossRunImportRow[]               # provenance stamp
  → _add_audit_event(event_type="loss_run_import.extracted")
  → (optional, later) link_to_submission(import_id, submission_id)
```

No money entity is written at any step. Confidence is assigned in the parser: exact canonical header
→ 1.0; known synonym → ~0.9; positional/fuzzy guess → ~0.5; cell that fails coercion → low confidence
with the raw text retained. This separation (correct→high, wrong/unmapped→low) is what the calibration
scorer measures.

## API

- `POST /api/loss-run-imports` — multipart upload (`file`, optional `venue_id` / `submission_id`);
  broker-or-carrier gate; returns `201` + artifact (header + rows).
- `GET /api/loss-run-imports` — list (gated), `GET /api/loss-run-imports/{id}` — detail with rows.
- `POST /api/loss-run-imports/{id}/link-submission` — `{submission_id}` late-binds the link.
- Errors: `LossRunImportError` (unsupported format / unreadable / empty table) → `400` via the router's
  `_map_service_error`, mirroring the other v1 routers.

## Eval & testing

**Eval** (`app/evals/loss_run_scorers.py`, deterministic, key-free) over labeled fixtures:
- `field_mapping_accuracy` — of the expected canonical fields per fixture, fraction mapped correctly.
- `confidence_calibration` — separation between confidence on correctly-mapped vs mis/unmapped fields.
Fixtures span: a clean CSV, a synonym-heavy CSV (`DOL`/`Net Paid`/`Outstanding`), an adversarial
"weird header" CSV, and an xlsx with leading logo/metadata rows offsetting the header.

**Testing (TDD, RED→GREEN):**
- Unit — `synonyms`/`parser`: header→canonical mapping, cell coercion (dates, money), confidence
  assignment, over-fit guards (novel headers).
- Unit — `readers`: CSV + xlsx (offset header / merged-cell tolerance).
- Service — persists artifact+rows, stamps provenance, emits audit event, raises on bad format.
- API — upload → 201; **operator gets 403** (gate proof); detail returns rows; link works.
- Eval — scorers hit target on fixtures; promotion into `--compare-baseline` is the batched
  recommended-order item, not per-scorer here (mirrors fraud/vision).

## Conventions honored

`app.money` (Decimal / `Numeric(12,2)` / JSON-string); `DateTimeUTC` + `now_utc`; column-level FK
→ parent `flush()` before children ([[project_postgres_fk_ordering]]); JSON-string coercion at read
boundary for `field_confidence` / `raw_values` ([[project_neon_json_string_regressions]]); all bytes
through `app/storage.py`; `_sanitize_filename` reused from the evidence path; `_add_audit_event`;
`AIProvenance` shared primitive; typed service error → router 400; deterministic-default + injectable
callable seam ([[classifier.py]]); key-free eval scorer sibling of `fraud_scorer` / `vision_scorers`.

## Follow-ups (named, not silent)

- **PDF** via the LLM `extractor` injection (OCR + LLM path; quality tier behind a key).
- **Feed the consumer** — surface imported prior-loss rows in the underwriting memo / submission risk
  view (this slice persists; wiring the reader is next).
- **xlsx robustness** — multi-sheet selection, totals-row exclusion heuristics as fixtures demand.
- **Confidence-gated review UI** — low-confidence fields flagged for human correction (and the capture
  point for the Track 14 correction flywheel).
