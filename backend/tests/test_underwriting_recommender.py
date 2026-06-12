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


def test_rate_adequacy_lean_debit_when_losses_heavy_vs_premium():
    r = recommend(_inputs(
        indicated_total=Decimal("10000"),
        loss_by_line={"gl": {"claim_count": 1, "incurred": Decimal("9000")}},
    ))
    assert r.rate_adequacy == "lean_debit"


def test_rate_adequacy_lean_credit_when_premium_generous():
    r = recommend(_inputs(
        indicated_total=Decimal("10000"),
        loss_by_line={"gl": {"claim_count": 1, "incurred": Decimal("1000")}},
    ))
    assert r.rate_adequacy == "lean_credit"


def test_rate_adequacy_adequate_with_no_losses():
    r = recommend(_inputs(loss_by_line={}, indicated_total=Decimal("10000")))
    assert r.rate_adequacy == "adequate"


from app.ai_provenance import AIProvenance


def test_recommendation_carries_provenance():
    # Every AI output must carry its lineage {provider, model, prompt_version,
    # input_hash} — the sibling of fraud_signal/vision provenance + the flywheel key.
    r = recommend(_inputs(tier="A", total_score=20))
    assert r.provenance is not None
    prov = AIProvenance(**r.provenance)
    assert prov.provider == "deterministic"
    assert prov.model == "uw-recommender"
    assert prov.prompt_version  # a non-empty contract version
    assert len(prov.input_hash) == 16


def test_recommendation_provenance_hash_reflects_inputs():
    # The fingerprint must reflect the actual underwriting inputs, not be a constant.
    a = recommend(_inputs(tier="A", total_score=20)).provenance["input_hash"]
    b = recommend(_inputs(tier="D", total_score=95)).provenance["input_hash"]
    assert a != b


def test_summary_and_grounding_reference_real_numbers():
    r = recommend(_inputs(
        tier="C", total_score=68,
        loss_by_line={"gl": {"claim_count": 2, "incurred": Decimal("60000")}},
        indicated_total=Decimal("18500"),
    ))
    assert "C" in r.summary
    assert "60000" in r.summary or "60,000" in r.summary
    # faithfulness: every number in grounding, prose references only grounded values
    assert r.grounding["tier"] == "C"
    assert r.grounding["total_score"] == 68
    assert r.grounding["indicated_total"] == "18500"
    assert r.grounding["total_incurred"] == "60000"
