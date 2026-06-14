# Confidence Calibration Scorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a baseline-gated `confidence_calibration` metric to the eval harness that scores how well the risk classifier's surfaced `risk_signal.confidence` matches its actual correctness against the gold set.

**Architecture:** A pure `calibration.py` module computes Brier + ECE + reliability bins from `(confidence, correct)` pairs. The runner collects those pairs during the existing scenario loop (reusing the `severity_match` scorer's pass/fail as "correct"), and injects a run-level `confidence_calibration` entry (`pass_rate = 1 - ECE`) into the snapshot's `scorer_averages` so the existing baseline diff gates it with no change to `baseline.py`.

**Tech Stack:** Python 3.11, pytest, existing `app/evals/` harness (`runner.py`, `report.py`, `scorers.py`, `baseline.py`).

**Spec:** [`docs/superpowers/specs/2026-06-14-confidence-calibration-scorer-design.md`](../specs/2026-06-14-confidence-calibration-scorer-design.md)

---

### Task 1: Pure calibration module

**Files:**
- Create: `backend/app/evals/calibration.py`
- Test: `backend/tests/test_calibration.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_calibration.py
from app.evals.calibration import compute_calibration, CalibrationReport


def test_empty_pairs_no_crash():
    r = compute_calibration([])
    assert r == CalibrationReport(n=0, brier=0.0, ece=0.0, bins=[])


def test_well_calibrated_bin_has_zero_ece():
    # 0.7 confidence, observed 70% correct -> perfectly calibrated bin.
    pairs = [(0.7, True)] * 7 + [(0.7, False)] * 3
    r = compute_calibration(pairs)
    assert r.n == 10
    assert r.ece == 0.0
    assert abs(r.brier - 0.21) < 1e-9
    assert len(r.bins) == 1
    assert r.bins[0].count == 10
    assert abs(r.bins[0].observed_acc - 0.7) < 1e-9


def test_overconfident_bin_has_high_ece():
    # 0.9 confidence, observed 50% correct -> ECE 0.4, Brier 0.41.
    pairs = [(0.9, True)] * 5 + [(0.9, False)] * 5
    r = compute_calibration(pairs)
    assert abs(r.ece - 0.4) < 1e-9
    assert abs(r.brier - 0.41) < 1e-9


def test_brier_extremes():
    assert compute_calibration([(1.0, True)]).brier == 0.0
    assert compute_calibration([(1.0, False)]).brier == 1.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_calibration.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.evals.calibration'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/evals/calibration.py
"""Confidence calibration for the eval harness.

Pure functions: given (predicted_confidence, was_correct) pairs, compute a
Brier score, Expected Calibration Error (ECE), and per-bin reliability data.
No I/O. The runner turns the ECE into a baseline-gated scorer (1 - ECE) and
renders the bins as a reliability table.
"""
from __future__ import annotations

from dataclasses import dataclass

# Bins span the classifier's confidence range [0.5, 0.99]. Top edge is 1.0001
# so a 1.0 confidence lands in the last bin. Predictions outside the edges are
# excluded from ECE bins (the classifier floor is 0.5, so this should not occur
# in practice — see spec edge cases).
DEFAULT_BIN_EDGES: tuple[float, ...] = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0001)


@dataclass(frozen=True)
class CalibrationBin:
    lo: float
    hi: float
    mean_predicted: float
    observed_acc: float
    count: int


@dataclass(frozen=True)
class CalibrationReport:
    n: int
    brier: float
    ece: float
    bins: list[CalibrationBin]


def compute_calibration(
    pairs: list[tuple[float, bool]],
    *,
    bin_edges: tuple[float, ...] = DEFAULT_BIN_EDGES,
) -> CalibrationReport:
    n = len(pairs)
    if n == 0:
        return CalibrationReport(n=0, brier=0.0, ece=0.0, bins=[])

    brier = sum((conf - (1.0 if correct else 0.0)) ** 2 for conf, correct in pairs) / n

    bins: list[CalibrationBin] = []
    ece = 0.0
    for lo, hi in zip(bin_edges, bin_edges[1:]):
        members = [(c, ok) for c, ok in pairs if lo <= c < hi]
        if not members:
            continue
        count = len(members)
        mean_predicted = sum(c for c, _ in members) / count
        observed_acc = sum(1 for _, ok in members if ok) / count
        bins.append(
            CalibrationBin(
                lo=lo, hi=hi,
                mean_predicted=mean_predicted,
                observed_acc=observed_acc,
                count=count,
            )
        )
        ece += (count / n) * abs(mean_predicted - observed_acc)

    return CalibrationReport(n=n, brier=brier, ece=ece, bins=bins)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_calibration.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/calibration.py backend/tests/test_calibration.py
git commit -m "feat(evals): pure confidence-calibration module (Brier, ECE, bins)"
```

---

### Task 2: Pairs extraction + ScenarioResult field

**Files:**
- Modify: `backend/app/evals/report.py` (add field to `ScenarioResult`, ~line 26-41)
- Modify: `backend/app/evals/calibration.py` (add `pairs_from_results`)
- Test: `backend/tests/test_calibration.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_calibration.py
from app.evals.calibration import pairs_from_results
from app.evals.report import ScenarioResult, ScorerResult


def _sev(passed: bool) -> ScorerResult:
    return ScorerResult(name="severity_match", passed=passed, score=1.0 if passed else 0.0)


def test_pairs_from_results_uses_severity_match_pass():
    results = [
        ScenarioResult(scenario_id="a", description="", predicted_confidence=0.8,
                       scorers=[_sev(True)]),
        ScenarioResult(scenario_id="b", description="", predicted_confidence=0.6,
                       scorers=[_sev(False)]),
    ]
    assert pairs_from_results(results) == [(0.8, True), (0.6, False)]


def test_pairs_from_results_excludes_missing_confidence_or_scorer():
    results = [
        # adversarial: no predicted_confidence -> excluded
        ScenarioResult(scenario_id="adv", description="", predicted_confidence=None,
                       scorers=[ScorerResult(name="structural", passed=True, score=1.0)]),
        # standard but no severity_match scorer -> excluded
        ScenarioResult(scenario_id="x", description="", predicted_confidence=0.9,
                       scorers=[ScorerResult(name="structural", passed=True, score=1.0)]),
    ]
    assert pairs_from_results(results) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_calibration.py::test_pairs_from_results_uses_severity_match_pass -q`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'predicted_confidence'`

- [ ] **Step 3: Add the field to ScenarioResult**

In `backend/app/evals/report.py`, add the field to the `ScenarioResult` dataclass (after `scenario_type: str = ""`, keeping `error` and `scorers` after it):

```python
@dataclass
class ScenarioResult:
    scenario_id: str
    description: str
    exposure_class: str = ""
    difficulty: str = ""
    scenario_type: str = ""
    predicted_confidence: float | None = None  # risk_signal.confidence for calibration; None for adversarial
    error: str | None = None
    scorers: list[ScorerResult] = field(default_factory=list)
```

- [ ] **Step 4: Add `pairs_from_results` to calibration.py**

Append to `backend/app/evals/calibration.py`:

```python
def pairs_from_results(results) -> list[tuple[float, bool]]:
    """Extract (confidence, correct) pairs from scored scenario results.

    `correct` reuses the existing ``severity_match`` scorer's pass/fail so the
    calibration outcome is defined identically to the severity scorer (DRY).
    Results without a predicted confidence (adversarial scenarios) or without a
    ``severity_match`` scorer are excluded.
    """
    pairs: list[tuple[float, bool]] = []
    for r in results:
        if r.predicted_confidence is None:
            continue
        sev = next((s for s in r.scorers if s.name == "severity_match"), None)
        if sev is None:
            continue
        pairs.append((r.predicted_confidence, sev.passed))
    return pairs
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_calibration.py -q`
Expected: PASS (6 passed)

- [ ] **Step 6: Commit**

```bash
git add backend/app/evals/calibration.py backend/app/evals/report.py backend/tests/test_calibration.py
git commit -m "feat(evals): extract calibration pairs from scenario results"
```

---

### Task 3: Render calibration into snapshot + markdown

**Files:**
- Modify: `backend/app/evals/report.py` (`snapshot_payload`, `write_json_snapshot`, `write_markdown_report`)
- Test: `backend/tests/test_eval_calibration_wiring.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_eval_calibration_wiring.py
from app.evals.calibration import CalibrationReport, CalibrationBin
from app.evals.report import ScenarioResult, ScorerResult, snapshot_payload


def _result() -> ScenarioResult:
    return ScenarioResult(
        scenario_id="a", description="", predicted_confidence=0.9,
        scorers=[ScorerResult(name="severity_match", passed=True, score=1.0)],
    )


def test_snapshot_injects_confidence_calibration_scorer():
    cal = CalibrationReport(
        n=10, brier=0.41, ece=0.4,
        bins=[CalibrationBin(lo=0.9, hi=1.0001, mean_predicted=0.9, observed_acc=0.5, count=10)],
    )
    snap = snapshot_payload([_result()], timestamp="t", calibration=cal)
    entry = next(s for s in snap["scorer_averages"] if s["name"] == "confidence_calibration")
    assert entry["pass_rate"] == 0.6  # 1 - 0.4
    assert entry["count"] == 10
    assert snap["calibration"]["ece"] == 0.4
    assert snap["calibration"]["bins"][0]["observed_acc"] == 0.5


def test_snapshot_without_calibration_has_no_entry():
    snap = snapshot_payload([_result()], timestamp="t")
    assert all(s["name"] != "confidence_calibration" for s in snap["scorer_averages"])
    assert "calibration" not in snap
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_eval_calibration_wiring.py -q`
Expected: FAIL — `TypeError: snapshot_payload() got an unexpected keyword argument 'calibration'`

- [ ] **Step 3: Thread calibration through report.py**

In `backend/app/evals/report.py`, add the import near the top (after the stdlib imports):

```python
from app.evals.calibration import CalibrationReport
```

Change `snapshot_payload`'s signature to add the keyword-only param `calibration: CalibrationReport | None = None` (alongside `stack_signature`). Then, immediately after the `averages` list is built (after the `for name in scorer_names:` loop), append the calibration scorer entry:

```python
    if calibration is not None:
        cal_pass = round(1.0 - calibration.ece, 4)
        averages.append({
            "name": "confidence_calibration",
            "pass_rate": cal_pass,
            "avg_score": cal_pass,
            "count": calibration.n,
        })
```

And after the `snapshot` dict is assembled (before `if risk_provider is not None:`), add the calibration block:

```python
    if calibration is not None:
        snapshot["calibration"] = {
            "n": calibration.n,
            "brier": calibration.brier,
            "ece": calibration.ece,
            "bins": [asdict(b) for b in calibration.bins],
        }
```

Change `write_json_snapshot`'s signature to add `calibration: CalibrationReport | None = None` and pass it through to `snapshot_payload(... calibration=calibration)`.

Change `write_markdown_report`'s signature to add `calibration: CalibrationReport | None = None`. After the "## Scorer averages" block and before `lines.append("## Scenarios")`, render the reliability section:

```python
    if calibration is not None and calibration.n:
        lines.append("## Confidence calibration")
        lines.append("")
        lines.append(
            f"**N:** {calibration.n} · **Brier:** {calibration.brier:.3f} · "
            f"**ECE:** {calibration.ece:.3f} · **Gated (1-ECE):** {1 - calibration.ece:.3f}"
        )
        lines.append("")
        lines.append("| Confidence bin | Mean predicted | Observed accuracy | N |")
        lines.append("|---|---|---|---|")
        for b in calibration.bins:
            lines.append(
                f"| {b.lo:.1f}-{b.hi:.1f} | {b.mean_predicted:.2f} | {b.observed_acc:.2f} | {b.count} |"
            )
        lines.append("")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_eval_calibration_wiring.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/report.py backend/tests/test_eval_calibration_wiring.py
git commit -m "feat(evals): render confidence calibration into snapshot and report"
```

---

### Task 4: Wire the runner end-to-end

**Files:**
- Modify: `backend/app/evals/runner.py` (`run_all` ~line 444-465; `main` ~line 527-547)
- Test: `backend/tests/test_eval_calibration_wiring.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_eval_calibration_wiring.py
from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.evals.calibration import compute_calibration, pairs_from_results
from app.evals import runner


def test_run_all_sets_predicted_confidence_on_standard_scenarios():
    runtime = UnderwritingPacketAgentRuntime()  # deterministic stack
    results = runner.run_all(runtime)
    standard = [r for r in results if r.scenario_type != "adversarial" and r.error is None]
    assert standard, "expected at least one standard scenario"
    assert all(r.predicted_confidence is not None for r in standard)
    assert all(0.0 <= r.predicted_confidence <= 1.0 for r in standard)
    # adversarial scenarios stay None
    adversarial = [r for r in results if r.scenario_type == "adversarial"]
    assert all(r.predicted_confidence is None for r in adversarial)
    # the end-to-end calibration is computable and yields a populated report
    report = compute_calibration(pairs_from_results(results))
    assert report.n == len(standard)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_eval_calibration_wiring.py::test_run_all_sets_predicted_confidence_on_standard_scenarios -q`
Expected: FAIL — `assert all(...)` fails because `predicted_confidence` is always `None`.

- [ ] **Step 3: Set predicted_confidence in run_all**

In `backend/app/evals/runner.py`, inside `run_all`, replace the `results.append(ScenarioResult(...))` block so a `predicted_confidence` is supplied for non-adversarial scenarios with a result:

```python
        predicted_confidence = (
            run.actual.risk_signal.confidence
            if run.actual is not None and scenario.get("scenario_type") != "adversarial"
            else None
        )
        results.append(
            ScenarioResult(
                scenario_id=run.scenario_id,
                description=run.description,
                exposure_class=scenario.get("exposure_class", ""),
                difficulty=scenario.get("difficulty", ""),
                scenario_type=scenario.get("scenario_type", ""),
                predicted_confidence=predicted_confidence,
                error=run.error,
                scorers=scorer_results,
            )
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_eval_calibration_wiring.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: Wire main to compute and pass calibration**

In `backend/app/evals/runner.py`, add to the imports from `app.evals`:

```python
from app.evals.calibration import compute_calibration, pairs_from_results
```

In `main`, immediately after `results = run_all(runtime, memo_provider_mode=info.mode)`:

```python
    calibration = compute_calibration(pairs_from_results(results))
```

Then add `calibration=calibration` to all three call sites:
- `write_markdown_report(results, report_path, timestamp=timestamp, provider=info, calibration=calibration)`
- `write_json_snapshot(results, json_path, timestamp=timestamp, provider=info, risk_provider=risk, stack_signature=signature, calibration=calibration)`
- the `snapshot = snapshot_payload(results, timestamp=timestamp, provider=info, risk_provider=risk, stack_signature=signature, calibration=calibration)` call

- [ ] **Step 6: Run the eval and seed the baseline**

Run: `cd backend && python -m app.evals.runner --update-baseline`
Expected: prints `Updated baseline for stack memo=deterministic-v1;risk=deterministic-classifier-v1`, and `backend/app/evals/baseline.json` now contains a `confidence_calibration` entry under that stack's `scorer_averages`.

Then verify the gate is green against the freshly-seeded baseline:

Run: `cd backend && python -m app.evals.runner --compare-baseline`
Expected: prints `OK confidence_calibration: ...`, exit 0.

- [ ] **Step 7: Full suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: PASS (existing suite + the new calibration tests; no regressions).

```bash
git add backend/app/evals/runner.py backend/app/evals/baseline.json backend/tests/test_eval_calibration_wiring.py
git commit -m "feat(evals): gate confidence calibration in the runner and seed baseline"
```

---

## Notes for the implementer

- **DRY:** "correct" is the existing `severity_match` scorer's `.passed` — do not re-derive severity equality.
- **Gating direction:** ECE is lower-is-better; we store `1 - ECE` as the `pass_rate` so the existing "any pass_rate drop is a regression" rule in `baseline.py` works unchanged.
- **First run is not a regression:** before seeding, the baseline lacks `confidence_calibration`, so `--compare-baseline` treats it as a NEW scorer (allowed). Step 6 (`--update-baseline`) seeds it; subsequent runs gate it.
- **Windows stdout is cp1252** — the markdown report uses UTF-8 (fine), but keep any new terminal `print()` ASCII-only (we add none here).
- **Per-stack:** seeding only writes the deterministic stack's baseline. Re-run `--update-baseline` under `--provider grok --risk-provider grok` etc. to seed other stacks when those keys are available (out of scope for this plan).
