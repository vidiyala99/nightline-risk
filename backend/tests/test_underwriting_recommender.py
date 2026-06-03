from app.schemas.domain import UnderwritingRecommendation


def test_recommendation_schema_fields():
    r = UnderwritingRecommendation(
        posture="quote_with_conditions",
        summary="s",
        rationale="r",
        subjectivities=["subject to inspection"],
        rate_adequacy="lean_debit",
        rate_adequacy_note="thin vs losses",
        confidence=0.75,
        grounding={"tier": "C"},
        provider="deterministic-uw-v1",
        model=None,
        mode="deterministic",
        fallback_reason=None,
    )
    assert r.posture == "quote_with_conditions"
    assert r.rate_adequacy == "lean_debit"
    assert r.subjectivities == ["subject to inspection"]


from decimal import Decimal
from app.underwriting.recommender import RecommenderInputs, recommend


def _inputs(**over):
    base = dict(
        tier="B", total_score=40, coverage_lines=["gl"],
        loss_by_line={}, indicated_total=Decimal("10000"),
        in_appetite=True,
    )
    base.update(over)
    return RecommenderInputs(**base)


def test_clean_low_risk_quotes():
    r = recommend(_inputs(tier="A", total_score=20, loss_by_line={}))
    assert r.posture == "quote"
    assert r.subjectivities == []


def test_out_of_appetite_declines():
    r = recommend(_inputs(in_appetite=False))
    assert r.posture == "decline"


def test_adverse_loss_gets_conditions():
    r = recommend(_inputs(
        tier="B",
        loss_by_line={"gl": {"claim_count": 2, "incurred": Decimal("60000")}},
    ))
    assert r.posture == "quote_with_conditions"
    assert any("security" in s.lower() for s in r.subjectivities)


def test_worst_tier_with_adverse_loss_declines():
    r = recommend(_inputs(
        tier="D", total_score=90,
        loss_by_line={"gl": {"claim_count": 3, "incurred": Decimal("120000")}},
    ))
    assert r.posture == "decline"
