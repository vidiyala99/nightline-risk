"""Three scorers over the labeled underwriting scenarios, deterministic stack:
posture_match, recommendation_faithfulness, rate_adequacy_match. The aggregates
are the reproducible pitch numbers (no API key needed)."""
from __future__ import annotations

import re
from decimal import Decimal

from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS
from app.underwriting.recommender import RecommenderInputs, recommend


def _inputs_from(raw: dict) -> RecommenderInputs:
    loss = {
        line: {"claim_count": int(v.get("claim_count", 0)),
               "incurred": Decimal(str(v.get("incurred", "0")))}
        for line, v in (raw.get("loss_by_line") or {}).items()
    }
    return RecommenderInputs(
        tier=raw["tier"], total_score=int(raw["total_score"]),
        coverage_lines=list(raw.get("coverage_lines", [])),
        loss_by_line=loss,
        indicated_total=Decimal(str(raw["indicated_total"])),
        in_appetite=raw.get("in_appetite"),
    )


def _faithful(rec, grounding_numbers: set[str], grounded_tier: str) -> bool:
    """Faithfulness guard for the (future) LLM prose path.

    Two checks, both must hold:
    1. Every integer in the prose — INCLUDING single digits (a hallucinated
       "7 prior losses" must NOT pass) — is a grounded value.
    2. The tier letter mentioned in the prose ("Tier X") is the grounded tier;
       a model that narrates the wrong tier is unfaithful even if its numbers
       happen to be grounded.
    """
    prose = f"{rec.summary} {rec.rationale}"
    # `\d[\d,]*` catches single digits and comma-grouped numbers alike.
    nums = {n.replace(",", "") for n in re.findall(r"\d[\d,]*", prose)}
    if not nums.issubset(grounding_numbers):
        return False
    tiers_in_prose = set(re.findall(r"\bTier\s+([A-D])\b", prose))
    return tiers_in_prose <= {grounded_tier}


def run_underwriting_evals() -> dict:
    posture_hits = rate_hits = faithful_hits = 0
    n = len(UNDERWRITING_SCENARIOS)
    for s in UNDERWRITING_SCENARIOS:
        rec = recommend(_inputs_from(s["inputs"]))
        if rec.posture == s["expected_posture"]:
            posture_hits += 1
        if rec.rate_adequacy == s["expected_rate_adequacy"]:
            rate_hits += 1
        grounded = {str(rec.grounding.get("total_score", "")),
                    str(rec.grounding.get("total_incurred", "")),
                    str(rec.grounding.get("indicated_total", "")),
                    str(rec.grounding.get("claim_count", ""))}
        grounded = {g for g in grounded if g}
        if _faithful(rec, grounded, str(rec.grounding.get("tier", ""))):
            faithful_hits += 1
    return {
        "posture_accuracy": posture_hits / n,
        "rate_adequacy_accuracy": rate_hits / n,
        "faithfulness": faithful_hits / n,
        "scenario_count": n,
    }
