# Broker Submission-Intake Copilot — Design Spec

**Date:** 2026-06-11
**Status:** Design — approved direction, pending spec review
**Working name:** Clearform (provisional; NOT "Nightline")

---

## 1. Context & goal

This is a **new, standalone product**, separate from Nightline. Nightline stays as the
deep, multi-persona engineering showcase (and continues to be built). This tool has exactly
one job:

> **Get one real independent commercial broker / small-agency owner to drop in a real,
> messy loss run and react to the result — so we earn a validation story and direct insight
> from a real industry user.**

That single user is the highest-leverage move available: it is genuine product validation,
and "I put this in front of a real commercial broker, here's what they said" is the most
credible artifact to put in front of the AI-insurance companies that would hire (Outmarket,
Novella, Adaptional, Axle, Sixfold-tier). The founder lens and the career lens point at the
same build.

**Why this wedge.** Messy submission/loss-run intake is the documented #1 broker time-sink
(~40% of time re-keying; 47 min/quote manual vs ~11 automated) and the unsolved AI-native
gap: pure OCR fails on format drift, LLM-only hallucinates, rules-based breaks on new
layouts. The winning pattern — and the differentiator here — is **hybrid extraction +
calibrated per-field confidence + route-low-confidence-to-human + audit trail**, with the
correctness layer made *visible*. That layer is Nightline's existing eval/calibration
harness, reused.

This is not "extension on top of Nightline." It reuses two self-contained engines and
builds a small, focused, auth-light product around them; net new product surface, not new
breadth on the old app.

## 2. Non-goals (v1)

- Not a multi-persona platform. One persona (broker), one workflow.
- No accounts / login wall / multi-tenant. Auth-light (see §4).
- No submission-email parsing, ACORD generation, carrier-appetite matching, quoting,
  policy/claims lifecycle — all out of v1 (Nightline territory or future).
- Not a business with users-at-scale. The goal is *one* broker conversation, not retention
  or revenue.
- No replacement of Nightline; the two coexist.

## 3. Architecture

**New repo, own deployment, own URL.**

- **Backend:** minimal FastAPI. Seeded by **copying in** two self-contained Nightline
  packages as the backbone:
  - `app/extraction/` — `readers.py` (CSV/xlsx + new PDF), `loss_run_parser.py`,
    `synonyms.py` (deterministic header-synonym mapper), `schema.py` (canonical loss-run
    row + per-field confidence), the injectable LLM `extractor` seam.
  - `app/evals/loss_run_scorers.py` — field-mapping + confidence-calibration scorers
    (key-free).
  - Plus the **storage abstraction** pattern (`LocalStorage` → R2/S3 swap) for uploaded
    bytes, and the money/`Decimal` + provenance conventions.
- **Frontend:** clean Next.js, single-flow (upload → review → export). No persona nav.
- **DB:** minimal. SQLite local / Postgres (Neon) prod. Three tables only (see §5).
- **Deploy:** Railway (backend) + Vercel (frontend), a new project distinct from Nightline.
- **Auth-light:** no login. The tool is usable anonymously end-to-end. A **soft email
  capture** appears only at the *save/export* step ("email yourself the cleaned file"),
  which doubles as lead capture. No password, no account.

Nightline is untouched: still deployed at its URL, still the depth showcase.

## 4. The core flow (the 2-minute wow)

1. **Drop.** Broker uploads a loss run: **PDF, Excel (.xlsx), or CSV.** Drag-drop, no signup.
2. **Extract.** File → canonical structured loss-run rows. Each field carries a
   **confidence score** (0–1) and **provenance** (source page/sheet + cell/coordinate, and
   which header-synonym or LLM path produced it).
