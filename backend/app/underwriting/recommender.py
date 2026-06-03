"""Deterministic carrier underwriting recommender — a PURE function over a typed
input bundle. No DB, no I/O → reproducible (the eval pitch number) and trivially
testable. The pricing engine owns the premium NUMBER; this owns judgment."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.schemas.domain import UnderwritingRecommendation

PROVIDER_NAME = "deterministic-uw-v1"

# Tiers run A (best) → D (worst).
_ELEVATED_TIERS = {"C", "D"}
_ADVERSE_INCURRED = Decimal("50000")   # total incurred at/above this = adverse
_ADVERSE_FREQUENCY = 2                  # claim_count on a line at/above this = adverse


@dataclass(frozen=True)
class RecommenderInputs:
    tier: str                              # "A" | "B" | "C" | "D"
    total_score: int                       # 0-100
    coverage_lines: list[str]
    loss_by_line: dict                     # line -> {"claim_count": int, "incurred": Decimal}
    indicated_total: Decimal               # engine's indicated premium total
    in_appetite: bool | None = None        # None = not evaluated here
    requested_limits: dict = field(default_factory=dict)


def _total_incurred(loss_by_line: dict) -> Decimal:
    return sum((Decimal(v.get("incurred", 0)) for v in loss_by_line.values()), Decimal("0"))


def _is_adverse(loss_by_line: dict) -> bool:
    if _total_incurred(loss_by_line) >= _ADVERSE_INCURRED:
        return True
    return any(int(v.get("claim_count", 0)) >= _ADVERSE_FREQUENCY for v in loss_by_line.values())


_SUBJECTIVITY_BY_LINE = {
    "liquor": "Subject to current liquor-liability and server-training certificates.",
    "gl": "Subject to a security-staffing plan and incident-log review.",
    "assault_battery": "Subject to a security-staffing plan and incident-log review.",
}


def _subjectivities(inputs: RecommenderInputs, adverse: bool) -> list[str]:
    subs: list[str] = []
    for line, agg in inputs.loss_by_line.items():
        if int(agg.get("claim_count", 0)) >= 1 and line in _SUBJECTIVITY_BY_LINE:
            note = _SUBJECTIVITY_BY_LINE[line]
            if note not in subs:
                subs.append(note)
    if inputs.tier in _ELEVATED_TIERS:
        subs.append("Subject to a satisfactory loss-control inspection.")
    return subs


def _posture(inputs: RecommenderInputs, adverse: bool) -> str:
    if inputs.in_appetite is False:
        return "decline"
    if inputs.tier == "D" and adverse:
        return "decline"
    if inputs.tier in _ELEVATED_TIERS or adverse:
        return "quote_with_conditions"
    return "quote"


def recommend(inputs: RecommenderInputs) -> UnderwritingRecommendation:
    adverse = _is_adverse(inputs.loss_by_line)
    posture = _posture(inputs, adverse)
    subjectivities = _subjectivities(inputs, adverse) if posture == "quote_with_conditions" else []
    # rate-adequacy + summary/rationale filled in Task 3
    return UnderwritingRecommendation(
        posture=posture,
        summary="",
        rationale="",
        subjectivities=subjectivities,
        rate_adequacy="adequate",
        rate_adequacy_note="",
        confidence=0.75,
        grounding={},
        provider=PROVIDER_NAME,
        mode="deterministic",
    )
