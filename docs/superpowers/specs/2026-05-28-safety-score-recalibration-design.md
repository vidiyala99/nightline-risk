# Safety-score recalibration — design

**Date:** 2026-05-28
**Status:** Approved (brainstorming) → pending implementation plan
**Area:** `backend/app/underwriting/scoring.py` (incident-history factor)

---

## Problem

The SAFETY RECORD factor (`_score_incident_history`) is `100 − incidents×10`, hard-capped at **0 once a venue logs 10+ incidents**. Three consequences:

1. **Flatlines at 10.** A 12-incident venue and a 33-incident venue both show `0/100` (absolute worst), so the factor is effectively binary and reads as a bug next to a venue's `OPERATIONAL 100` / `BUSINESS 100`.
2. **Ignores severity.** The function uses raw count only — 8 noise complaints score the same as 8 injury+police incidents — despite its own docstring claiming it weighs severity and recency.
3. **"Close open cases" is a hollow promise.** The UI tells venues that resolving incidents improves the score, but scoring uses the *total* count, so closing a case changes nothing.

The `0/100` is the correct output of this curve — the curve itself is miscalibrated.

## Decision

Recalibrate to a **severity- and status-weighted incident load** with a smooth decay. Explicitly **no recency weighting** — recency needs a reference "now", which would make scores time-varying and force a frozen/injected clock into the eval harness and `test_phase_1`. Severity + open/resolved capture most of the realism while staying **fully deterministic and time-invariant**.

## Scoring model

**Per-incident weight = severity × status:**

- **Severity** (from `IncidentRecord` flags, always present): `base 1.0 + 0.5·injury_observed + 0.5·police_called + 0.5·ems_called` → range `[1.0, 2.5]`.
- **Status factor:** active (`open`, `under_review`) = `1.0`; resolved (`closed`, `closed_archived`) = `0.4`. Resolved incidents still count (history matters) but far less — so **closing a case measurably raises the score**.

**Weighted load** = Σ per-incident weights.

**Curve** (replaces `100 − count×10`):

```
score = round(100 * math.exp(-load / 9))   # clamped [0, 100]; load 0 → 100
```

Reference points (k=9): load 0→100, 3→72, 6→51, 12→26, 25→6. `k` is tunable and gets locked by the re-baselined tests. Net effect: 12 resolved-minor incidents (load ≈ 4.8 → ~58, MODERATE) no longer look identical to 33 mostly-open incidents (load ≈ 25 → ~6, HIGH RISK); severity now moves the score.

## Plumbing

- **Engine** (`RiskScoringEngine._score_incident_history`): read an **`incident_load`** float, falling back to `incident_count` when absent —
  `load = venue.get("incident_load", venue.get("incident_count", 0))` — then apply the exp curve (`import math`). Backward-compatible: any dict caller/fixture that sets only `incident_count` treats the count as the load.
- **`get_risk_score`**: replace the `COUNT(*)` query with one selecting `status, injury_observed, police_called, ems_called` for the venue's `IncidentRecord` rows; sum the per-incident weights; set `overrides["incident_load"]`. Keep the existing total-count override (`overrides["incident_count"]`) for display/other consumers.
- **Fallback (preserves the live-count-authority fix):**
  - **Session + book venue** → live weighted load from the rows; a successful query is authoritative, including empty → load 0 → score 100 (carries the `live_count is not None` semantics shipped in 62bf26b).
  - **No session / prospect** (unit tests, headless) → no rows → engine falls back to the dict `incident_count` as the load, so session-less callers get the recalibrated **curve** with no severity data required.
- **Determinism:** load is computed purely from stored flags + status — no clock, reproducible.

## Testing

- **Re-baseline `backend/tests/test_phase_1.py` (62 cells).** Session-less, so the new curve shifts scores → tiers → premiums; re-pin every `(venue × tier × billing)` cell intentionally (the agreed cost).
- **New unit tests** (`backend/tests/test_incident_scoring.py`):
  - severity multipliers — minor open (load 1.0) → 89; injury+police+EMS open (load 2.5) → 76;
  - status factor — one resolved minor (load 0.4) scores higher than one open minor (load 1.0);
  - **closing-raises-score** — same incident `open` vs `closed` yields a higher score when closed (the disconnect fix);
  - monotonicity — more / more-severe / more-open incidents never increase the score;
  - determinism — identical inputs → identical score;
  - over-fit guards — load 0 → 100, large load → near 0 but never negative.
- **Eval gate** `python -m app.evals.runner --compare-baseline` → exit 0 (risk scoring isn't the eval target; confirm no drift).
- **Full** `cd backend && python -m pytest -q` green; refresh the eval baseline + `frontend/public/eval-baseline.json` only if portfolio/scoreboard scores shift.

## Non-goals (explicitly out of scope)
- **Recency** weighting (the time-dependent piece) — clean fast-follow if wanted later.
- `incident_category` weighting and **venue-size/capacity normalization**.
- **Count-inflation cleanup** — the ~21 accumulated UUID incidents (app/test-created in prod) are a separate data-hygiene/test-isolation concern, not this change.
