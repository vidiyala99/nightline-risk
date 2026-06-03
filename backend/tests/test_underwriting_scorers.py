from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS


def test_scenarios_are_well_formed():
    assert len(UNDERWRITING_SCENARIOS) >= 8
    for s in UNDERWRITING_SCENARIOS:
        assert s["expected_posture"] in {"quote", "quote_with_conditions", "decline"}
        assert s["expected_rate_adequacy"] in {"adequate", "lean_debit", "lean_credit"}
        assert "inputs" in s and "why" in s


from app.evals.underwriting_scorers import run_underwriting_evals


def test_deterministic_stack_scores_high():
    report = run_underwriting_evals()
    # The deterministic recommender should match the independently-labeled answer
    # key strongly. We assert a meaningful floor (not 100% — labels are independent).
    assert report["posture_accuracy"] >= 0.75
    assert report["rate_adequacy_accuracy"] >= 0.6
    assert report["faithfulness"] == 1.0   # deterministic is faithful by construction
    assert set(report) >= {"posture_accuracy", "rate_adequacy_accuracy", "faithfulness"}
