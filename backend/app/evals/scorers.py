"""Eval scorers — measure agent output against gold-standard expectations."""

from __future__ import annotations

from typing import Any

from app.agents.runtime import UnderwritingPacketAgentResult

from app.evals.report import ScorerResult


REQUIRED_RISK_FIELDS = ("type", "severity", "confidence", "explanation", "review_status")
REQUIRED_MEMO_FIELDS = ("summary", "open_questions", "review_status")
SEVERITY_LADDER = ("low", "medium", "high", "critical")
VALID_SEVERITIES = set(SEVERITY_LADDER)


def score_structural(actual: UnderwritingPacketAgentResult) -> ScorerResult:
    """Verify the packet's shape and field types match the contract."""
    failures: list[str] = []

    # Risk signal
    risk = actual.risk_signal
    for field in REQUIRED_RISK_FIELDS:
        if getattr(risk, field, None) in (None, ""):
            failures.append(f"risk_signal.{field} missing")
    if risk.severity not in VALID_SEVERITIES:
        failures.append(f"risk_signal.severity={risk.severity!r} not in {VALID_SEVERITIES}")
    if not 0 <= risk.confidence <= 1:
        failures.append(f"risk_signal.confidence={risk.confidence} out of range")

    # Memo
    memo = actual.underwriting_memo
    for field in REQUIRED_MEMO_FIELDS:
        val = getattr(memo, field, None)
        if val in (None, "") or (isinstance(val, list) and not val):
            failures.append(f"underwriting_memo.{field} missing or empty")

    # Citations + timeline + actions
    if not isinstance(actual.citations, list):
        failures.append("citations is not a list")
    if not isinstance(actual.action_plan, list) or not actual.action_plan:
        failures.append("action_plan missing or empty")
    if not isinstance(actual.claims_timeline, list):
        failures.append("claims_timeline is not a list")

    passed = not failures
    detail = "ok" if passed else "; ".join(failures)
    return ScorerResult(name="structural", passed=passed, score=1.0 if passed else 0.0, detail=detail)


def _collect_actual_source_ids(actual: UnderwritingPacketAgentResult) -> set[str]:
    """Source IDs the *retrieval/memo agents* surfaced.

    Deliberately excludes claims_timeline because that step mechanically copies
    every stream event for the venue — including it would make this scorer
    trivially pass. We want to verify the agents picked the right evidence,
    not that the pipeline plumbed events through.
    """
    ids: set[str] = {c.source_id for c in actual.citations}
    ids |= {c.source_id for c in actual.risk_signal.citations}
    ids |= {c.source_id for c in actual.underwriting_memo.citations}
    return ids


def score_severity_match(
    actual: UnderwritingPacketAgentResult, ideal: dict[str, Any]
) -> ScorerResult:
    """Compare agent severity to gold risk_level.

    Pass requires exact match. Score grades by ladder distance:
    exact = 1.0, off-by-1 = 0.5, off-by-2 = 0.25, off-by-3 = 0.0.
    Detail surfaces the distance so under/over-classification is visible.
    """
    expected = (ideal.get("risk_level") or "").lower()
    got = (actual.risk_signal.severity or "").lower()

    if expected not in VALID_SEVERITIES:
        return ScorerResult(
            name="severity_match",
            passed=True,
            score=1.0,
            detail=f"no/unknown gold risk_level ({expected!r}) — skipped",
        )
    if got not in VALID_SEVERITIES:
        return ScorerResult(
            name="severity_match",
            passed=False,
            score=0.0,
            detail=f"agent severity {got!r} not in ladder",
        )

    distance = abs(SEVERITY_LADDER.index(got) - SEVERITY_LADDER.index(expected))
    score = max(0.0, 1.0 - 0.5 * distance)
    passed = distance == 0
    if passed:
        detail = f"{got} == {expected}"
    else:
        direction = "over" if SEVERITY_LADDER.index(got) > SEVERITY_LADDER.index(expected) else "under"
        detail = f"agent={got}, gold={expected}, off by {distance} ({direction}-classified)"
    return ScorerResult(name="severity_match", passed=passed, score=score, detail=detail)


def score_citation_coverage(
    actual: UnderwritingPacketAgentResult, ideal: dict[str, Any]
) -> ScorerResult:
    """Fraction of mandatory_citations that show up anywhere in the packet."""
    mandatory: list[str] = list(ideal.get("mandatory_citations", []))
    if not mandatory:
        return ScorerResult(
            name="citation_coverage",
            passed=True,
            score=1.0,
            detail="no mandatory citations",
        )

    actual_ids = _collect_actual_source_ids(actual)
    hits = [c for c in mandatory if c in actual_ids]
    score = len(hits) / len(mandatory)
    passed = score == 1.0
    missing = [c for c in mandatory if c not in actual_ids]
    detail = (
        f"{len(hits)}/{len(mandatory)} cited"
        + (f"; missing {missing}" if missing else "")
    )
    return ScorerResult(name="citation_coverage", passed=passed, score=score, detail=detail)
