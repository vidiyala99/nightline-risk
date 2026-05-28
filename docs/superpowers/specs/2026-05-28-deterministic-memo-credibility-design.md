# Deterministic memo credibility — design

**Date:** 2026-05-28
**Status:** Approved (brainstorming) → pending implementation plan
**Track:** Backlog track 3 — deterministic (no-key) agent quality
**Author:** Aakash + Claude

---

## Problem

The no-key demo path runs `DeterministicProvider.draft_memo`
(`app/providers/deterministic.py:250`). Its `summary` is keyed **only** on
`risk_type` + `severity`, so every altercation (regardless of venue, facts, or
evidence) produces a **byte-identical memo**. A recruiter opening two incidents
sees copy-paste output — the clearest possible "this is a stub" tell.

The data needed to make it specific is already passed in and discarded:
`incident_summary`, `incident_location`, `confidence`, and the real
`citation.excerpt` text (only *counted*, never quoted).

The only existing memo eval is `score_structural` (fields non-empty), so a
generic template "passes." Nothing pins quality.

## Goal

Make the deterministic memo read like a real underwriter wrote it *about this
incident*, while staying 100% deterministic (no randomness, no live LLM —
evals and the no-key constraint depend on reproducibility). Pin the result with
an eval scorer so a future edit can't silently regress it to generic.

Non-goals: rewriting `open_questions` (already risk-type-specific and good);
fact extraction / free-text parsing (brittle, overlaps the classifier);
changing the `MemoOutput` schema or the memo UI.

## Approach — structural weaving

Rewrite **only** the `summary` construction. Compose the rich inputs we already
have into a single flowing paragraph (renders as-is in the existing `<p>` at
`frontend/src/app/underwriter/[id]/page.tsx:409`). Four deterministic parts:

1. **Lead (incident-unique).** Names the venue + restates what happened:
   `"{venue_name or location}: {first sentence of incident_summary, trimmed}"`.
   The single biggest credibility lever — unique per incident.
2. **Risk analysis.** The existing `risk_type` paragraph, kept verbatim.
3. **Citation grounding.** Replace *"Supported by N sources"* with a quoted
   excerpt: `'Corroborated by N source(s), incl. "{citations[0].excerpt,
   trimmed}".'`. Falls back to the existing no-sources note when empty.
4. **Recommendation.** The existing `severity_action`, **modulated by a
   confidence band** (deterministic thresholds: `<0.5` low / `0.5–0.7`
   moderate / `≥0.7` high). Low confidence softens to "classifier confidence is
   moderate (0.NN) — recommend manual review before acting."

Two distinct incidents now diverge on location/venue, summary fragment,
citation text, and confidence phrasing. The identical-memo tell is dead.

### Determinism rules (no randomness)

- **Summary lead fragment:** `incident_summary.strip()`, take up to the first
  sentence boundary (`. ! ?`) or first ~140 chars, whichever is shorter; if the
  summary is already short, use it whole.
- **Citation excerpt:** always `citations[0]` (stable order), trimmed to
  ~120 chars on a word boundary.
- **Confidence bands:** fixed thresholds above; rounded to 2 decimals in prose.
- Same inputs → byte-identical output. Guarded by a unit test.

### Interface change (minimal, backward-compatible)

Add an **optional** `venue_name: str | None = None` to `draft_memo` across the
provider interface (`app/providers/base.py`) and all implementations
(`deterministic.py`, `anthropic_provider.py`, `gemini_provider.py`). LLM
providers may ignore it. Wire it at the call site
(`app/agents/runtime.py:596,610`) from the `venue` already in scope. The
deterministic lead uses `venue_name` when present, else `incident_location`.
Eval scenarios use the fixed `EVAL_VENUE`, so they exercise the `location` path.

## Eval coverage — pin the quality

### New scorer: `score_memo_specificity` (`app/evals/scorers.py`)

Asserts **grounding invariants** (objective, not aesthetic):

- (a) the memo `summary` contains the incident **location** string; and
- (b) the memo `summary` contains a fragment (normalized ~40-char prefix) of at
  least one `actual.citations[].excerpt`.

**Conditional, to avoid false-fails:** (a) only asserts when a location exists;
(b) only asserts when `actual.citations` is non-empty. A scenario with neither
trivially passes (nothing to ground against).

This is a **hard CI gate** — by design. The checks are invariants of the
feature: if they fail, the memo is literally back to generic, which is exactly
what CI should catch forever. We deliberately do **not** gate on subjective
quality (tone, readability) — that is where brittleness lives.

### Enabler: store the incident on `_RunOutput`

`_RunOutput` (`app/evals/runner.py:242`) gains an `incident` field so input-aware
scorers can read `incident.location` without re-deriving it. `run_scenario`
already builds the incident (line 340) — just retain it. Wire the new scorer
into `_score_standard_scenario` (line 379) alongside the existing suite.

### Unit tests (`backend/tests/test_*` near the existing provider tests)

- **Distinctness guard:** two incidents differing in location + summary +
  citations produce different `summary` strings.
- **Determinism guard:** identical inputs produce byte-identical `summary`.
- **Grounding:** summary contains the location and a citation fragment when
  both are supplied; degrades cleanly (no crash, sensible prose) when summary,
  location, or citations are empty.

## Rollout

1. Implement composition + optional `venue_name` (providers + call site).
2. Add `score_memo_specificity` + `_RunOutput.incident` + wire into runner.
3. Unit tests (provider behavior + scorer).
4. Regenerate the baseline (`app/evals/baseline.py`) and the public scoreboard
   (`frontend/public/eval-baseline.json`, surfaced by
   `frontend/src/app/evals/page.tsx`).
5. Confirm the `evals` + `evals-matrix` CI jobs (`--compare-baseline`) stay
   green and full `cd backend && python -m pytest -q` passes — no regression in
   `structural`, citation, or factor scorers.

## Risks / mitigations

- **New hard gate false-fails** → conditional assertions (only check what
  exists); invariant-only (no aesthetic checks).
- **Citation-fragment match too strict** → normalized prefix substring, not
  exact equality.
- **Interface churn from `venue_name`** → optional param, default `None`, other
  providers ignore it; no caller is forced to change.
- **Baseline drift** → expected; regenerate baseline + scoreboard as step 4 and
  eyeball the diff.
