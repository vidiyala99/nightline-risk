from app.intelligence.finding import (
    Finding, Subject, RecommendedAction, Prediction,
    SEVERITY_RANK, PERSONA_KINDS, rank_for,
)


def test_severity_rank_orders_high_above_low():
    assert SEVERITY_RANK["critical"] > SEVERITY_RANK["high"] > SEVERITY_RANK["medium"] > SEVERITY_RANK["low"]
    assert rank_for("high") == SEVERITY_RANK["high"]
    assert rank_for("unknown-severity") == 0


def test_persona_kinds_are_disjoint_per_persona():
    assert "evidence_gap" in PERSONA_KINDS["venue_operator"]
    assert "coverage_gap_eo" in PERSONA_KINDS["broker"]
    assert "reserve_light" in PERSONA_KINDS["carrier"]
    assert "coverage_gap_eo" not in PERSONA_KINDS["venue_operator"]


def test_finding_builds_with_nested_models():
    f = Finding(
        id="evidence_gap:incident:inc-1",
        persona="venue_operator",
        kind="evidence_gap",
        subject=Subject(entity_type="incident", entity_id="inc-1", label="Brawl", href="/incidents/inc-1"),
        severity="high",
        why=[],
        recommended_action=RecommendedAction(label="Attach evidence", href="/incidents/inc-1"),
        prediction=Prediction(claim="likely denied", falsifiable_by="claim_outcome", horizon="on_claim"),
        venue_id="v1",
    )
    assert f.severity_rank == SEVERITY_RANK["high"]
    assert f.id == "evidence_gap:incident:inc-1"
