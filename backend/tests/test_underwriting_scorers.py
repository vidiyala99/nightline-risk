from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS


def test_scenarios_are_well_formed():
    assert len(UNDERWRITING_SCENARIOS) >= 8
    for s in UNDERWRITING_SCENARIOS:
        assert s["expected_posture"] in {"quote", "quote_with_conditions", "decline"}
        assert s["expected_rate_adequacy"] in {"adequate", "lean_debit", "lean_credit"}
        assert "inputs" in s and "why" in s