3. **Review surface.** A clean table of extracted rows. Three affordances:
   - **Low-confidence fields** (below a tunable threshold) are highlighted and collected
     into a **"Review these" lane** — never silently accepted.
   - A **data-quality / missing-info checklist** ("2 open claims with no reserve;
     valuation date missing; 3 rows missing claim number").
   - Per-field **provenance on hover/click** ("from page 2, row 14, column 'Total
     Incurred'").
4. **Correct.** Broker edits any field inline. Each correction is captured (§6).
5. **Export.** Download the clean, normalized result (CSV) and/or a "carrier-ready summary"
   view. Soft email gate here.

## 5. Data model

Three tables. Money as `Decimal` (SQL `Numeric(12,2)`); JSON money as strings; timestamps
via the `DateTimeUTC` convention.

- **`Import`** — one uploaded file. `id`, `filename`, `content_hash`, `source_type`
  (pdf/xlsx/csv), `uploaded_at`, `status` (extracting/ready/failed), `row_count`,
  `low_confidence_count`, optional `captured_email`, `extractor_path` (deterministic/llm),
  `model`/`prompt_version` (AIProvenance when the LLM path runs).
- **`ExtractedRow`** — one canonical loss-run row. FK to `Import`. Holds the canonical
  fields (claim number, date of loss, claim status, paid, reserve/outstanding, incurred,
  claimant, cause/description, valuation date, policy period, carrier, line of business),
  each with a paired **confidence** and **provenance** blob.
- **`Correction`** — one human edit. FK to `ExtractedRow` + field name, `old_value`,
  `new_value`, `original_confidence`, `corrected_at`. This is the insight/flywheel record.

(`session.flush()` parents before children per the column-level-FK ordering rule.)

## 6. The correction flywheel = insight capture (the real goal)

The correction UI is the **customer-discovery mechanism**, not just a feature. Every edit
writes a `Correction` row. This yields, for the broker conversation:

- *exactly* which fields the extractor got wrong on their real document,
- the confidence the model had when it was wrong (calibration evidence),
- a concrete, data-backed opener: "here's where it missed on your loss run — what's missing
  before you'd actually use this?"

Same surface, two purposes: it grows a gold set from real data (the AI-native flywheel) AND
runs the interview. We instrument it so the insight is structured, not anecdotal.

## 7. The differentiator, made visible — the eval/correctness panel

A small public `/evals`-style panel that reuses `loss_run_scorers.py`:

- **Field-mapping accuracy** and **confidence calibration** measured against a committed
  gold set (fixture loss runs with known-correct answers).
- Framed honestly: "most vendors say 'trust our 98%'; here's the measured number, and
  low-confidence fields are routed to you, not shipped silently."

This is what makes the tool legible to an insurtech founder in 30 seconds — the
correctness layer, not the extraction, is the headline.

## 8. Trust / honesty invariants (non-negotiable)

- **No silent low-confidence.** Any field below threshold is surfaced for review, never
  auto-accepted into the "clean" output without a flag.
- **Provenance always.** Every extracted value traces to a source location + the path that
  produced it (synonym match vs LLM).
- **Deterministic floor stays key-free.** CSV/xlsx extraction + all eval scorers run with no
  API key (CI, tests, and the calibration number never depend on a live model). The LLM/OCR
  path is an *additive* tier for PDFs.
- **AIProvenance on the LLM path.** When the LLM extractor runs, stamp `model`,
  `prompt_version`, `input_hash` onto the `Import` and its audit record.

## 9. Extraction pipeline (reuse + one new reader)

- **CSV / xlsx:** reuse the shipped deterministic path (`readers` → `synonyms` →
  `loss_run_parser` → canonical rows + confidence). Already TDD'd in Nightline.
- **PDF (new):** add a `PdfReader` behind the existing injectable `extractor` seam —
  text-extraction first (digital PDFs), OCR + LLM structured-extraction for scanned/messy
  PDFs. Output conforms to the **same canonical schema + confidence + provenance** contract,
  so the review UI and scorers are reader-agnostic. This is the Option-A path that requires
  a small LLM key (Haiku-class, single-digit $/mo for demo traffic).
- The header-synonym mapper handles cross-carrier naming drift ("Total Incurred" vs "Loss
  Amount" vs "Incurred"); the LLM path is the fallback/normalizer, not the primary for
  tabular sources.

## 10. Error handling

- **Unreadable / wrong file type** → friendly rejection, no stack trace; allowed types
  surfaced up front.
- **Partial extraction** → never fail the whole import; surface what parsed + flag what
  didn't as review items (degrade, don't 500). Mirrors Nightline's failure-isolation rule.
- **OCR/LLM failure or timeout** → fall back to whatever deterministic text extraction
  produced, mark affected fields low-confidence, log the failure (don't silently drop).
- **JSON-on-Postgres** → coerce provenance/confidence JSON at the read boundary (the
  documented Neon string-vs-dict class).

## 11. Testing strategy (TDD)

- Reuse and extend the existing loss-run fixtures + scorers. New fixtures: a few realistic
  **PDF** loss runs (digital + scanned-style) with known-correct gold answers.
- **Deterministic, key-free** tests for: CSV/xlsx parsing, synonym mapping, confidence
  thresholding/routing, missing-info checks, correction capture, export correctness.
- **Eval scorers** (field-mapping + calibration) run in CI against the gold set as a gate
  (the visible accuracy number must not silently regress).
- The PDF/LLM path is tested with the `extractor` seam **mocked** (deterministic fixtures
  for the model's structured output), so the suite stays key-free; a separate, optional,
  key-gated lane exercises the real model.

## 12. v1 scope

**In:** loss-run intake (PDF + xlsx + CSV); canonical rows + per-field confidence +
provenance; review/correction UI with low-confidence routing; missing-info / data-quality
checklist; clean CSV export + carrier-ready summary view; the visible eval panel; soft email
capture; correction/insight instrumentation.

**Out:** submission-email parsing, ACORD generation, appetite/quoting, accounts/multi-user,
mobile app, anything Nightline already does.

**Decided:** Option A — the PDF/LLM path ships in v1 (a real broker's loss run is a PDF; the
deterministic floor is for evals/CI, not the live demo). Small LLM key budget required.

## 13. Success criteria

- **Working:** a broker can drag a real PDF loss run in and, within ~2 minutes, see clean
  structured rows, a confidence/review lane that catches the genuinely-ambiguous fields, a
  missing-info checklist, and export a normalized CSV — all without signing up.
- **Legible to a founder:** the eval panel shows a measured accuracy + calibration number,
  and the "route the doubt to a human" story is obvious on the surface.
- **Insight-ready:** corrections are captured structurally, so a broker session produces
  data, not just vibes.
- **Honest:** deterministic floor is key-free; no low-confidence field is silently shipped;
  every value has provenance.

## 14. Open questions / future

- Final product name + minimal brand.
- Whether the soft email capture is at export only, or also a "save link to come back."
- Submission-email intake and quote-comparison are the obvious v2 surfaces (both are
  Nightline backlog Theme A items) — explicitly deferred.
- Real R2/S3 for uploaded files before any live broker use (local storage is ephemeral on
  Railway).

## 15. Relationship to Nightline

- Nightline = depth showcase, ongoing. Its `backlog.md` stays as-is (it's part of that
  showcase); this project does **not** inherit the 1,200-line backlog — it gets this spec +
  a small focused plan.
- The two crown-jewel engines (`extraction`, `evals`) are copied, not shared-imported, so
  the new repo is self-contained and Nightline keeps evolving independently. If they
  diverge, that's fine — they serve different goals.
