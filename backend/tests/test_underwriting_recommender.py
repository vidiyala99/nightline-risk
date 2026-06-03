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
