# Confidence Calibration Scorer — Design

**Date:** 2026-06-14
**Status:** ⛔ WITHDRAWN (2026-06-14). A calibration loop already exists in `backend/app/evals/calibration.py` (broker-agreement, outcome-in-band, Brier probability calibration), CI-gated via `scripts/run_calibration.py`. It calibrates against *real* broker/carrier outcomes — richer than this gold-set-severity scorer. Building this would be redundant. Kept for history; do not implement.
**Related:** [`docs/research/llm-usage-gap-analysis.md`](../../research/llm-usage-gap-analysis.md) §4 #1 (highest-leverage move), [`docs/research/insurtech-ai-native-landscape.md`](../../research/insurtech-ai-native-landscape.md) (field bar: Kalepa run-time confidence intervals + drift detection)

## Motivation

Our GTM differentiator is a first-class eval harness + confidence-routing. The landscape research found that across ~28 insurtech companies, the funded leaders that win on *correctness* (Kalepa, Cytora, Nirvana, Roots) do so by **measuring** confidence against reality, while two whole segments (pricing, claims) document **nobody** shipping an eval harness at all. We currently *assert* "confidence-routing" but never measure whether our confidence numbers mean anything.

The risk classifier emits `RiskSignal.confidence`, which gates `review_status` (auto-approve vs. needs_review). Nothing checks whether a 0.8-confidence classification is actually right ~80% of the time. This spec closes that loop as an **offline, CI-gated calibration scorer** over the existing gold eval set — turning the claim into a number with zero new persistence and zero request-path change.

This is deliberately the *classifier-vs-gold* surface (chosen over the findings-prediction seam and the comms-confidence seam) because the data exists now, it requires no new persistence, and it directly calibrates the number that gates the decision.

## Goals / Non-goals

**Goals**
- A `confidence_calibration` metric computed over every eval run, baseline-gated like existing scorers, per stack signature.
- A human-readable reliability table in the markdown report.
- Pure, unit-testable calibration math isolated from I/O.

**Non-goals (YAGNI)**
- The findings-prediction calibration loop (`RiskFindingRecord`) — a separate later sub-project (Surface A).
- The comms-confidence loop (`CommsReviewItem`) — separate (Surface C).
- Per-persona breakdown — the classifier is per-incident, not persona-scoped.
- Any chart/image — a text reliability table only.
- Any change to the request path, persistence, or the deterministic intelligence engine.

## Architecture

### Component 1 — `backend/app/evals/calibration.py` (pure)

```
@dataclass(frozen=True)
class CalibrationBin:
    lo: float; hi: float
    mean_predicted: float      # mean confidence of predictions in this bin
    observed_acc: float        # fraction correct in this bin
    count: int

@dataclass(frozen=True)
class CalibrationReport:
    n: int
    brier: float               # mean((confidence - outcome)^2); 0.0 when n == 0
    ece: float                 # Σ (count/N)·|mean_predicted - observed_acc|; 0.0 when n == 0
    bins: list[CalibrationBin] # non-empty bins only

def compute_calibration(
    pairs: list[tuple[float, bool]],
    *,
    bin_edges: tuple[float, ...] = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0001),
) -> CalibrationReport: ...
```

- No I/O. Inputs are `(predicted_confidence, was_correct)` pairs.
- Default bins span `[0.5, 1.0]` (classifier confidence floor is 0.5) in 0.1-width buckets; the top edge is `1.0001` so a 1.0 confidence lands in the last bin. `bin_edges` is injectable for tests and future tuning.
- Brier over raw pairs (bin-independent, robust to small N). ECE over non-empty bins.
- `n == 0` → `brier=0.0, ece=0.0, bins=[]` (no data ≠ failure).

### Component 2 — wiring in `backend/app/evals/runner.py`

- During the existing scenario loop, for each scenario collect one pair:
  `(result.risk_signal.confidence, result.risk_signal.severity == ideal_severity)`,
  where `ideal_severity` is the gold scenario's `ideal_output.severity`. Covers both gold and adversarial scenarios. A scenario whose gold lacks an `ideal_output.severity` is **excluded** from the calibration pairs (not counted as a wrong prediction).
- After the loop: `report = compute_calibration(pairs)`.
- Inject a run-level entry into the snapshot's `scorer_averages`:
  `{"name": "confidence_calibration", "pass_rate": round(1 - report.ece, 4)}`.
  Because `compare_to_baseline` diffs `scorer_averages` by name and flags any pass_rate drop, this gates automatically with no change to `baseline.py`.
- Stash `brier`, `ece`, and `bins` into the JSON snapshot (via `report.py`) and render a reliability table in the markdown report.

### Data flow

```
scenario run ──► UnderwritingPacketAgentResult.risk_signal {confidence, severity}
                          │
        gold ideal_output.severity ──► (confidence, severity==ideal) pair
                          │
   collect all pairs ──► compute_calibration(pairs) ──► CalibrationReport
                          │
     ├─► scorer_averages += {"confidence_calibration": 1 - ece}  (baseline-gated)
     └─► markdown report: reliability table (per-bin predicted vs observed) + Brier/ECE
```

## Gating semantics

- `pass_rate = 1 - ECE` (higher = better) so it rides the existing rule: *any drop in any scorer's pass_rate is a regression; improvements always allowed.*
- Per stack signature (`memo=…;risk=…`): the deterministic stack, Grok, and Anthropic each get their own calibration target. The deterministic classifier returns a confidence too, so this runs and gates on the keyless CI lane.
- `--update-baseline` bumps the target deliberately after a real improvement, exactly like other scorers.

## Error handling / edge cases

- **Empty run (n=0):** `ece=0` → `pass_rate=1.0` + a "no calibration data" note in the report. Never crashes.
- **All-correct / all-wrong:** ECE well-defined (single populated bin).
- **Confidence clustered high (0.8–0.99):** expected; ECE handles it. Zero-count bins are skipped in ECE and omitted from the table.
- **Small N:** the gold set is modest, so calibration is noisy at first. Documented as a known limitation that tightens as the gold set grows; Brier (bin-free) is the more stable companion metric and is reported alongside.

## Testing (TDD — tests first)

**Unit — `calibration.py`:**
- Perfect calibration (conf matches observed freq per bin) → `ece == 0`.
- Pathological overconfidence (all conf 0.9, 50% correct) → `ece ≈ 0.4`, `brier ≈ 0.41`.
- Empty pairs → `n=0, brier=0, ece=0, bins=[]`, no exception.
- Known Brier: `[(1.0, True), (0.0, False)]` → `brier == 0.0`; `[(1.0, False)]` → `brier == 1.0`.
- Single bin / zero-count bins handled (no division by zero).

**Integration — `runner`:**
- A run produces a `confidence_calibration` entry in `scorer_averages`.
- A run whose pairs are forced to worse calibration than a stored baseline trips `BaselineDiff.regressed`.

## Rollout

1. Land `calibration.py` + unit tests (TDD).
2. Wire `runner.py` + `report.py` (snapshot field + markdown table) + integration tests.
3. Run the eval, generate the first `confidence_calibration` value per stack, commit the bumped `baseline.json` as the initial target.
4. Full backend `pytest -q` green before push.
