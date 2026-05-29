# Safety-Score Recalibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incident-history factor's `100 − count×10` curve (flatlines at 10 incidents, ignores severity, makes "close open cases" hollow) with a severity- and status-weighted incident load on a smooth exponential decay.

**Architecture:** A pure helper computes a per-incident weight (`severity × status`); `get_risk_score` sums it from live `IncidentRecord` rows into an `incident_load`; the engine maps load → score via `round(100·exp(−load/9))`, falling back to `incident_count` when no load is provided (session-less callers). Fully deterministic — no recency/clock.

**Tech Stack:** Python 3.12, SQLModel/SQLite, pytest.

**Spec:** `docs/superpowers/specs/2026-05-28-safety-score-recalibration-design.md`

**Correction to spec:** the spec said "re-baseline test_phase_1 (62 cells)" per a stale CLAUDE.md note. `test_phase_1.py` is actually schema/chunker tests. The incident-driven assertions live in `test_portfolio.py`, `test_pricing_carrier_aware.py`, `test_pricing_loss_adjustment.py`, `test_risk_score_live_delta.py`, `test_prospects.py`. Task 3 re-baselines whatever the full suite flags.

---

## File Structure

- `backend/app/underwriting/scoring.py` — add `import math` + `_incident_weight()` helper; rewrite `_score_incident_history` to use `incident_load`; change `get_risk_score`'s incident query from `COUNT(*)` to row-select + load sum.
- `backend/tests/test_incident_scoring.py` — **new**: unit tests for the helper, the curve, and the session-based load path.
- Existing score/pricing tests — re-baselined in Task 3 (no structural change).

---

### Task 1: Weighted-load helper + recalibrated curve (pure, no DB)

**Files:**
- Modify: `backend/app/underwriting/scoring.py` (`_score_incident_history` ~lines 87–106; add `import math` at top; add `_incident_weight` as a module-level function near the top of the file)
- Test: `backend/tests/test_incident_scoring.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_incident_scoring.py`:

```python
from app.underwriting.scoring import _incident_weight, RiskScoringEngine


def _score(load):
    # Drive the engine's incident factor directly via a venue dict.
    eng = RiskScoringEngine({"v": {"incident_load": load}})
    return eng._score_incident_history({"incident_load": load})


def test_incident_weight_minor_open():
    assert _incident_weight(injury=False, police=False, ems=False, status="open") == 1.0

def test_incident_weight_full_severity_open():
    # 1.0 + 0.5*3 = 2.5, active status factor 1.0
    assert _incident_weight(injury=True, police=True, ems=True, status="open") == 2.5

def test_incident_weight_resolved_is_discounted():
    # minor, closed -> 1.0 * 0.4
    assert _incident_weight(injury=False, police=False, ems=False, status="closed") == 0.4

def test_under_review_counts_as_active():
    assert _incident_weight(injury=False, police=False, ems=False, status="under_review") == 1.0

def test_curve_reference_points():
    assert _score(0) == 100
    assert _score(1.0) == 89
    assert _score(2.5) == 76
    assert _score(25) == 6

def test_closing_an_incident_raises_score():
    open_load = _incident_weight(injury=False, police=False, ems=False, status="open")
    closed_load = _incident_weight(injury=False, police=False, ems=False, status="closed")
    assert _score(closed_load) > _score(open_load)   # 96 > 89

def test_curve_monotonic_non_increasing():
    scores = [_score(l) for l in [0, 1, 2, 5, 10, 20, 40]]
    assert scores == sorted(scores, reverse=True)

def test_curve_never_negative_or_over_100():
    assert _score(1000) >= 0
    assert _score(0) <= 100

def test_curve_deterministic():
    assert _score(7.3) == _score(7.3)

def test_falls_back_to_incident_count_when_no_load():
    eng = RiskScoringEngine({"v": {"incident_count": 2}})
    # count 2 used as load -> round(100*exp(-2/9)) = 80
    assert eng._score_incident_history({"incident_count": 2}) == 80
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_incident_scoring.py -v`
Expected: FAIL — `ImportError: cannot import name '_incident_weight'` (and curve values differ from the old `100−count×10`).

- [ ] **Step 3: Implement the helper + curve**

In `backend/app/underwriting/scoring.py`, add `import math` to the imports at the top. Add this module-level function above `class RiskScoringEngine`:

```python
# Active incidents weigh full; resolved ones still count (history matters) but
# far less — so closing a case measurably raises the safety score.
_RESOLVED_STATUSES = {"closed", "closed_archived"}


def _incident_weight(*, injury: bool, police: bool, ems: bool, status: str) -> float:
    """Per-incident contribution to the weighted safety load.

    severity = 1.0 + 0.5 each for injury / police / EMS  (range 1.0–2.5)
    status   = 0.4 if resolved else 1.0
    """
    severity = 1.0 + 0.5 * bool(injury) + 0.5 * bool(police) + 0.5 * bool(ems)
    status_factor = 0.4 if status in _RESOLVED_STATUSES else 1.0
    return severity * status_factor
```

