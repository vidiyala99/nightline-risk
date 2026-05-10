"""Eval scorers — measure agent output against gold-standard expectations."""

from __future__ import annotations

from typing import Any

from app.agents.runtime import UnderwritingPacketAgentResult

from app.evals.report import ScorerResult


REQUIRED_RISK_FIELDS = ("type", "severity", "confidence", "explanation", "review_status")
REQUIRED_MEMO_FIELDS = ("summary", "open_questions", "review_status")
SEVERITY_LADDER = ("low", "medium", "high", "critical")
VALID_SEVERITIES = set(SEVERITY_LADDER)
VALID_REVIEW_STATUSES = {"approved", "needs_review", "blocked"}


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


def score_review_status_match(
    actual: UnderwritingPacketAgentResult, ideal: dict[str, Any]
) -> ScorerResult:
    """Compare agent risk_signal.review_status to gold expected_review_status.

    Strict equality. Surfaces the disagreement in the detail line.
    Skipped (passes) when gold doesn't specify an expected status.
    """
    expected = (ideal.get("expected_review_status") or "").lower()
    got = (actual.risk_signal.review_status or "").lower()

    if not expected:
        return ScorerResult(
            name="review_status_match",
            passed=True,
            score=1.0,
            detail="no expected_review_status in gold — skipped",
        )
    if expected not in VALID_REVIEW_STATUSES:
        return ScorerResult(
            name="review_status_match",
            passed=False,
            score=0.0,
            detail=f"gold expected_review_status {expected!r} not in {sorted(VALID_REVIEW_STATUSES)}",
        )

    passed = got == expected
    detail = f"{got} == {expected}" if passed else f"agent={got}, gold={expected}"
    return ScorerResult(
        name="review_status_match",
        passed=passed,
        score=1.0 if passed else 0.0,
        detail=detail,
    )


def _factor_text_pool(actual: UnderwritingPacketAgentResult) -> str:
    """Concatenate the agent text surfaces where factor evidence may appear."""
    parts: list[str] = []
    parts.append(actual.risk_signal.explanation or "")
    for c in actual.risk_signal.citations:
        parts.append(c.excerpt or "")
    parts.append(actual.underwriting_memo.summary or "")
    for q in actual.underwriting_memo.open_questions or []:
        parts.append(q)
    return " ".join(parts).lower()


def _factor_recognized(factor_name: str, text_pool: str) -> bool:
    """Heuristic: does the agent's text mention the substance of the factor?

    Factor names are snake_case (e.g. 'delayed_security_response'). We split
    on underscores and require all non-trivial tokens to appear in the agent
    text. This is intentionally permissive for v1 — the deterministic stub
    won't paraphrase, so missed recognition is real signal.
    """
    tokens = [t for t in factor_name.split("_") if len(t) > 2]
    if not tokens:
        return False
    return all(t in text_pool for t in tokens)


def score_factor_recognition(
    actual: UnderwritingPacketAgentResult, ideal: dict[str, Any]
) -> ScorerResult:
    """Fraction of expected aggravating + mitigating factors recognized in agent output.

    Skipped (passes) when gold has no factor expectations. Pass requires score = 1.0.
    """
    aggravating = list(ideal.get("aggravating_factors") or [])
    mitigating = list(ideal.get("mitigating_factors") or [])
    expected = aggravating + mitigating

    if not expected:
        return ScorerResult(
            name="factor_recognition",
            passed=True,
            score=1.0,
            detail="no factors in gold — skipped",
        )

    pool = _factor_text_pool(actual)
    recognized = [f for f in expected if _factor_recognized(f, pool)]
    missing = [f for f in expected if f not in recognized]
    score = len(recognized) / len(expected)
    passed = score == 1.0

    detail = f"{len(recognized)}/{len(expected)} recognized"
    if missing:
        detail += f"; missing {missing}"
    return ScorerResult(
        name="factor_recognition",
        passed=passed,
        score=score,
        detail=detail,
    )
