"""The calibration CI gate (backlog: close the calibration loop).

Locks the calibration *computation* against accidental regressions using a
deterministic in-memory fixture (app/evals/calibration_fixture.py) and a
committed baseline (app/evals/calibration_baseline.json). Parallels the
synthetic-scenario gate in app/evals/runner.py.
"""
import json

from scripts.run_calibration import (
    BASELINE_PATH,
    _diff_summaries,
    _run_on_fixture,
    _summary,
)


def test_fixture_matches_committed_baseline():
    """The fixture must reproduce the committed baseline exactly — if this
    fails, either the calibration math changed (regenerate the baseline) or a
    real regression was introduced."""
    current = _summary(_run_on_fixture())
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    assert _diff_summaries(current, baseline) == []


def test_fixture_is_deterministic():
    """Two independent runs of the fixture yield identical metrics (no DB/
    ordering nondeterminism leaking into the gate)."""
    assert _summary(_run_on_fixture()) == _summary(_run_on_fixture())


def test_gate_detects_drift():
    """A changed metric must be reported as drift (the gate isn't a no-op)."""
    current = _summary(_run_on_fixture())
    tampered = json.loads(json.dumps(current))
    tampered["broker_agreement"]["agreement_rate"] += 0.25
    diffs = _diff_summaries(current, tampered)
    assert any("agreement_rate" in d for d in diffs)


def test_fixture_metrics_are_non_degenerate():
    """Guard against a fixture that silently collapses to empty/trivial values
    (which would make the gate vacuous)."""
    s = _summary(_run_on_fixture())
    assert s["broker_agreement"]["total_packets_with_decision"] > 0
    assert s["outcome_in_band"]["total_closed_with_prediction"] > 0
    assert s["probability_calibration"]["n_total"] > 0
    assert 0.0 < s["broker_agreement"]["agreement_rate"] < 1.0