Replace the body of `_score_incident_history` (keep the method signature) with:

```python
    def _score_incident_history(self, venue: dict) -> int:
        """Safety factor (0–100, higher is better) from a weighted incident load.

        Reads `incident_load` (severity/status-weighted, set by get_risk_score
        from live rows). Falls back to the raw `incident_count` as the load for
        dict-only callers (session-less unit fixtures, prospects). Smooth
        exponential decay — no hard floor at 10, deterministic, no recency.
        """
        load = venue.get("incident_load")
        if load is None:
            load = venue.get("incident_count", 0)
        return max(0, min(100, round(100 * math.exp(-load / 9.0))))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_incident_scoring.py -v`
Expected: PASS (all 10).

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/scoring.py backend/tests/test_incident_scoring.py
git commit -m "feat(scoring): severity/status-weighted incident load + exp decay curve"
```

---

### Task 2: Compute the live weighted load in `get_risk_score`

**Files:**
- Modify: `backend/app/underwriting/scoring.py` (the incident-count block in `get_risk_score`, ~lines 326–349 — the `COUNT(IncidentRecord)` query and the `if live_count is not None:` override)
- Test: `backend/tests/test_incident_scoring.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_incident_scoring.py`:

```python
from sqlmodel import SQLModel, Session, create_engine
from app.models import IncidentRecord
from app.seed_data import VENUES
from app.underwriting.scoring import get_risk_score, incident_delta_tracker


def _session_with(rows):
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    for i, r in enumerate(rows):
        s.add(IncidentRecord(
            id=f"t{i}", venue_id="elsewhere-brooklyn",
            occurred_at="2026-01-01T00:00:00", location="x",
            summary="x", reported_by="t",
            injury_observed=r.get("injury", False),
            police_called=r.get("police", False),
            ems_called=r.get("ems", False),
            status=r.get("status", "open"),
        ))
    s.commit()
    return s


def _safety(result):
    return result["factors"]["incident_history"]["score"]


def test_live_load_one_minor_open_incident():
    incident_delta_tracker.reset()
    s = _session_with([{}])  # one minor open -> load 1.0 -> 89
    assert _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=s)) == 89


def test_live_load_resolved_scores_higher_than_open():
    incident_delta_tracker.reset()
    open_s = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"status": "open"}])))
    closed_s = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"status": "closed"}])))
    assert closed_s > open_s


def test_live_load_severity_lowers_score():
    incident_delta_tracker.reset()
    minor = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{}])))
    severe = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"injury": True, "police": True, "ems": True}])))
    assert severe < minor


def test_live_zero_rows_is_clean():
    incident_delta_tracker.reset()
    assert _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([]))) == 100
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_incident_scoring.py -k live -v`
Expected: FAIL — the current code sums a `COUNT(*)` into `incident_count`, so a single open incident scores 90 (old curve) not 89, severity is ignored (severe == minor), and `incident_load` is never set.

- [ ] **Step 3: Implement the live load**

In `get_risk_score`, replace the `COUNT(IncidentRecord)` query + the `if live_count is not None:` override block with a row-select that derives both the count (for display) and the weighted load. The current block looks like:

```python
    live_count: int | None = None
    if session is not None and not is_prospect:
        try:
            from sqlmodel import select, func  # local import: avoid module-load cycle
            from app.models import IncidentRecord
            raw = session.exec(
                select(func.count(IncidentRecord.id)).where(IncidentRecord.venue_id == venue_id)
            ).one()
            if isinstance(raw, int):
                live_count = raw
            elif hasattr(raw, "__getitem__"):
                live_count = int(raw[0]) if raw[0] is not None else 0
            else:
                live_count = int(raw) if raw is not None else 0
        except Exception:
            live_count = None  # any DB issue → fall through to baseline path

    if live_count is not None:
        # DB query succeeded — authoritative, including a genuine 0. ...
        overrides["incident_count"] = live_count
    else:
        incident_delta = tracker.incident_delta(venue_id)
        if incident_delta > 0:
            overrides["incident_count"] = base_venue.get("incident_count", 0) + incident_delta
```

Replace it with:

```python
    # Live incident load (book venues, when a DB session is available). We read
    # the rows (not just COUNT) to weight each incident by severity (injury/
    # police/EMS) and status (open vs resolved). A successful query is
    # authoritative — including zero rows → load 0 → clean score. Only a missing
    # query (no session, prospect, or DB error → live_rows is None) falls back
    # to the dict baseline + delta tracker, keeping session-less fixtures working.
    live_rows = None
    if session is not None and not is_prospect:
        try:
            from sqlmodel import select  # local import: avoid module-load cycle
            from app.models import IncidentRecord
            live_rows = session.exec(
                select(
                    IncidentRecord.injury_observed,
                    IncidentRecord.police_called,
                    IncidentRecord.ems_called,
                    IncidentRecord.status,
                ).where(IncidentRecord.venue_id == venue_id)
            ).all()
        except Exception:
            live_rows = None  # any DB issue → fall through to baseline path

    if live_rows is not None:
        overrides["incident_count"] = len(live_rows)   # total, for display
        overrides["incident_load"] = sum(
            _incident_weight(injury=r[0], police=r[1], ems=r[2], status=r[3])
            for r in live_rows
        )
    else:
        incident_delta = tracker.incident_delta(venue_id)
        if incident_delta > 0:
            overrides["incident_count"] = base_venue.get("incident_count", 0) + incident_delta
