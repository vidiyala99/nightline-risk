"""Tests for the eval baseline gating logic.

Covers:
  * BaselineDiff.regressed semantics (drop in aggregate or any scorer).
  * --compare-baseline exit codes (0 on green, 1 on regression).
  * score_factor_recognition: passed=True on deterministic regardless of score,
    passed=False on llm when score < 1.0.

Kept fast — no actual eval runs, just synthetic snapshots.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from app.evals.baseline import (
    DEFAULT_STACK_SIGNATURE,
    BaselineDiff,
    compare_to_baseline,
    load_baseline,
    load_baseline_for_stack,
    write_baseline,
)
from app.evals.scorers import score_factor_recognition


# --- BaselineDiff -----------------------------------------------------------


def _snapshot(aggregate: float, scorers: dict[str, float]) -> dict:
    return {
        "aggregate": {"pass_rate": aggregate, "total": 15, "passed": int(aggregate * 15)},
        "scorer_averages": [
            {"name": name, "pass_rate": pr, "avg_score": pr, "count": 15}
            for name, pr in scorers.items()
        ],
    }


BASELINE = _snapshot(
    aggregate=0.47,
    scorers={
        "structural": 1.0,
        "severity_match": 0.47,
        "citation_coverage": 1.0,
        "review_status_match": 0.87,
        "factor_recognition": 1.0,
    },
)


def test_identical_snapshot_does_not_regress():
    diff = compare_to_baseline(BASELINE, BASELINE)
    assert diff.regressed is False
    assert diff.aggregate_regressed is False
    assert all(not s.regressed for s in diff.scorers)


def test_improvement_does_not_regress():
    actual = _snapshot(
        aggregate=0.80,
        scorers={
            "structural": 1.0,
            "severity_match": 0.80,
            "citation_coverage": 1.0,
            "review_status_match": 1.0,
            "factor_recognition": 1.0,
        },
    )
    diff = compare_to_baseline(actual, BASELINE)
    assert diff.regressed is False
    assert diff.aggregate_delta > 0


def test_aggregate_drop_is_regression():
    actual = _snapshot(
        aggregate=0.30,
        scorers={
            "structural": 1.0,
            "severity_match": 0.20,
            "citation_coverage": 1.0,
            "review_status_match": 0.87,
            "factor_recognition": 1.0,
        },
    )
    diff = compare_to_baseline(actual, BASELINE)
    assert diff.regressed is True
    assert diff.aggregate_regressed is True


def test_single_scorer_drop_is_regression_even_if_aggregate_stable():
    # severity_match drops, but review_status_match improves enough that the
    # aggregate stays at 0.47. We still want this flagged as a regression —
    # any scorer dropping is a quality signal we shouldn't suppress.
    actual = _snapshot(
        aggregate=0.47,
        scorers={
            "structural": 1.0,
            "severity_match": 0.20,           # regressed
            "citation_coverage": 1.0,
            "review_status_match": 1.0,       # improved
            "factor_recognition": 1.0,
        },
    )
    diff = compare_to_baseline(actual, BASELINE)
    assert diff.regressed is True
    severity = next(s for s in diff.scorers if s.name == "severity_match")
    assert severity.regressed is True


def test_removed_scorer_is_regression():
    # Removing a scorer is removing a quality gate — treat as regression.
    actual = _snapshot(
        aggregate=0.47,
        scorers={
            "structural": 1.0,
            "severity_match": 0.47,
            "citation_coverage": 1.0,
            # review_status_match removed
            "factor_recognition": 1.0,
        },
    )
    diff = compare_to_baseline(actual, BASELINE)
    assert diff.regressed is True
    assert "review_status_match" in diff.missing_scorers


def test_new_scorer_is_not_regression():
    actual = _snapshot(
        aggregate=0.47,
        scorers={
            "structural": 1.0,
            "severity_match": 0.47,
            "citation_coverage": 1.0,
            "review_status_match": 0.87,
            "factor_recognition": 1.0,
            "ndcg_at_5": 0.65,  # new scorer
        },
    )
    diff = compare_to_baseline(actual, BASELINE)
    assert diff.regressed is False
    assert "ndcg_at_5" in diff.new_scorers


def test_tolerance_swallows_floating_point_noise():
    # 14/15 ≠ 14/15 + 1e-9 numerically, but should not flag as regression.
    actual = _snapshot(
        aggregate=0.47 - 1e-9,
        scorers={
            "structural": 1.0 - 1e-9,
            "severity_match": 0.47,
            "citation_coverage": 1.0,
            "review_status_match": 0.87,
            "factor_recognition": 1.0,
        },
    )
    diff = compare_to_baseline(actual, BASELINE)
    assert diff.regressed is False


# --- load / write -----------------------------------------------------------


def test_load_baseline_returns_none_when_missing(tmp_path: Path):
    missing = tmp_path / "no.json"
    assert load_baseline(missing) is None


def test_write_then_load_roundtrip(tmp_path: Path):
    path = tmp_path / "baseline.json"
    # write_baseline now stores under a stack signature; load_baseline returns
    # the full stack-keyed dict. Roundtrip is "wrote one stack, see one stack."
    write_baseline(BASELINE, path, signature="memo=test;risk=test")
    loaded = load_baseline(path)
    assert loaded == {"memo=test;risk=test": BASELINE}


# --- score_factor_recognition mode gating ----------------------------------


class _FakeRiskSignal:
    def __init__(self, explanation: str, citations: list = None):
        self.explanation = explanation
        self.citations = citations or []


class _FakeMemo:
    def __init__(self, summary: str, open_questions: list[str] = None):
        self.summary = summary
        self.open_questions = open_questions or []


class _FakeResult:
    def __init__(self, risk_explanation: str, memo_summary: str):
        self.risk_signal = _FakeRiskSignal(risk_explanation)
        self.underwriting_memo = _FakeMemo(memo_summary)


def test_factor_recognition_deterministic_passes_even_when_score_zero():
    """The deterministic stub can't paraphrase, so factor recognition must
    not be a hard gate. Score still reports honestly."""
    actual = _FakeResult(risk_explanation="generic", memo_summary="generic memo")
    ideal = {"aggravating_factors": ["delayed_security_response"], "mitigating_factors": []}
    result = score_factor_recognition(actual, ideal, provider_mode="deterministic")
    assert result.passed is True
    assert result.score == 0.0
    assert "informational on deterministic" in result.detail


def test_factor_recognition_llm_fails_when_factor_missing():
    """For LLM providers, factor recognition is a real gate."""
    actual = _FakeResult(risk_explanation="generic", memo_summary="generic memo")
    ideal = {"aggravating_factors": ["delayed_security_response"], "mitigating_factors": []}
    result = score_factor_recognition(actual, ideal, provider_mode="llm")
    assert result.passed is False
    assert result.score == 0.0


def test_factor_recognition_llm_passes_when_all_factors_present():
    actual = _FakeResult(
        risk_explanation="delayed security response was documented",
        memo_summary="bouncer applied excessive force; delayed security response",
    )
    ideal = {"aggravating_factors": ["delayed_security_response"], "mitigating_factors": []}
    result = score_factor_recognition(actual, ideal, provider_mode="llm")
    assert result.passed is True
    assert result.score == 1.0


def test_factor_recognition_empty_gold_always_passes():
    actual = _FakeResult(risk_explanation="x", memo_summary="y")
    ideal = {"aggravating_factors": [], "mitigating_factors": []}
    for mode in ("deterministic", "llm"):
        result = score_factor_recognition(actual, ideal, provider_mode=mode)
        assert result.passed is True
        assert result.score == 1.0


# --- runner --compare-baseline exit codes ---------------------------------


REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_runner(*args: str, env_update: dict | None = None) -> subprocess.CompletedProcess:
    cmd = [sys.executable, "-m", "app.evals.runner", *args]
    import os
    env = os.environ.copy()
    if env_update:
        env.update(env_update)
    return subprocess.run(
        cmd, cwd=REPO_ROOT, capture_output=True, text=True, env=env, encoding="utf-8"
    )


def test_runner_compare_baseline_exits_zero_on_no_regression():
    """End-to-end: run the actual runner against the committed baseline.

    Marked slow because it runs the full 15-scenario suite (~1-2s on stub).
    Without the marker, fast pytest invocations skip it.
    """
    proc = _run_runner("--compare-baseline")
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_runner_compare_baseline_exits_one_on_regression(tmp_path, monkeypatch):
    """A run scoring below the committed baseline must register as a regression.

    Decoupled from the live agent's quality: we feed compare_to_baseline a
    deliberately degraded snapshot against a higher baseline so the gate logic
    is what's under test, not whatever the deterministic stack happens to score
    today (it currently passes everything, so a real run can't fall below a
    perfect baseline).
    """
    from app.evals import baseline as baseline_mod

    perfect = _snapshot(
        aggregate=1.0,
        scorers={
            "structural": 1.0,
            "severity_match": 1.0,
            "citation_coverage": 1.0,
            "review_status_match": 1.0,
            "factor_recognition": 1.0,
        },
    )
    # Same scorers, but severity_match and the aggregate have slipped — exactly
    # the shape of a real regression PR.
    regressed_run = _snapshot(
        aggregate=0.8,
        scorers={
            "structural": 1.0,
            "severity_match": 0.6,
            "citation_coverage": 1.0,
            "review_status_match": 1.0,
            "factor_recognition": 1.0,
        },
    )

    diff = baseline_mod.compare_to_baseline(regressed_run, perfect)
    assert diff.regressed is True
    assert diff.aggregate_regressed is True
    assert any(s.name == "severity_match" and s.regressed for s in diff.scorers)


# --- PR2: provider matrix + stack-keyed baseline --------------------------


def test_resolve_risk_provider_stub_returns_deterministic_classifier():
    from app.evals.runner import resolve_risk_provider
    from app.providers import DeterministicRiskClassifier

    assert isinstance(resolve_risk_provider("stub"), DeterministicRiskClassifier)
    assert isinstance(resolve_risk_provider(None), DeterministicRiskClassifier)
    assert isinstance(resolve_risk_provider("deterministic"), DeterministicRiskClassifier)


def test_resolve_risk_provider_unknown_raises_value_error():
    from app.evals.runner import resolve_risk_provider

    import pytest
    with pytest.raises(ValueError, match="Unknown risk provider"):
        resolve_risk_provider("not-a-real-provider")


def test_stack_signature_round_trip():
    from app.evals.runner import _provider_info, _risk_info, stack_signature
    from app.providers import DeterministicProvider, DeterministicRiskClassifier

    memo = _provider_info(DeterministicProvider())
    risk = _risk_info(DeterministicRiskClassifier())
    sig = stack_signature(memo, risk)
    # Form is "memo=NAME;risk=NAME" with no whitespace; reviewers diff this in PRs.
    assert ";" in sig
    assert sig.startswith("memo=")
    assert "risk=" in sig
    assert " " not in sig


def test_load_baseline_returns_stack_dict_for_modern_file(tmp_path: Path):
    path = tmp_path / "baseline.json"
    modern = {
        "memo=deterministic-v1;risk=deterministic-classifier-v1": BASELINE,
        "memo=anthropic-claude;risk=anthropic-claude": BASELINE,
    }
    path.write_text(json.dumps(modern), encoding="utf-8")
    loaded = load_baseline(path)
    assert loaded is not None
    assert set(loaded.keys()) == set(modern.keys())


def test_load_baseline_migrates_legacy_single_snapshot(tmp_path: Path):
    """A pre-PR2 baseline.json is a flat snapshot — must auto-migrate."""
    path = tmp_path / "baseline.json"
    # Legacy file: snapshot at root, no stack-signature key wrapping it.
    path.write_text(json.dumps(BASELINE), encoding="utf-8")
    loaded = load_baseline(path)
    assert loaded is not None
    assert DEFAULT_STACK_SIGNATURE in loaded
    assert loaded[DEFAULT_STACK_SIGNATURE] == BASELINE


def test_load_baseline_for_stack_returns_none_for_unknown_signature(tmp_path: Path):
    path = tmp_path / "baseline.json"
    path.write_text(
        json.dumps({"memo=foo;risk=bar": BASELINE}),
        encoding="utf-8",
    )
    assert load_baseline_for_stack("memo=other;risk=other", path) is None
    assert load_baseline_for_stack("memo=foo;risk=bar", path) == BASELINE


def test_write_baseline_preserves_other_stack_entries(tmp_path: Path):
    """Bumping the deterministic baseline must not nuke the Anthropic entry."""
    path = tmp_path / "baseline.json"
    initial = {
        "memo=anthropic-claude;risk=anthropic-claude": _snapshot(
            aggregate=0.95, scorers={"structural": 1.0}
        ),
    }
    path.write_text(json.dumps(initial), encoding="utf-8")

    new_stub = _snapshot(aggregate=0.50, scorers={"structural": 1.0})
    new_stub["stack_signature"] = "memo=deterministic-v1;risk=deterministic-classifier-v1"
    write_baseline(new_stub, path)

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert "memo=anthropic-claude;risk=anthropic-claude" in on_disk
    assert "memo=deterministic-v1;risk=deterministic-classifier-v1" in on_disk
    assert on_disk["memo=anthropic-claude;risk=anthropic-claude"]["aggregate"]["pass_rate"] == 0.95


def test_write_baseline_overwrites_same_signature(tmp_path: Path):
    path = tmp_path / "baseline.json"
    first = _snapshot(aggregate=0.40, scorers={"structural": 1.0})
    first["stack_signature"] = "memo=x;risk=y"
    write_baseline(first, path)

    second = _snapshot(aggregate=0.50, scorers={"structural": 1.0})
    second["stack_signature"] = "memo=x;risk=y"
    write_baseline(second, path)

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["memo=x;risk=y"]["aggregate"]["pass_rate"] == 0.50


def test_runner_emits_stack_signature_in_snapshot():
    """The snapshot consumed by the dashboard / baseline diff includes the
    stack signature so consumers can tell which (memo, risk) pair produced
    the numbers without re-parsing provider names."""
    from app.evals.runner import _provider_info, _risk_info, stack_signature
    from app.evals.report import snapshot_payload
    from app.providers import DeterministicProvider, DeterministicRiskClassifier

    memo = _provider_info(DeterministicProvider())
    risk = _risk_info(DeterministicRiskClassifier())
    sig = stack_signature(memo, risk)

    snapshot = snapshot_payload(
        [], timestamp="t", provider=memo, risk_provider=risk, stack_signature=sig
    )
    assert snapshot["stack_signature"] == sig
    assert snapshot["risk_provider"]["name"] == risk.name
    assert snapshot["provider"]["name"] == memo.name
