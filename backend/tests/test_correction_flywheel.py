"""Correction flywheel — Stage 2: a human override of the underwriting
recommendation becomes a labeled eval scenario (the gold set grows from prod).
Pure transform, no DB."""
from app.evals.correction_flywheel import override_to_scenario
from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS

_INPUTS = {
    "tier": "B", "total_score": 66, "coverage_lines": ["gl"],
    "loss_by_line": {"gl": {"claim_count": 2, "incurred": "60000"}},
    "indicated_total": "18500", "in_appetite": True,
}


def test_override_emits_labeled_scenario():
    # Underwriter declined where the AI said quote_with_conditions — a real
    # correction. It must become a scenario whose label is the HUMAN decision.
    scenario = override_to_scenario(
        inputs=_INPUTS,
        recommended_posture="quote_with_conditions",
        recommended_rate_adequacy="lean_debit",
        human_posture="decline",
        scenario_id="prod-override-abc123",
        lineage="abc1234567890def",
    )
    assert scenario is not None
    assert scenario["expected_posture"] == "decline"      # labeled by the human, not the AI
    assert scenario["inputs"] == _INPUTS                   # the scored bundle is preserved
    assert "override" in scenario["why"].lower()
    assert "abc1234567890def" in scenario["why"]           # lineage is traceable


def test_agreement_emits_no_scenario():
    # The human did what the AI suggested — no correction signal, nothing to learn.
    scenario = override_to_scenario(
        inputs=_INPUTS,
        recommended_posture="quote_with_conditions",
        recommended_rate_adequacy="lean_debit",
        human_posture="quote_with_conditions",
        scenario_id="prod-override-xyz",
    )
    assert scenario is None


def test_emitted_scenario_matches_gold_set_shape():
    # The scenario must be consumable by the existing scorer/runner unchanged.
    scenario = override_to_scenario(
        inputs=_INPUTS,
        recommended_posture="quote",
        recommended_rate_adequacy="adequate",
        human_posture="decline",
        scenario_id="prod-override-shape",
    )
    assert set(scenario.keys()) == set(UNDERWRITING_SCENARIOS[0].keys())