```

(The engine's `_score_incident_history` already prefers `incident_load`; the no-session branch leaves it unset so the baseline `incident_count` is used as the load — see Task 1.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/test_incident_scoring.py -v`
Expected: PASS (all, including the `live` set).

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/scoring.py backend/tests/test_incident_scoring.py
git commit -m "feat(scoring): weight live incident load by severity + open/resolved status"
```

---

### Task 3: Re-baseline the affected score/pricing tests

**Files:** `backend/tests/test_portfolio.py`, `test_pricing_carrier_aware.py`, `test_pricing_loss_adjustment.py`, `test_risk_score_live_delta.py`, `test_prospects.py` (only the ones the run flags).

- [ ] **Step 1: Run the full suite and capture failures**

Run: `cd backend && python -m pytest -q`
Expected: the new `test_incident_scoring.py` passes; some pre-existing tests that pin an exact incident-driven score/tier/premium now FAIL because the curve changed (e.g. a venue at count 5 now scores 57, not 50). Inequality-based tests (e.g. most of `test_risk_score_live_delta.py` — "after < before") should still pass.

- [ ] **Step 2: Update each failed assertion to the new expected value**

For each failure, read the test, recompute the expected number from the new model (load → `round(100·exp(−load/9))`, weighted into the venue's total via the existing `WEIGHTS`), and update the pinned value. Do **not** weaken assertions to inequalities — keep them exact, just re-pinned. If a test's intent is "tier shifts after N incidents," confirm the new curve still produces that shift and update the boundary N if needed. Add a one-line comment on any changed expectation noting it was re-baselined for the weighted-load curve (dated 2026-05-28).

- [ ] **Step 3: Re-run until green**

Run: `cd backend && python -m pytest -q`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/
git commit -m "test: re-baseline score/pricing expectations for the weighted incident curve"
```

---

### Task 4: Eval gate, scoreboard, full-suite verification

**Files:** possibly `backend/app/evals/eval-baseline.json`, `frontend/public/eval-baseline.json` (only if scores shift).

- [ ] **Step 1: Eval baseline gate**

Run: `cd backend && python -m app.evals.runner --compare-baseline`
Expected: exit 0, no `REGRESSED`. (Risk scoring isn't the eval target, so this should be unaffected. If it drifts, inspect before re-baselining.)

- [ ] **Step 2: Refresh the public scoreboard only if it changed**

The portfolio/risk scores feeding `frontend/public/eval-baseline.json` and the `/evals` board are unrelated to this change (that board is the *eval scorers*, not venue risk scores). Confirm with `git status` that no generated baseline changed; if one did, regenerate it with the runner's write flag and review the diff.

- [ ] **Step 3: Full suite green**

Run: `cd backend && python -m pytest -q`
Expected: all pass (was 776 + the new `test_incident_scoring.py` cases, minus none).

- [ ] **Step 4: Commit any baseline refresh**

```bash
git add -A && git commit -m "chore(evals): refresh baseline after incident-curve recalibration"
```
(Skip if Step 2 produced no changes.)

---

## Self-Review

**Spec coverage:**
- Severity weighting (injury/police/EMS) → Task 1 `_incident_weight`. ✅
- Open/resolved status factor → Task 1 helper + Task 2 live path. ✅
- Exp-decay curve `round(100·exp(−load/9))`, no flatline → Task 1 `_score_incident_history`. ✅
- `incident_load` with `incident_count` fallback (session-less) → Task 1 (engine) + Task 2 (no-session branch). ✅
- Live weighted load from rows; successful-query-incl-zero authority → Task 2. ✅
- Determinism (no clock) → only flags/status used; `test_curve_deterministic`. ✅
- Closing-raises-score (the disconnect fix) → `test_closing_an_incident_raises_score` + `test_live_load_resolved_scores_higher_than_open`. ✅
- Re-baseline affected tests → Task 3 (corrected target list). ✅
- Eval gate + scoreboard → Task 4. ✅
- Non-goals (recency, category, normalization, count cleanup) → not implemented. ✅

**Placeholder scan:** none — every code step has complete code; Task 3 is inherently a re-pin (intent + method shown, not a placeholder).

**Type consistency:** `_incident_weight(*, injury, police, ems, status)` identical in helper def, Task 1 tests, and the Task 2 call site. `incident_load` set in `get_risk_score` and read in `_score_incident_history`. Curve reference values (89, 76, 96, 6, 80) consistent between Task 1 tests and the `exp(−load/9)` formula.
