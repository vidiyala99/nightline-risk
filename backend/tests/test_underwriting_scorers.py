from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS


def test_scenarios_are_well_formed():
    assert len(UNDERWRITING_SCENARIOS) >= 8
    for s in UNDERWRITING_SCENARIOS:
        assert s["expected_posture"] in {"quote", "quote_with_conditions", "decline"}
        assert s["expected_rate_adequacy"] in {"adequate", "lean_debit", "lean_credit"}
        assert "inputs" in s and "why" in s


from app.evals.underwriting_scorers import run_underwriting_evals, _faithful


def test_deterministic_stack_scores_high():
    report = run_underwriting_evals()
    # The deterministic recommender should match the independently-labeled answer
    # key strongly. We assert a meaningful floor (not 100% — labels are independent).
    assert report["posture_accuracy"] >= 0.75
    assert report["rate_adequacy_accuracy"] >= 0.6
    assert report["faithfulness"] == 1.0   # deterministic is faithful by construction
    assert set(report) >= {"posture_accuracy", "rate_adequacy_accuracy", "faithfulness"}


class _FakeRec:
    """Minimal stand-in for an UnderwritingRecommendation prose pair."""

    def __init__(self, summary: str, rationale: str = ""):
        self.summary = summary
        self.rationale = rationale


def test_faithful_passes_when_all_numbers_and_tier_grounded():
    rec = _FakeRec("Tier B risk (score 66). 1 prior loss(es), $30,000 incurred.")
    grounded = {"66", "1", "30000"}
    assert _faithful(rec, grounded, "B") is True


def test_faithful_catches_hallucinated_single_digit_count():
    # Recommender grounded 1 prior loss; prose hallucinates "7 prior losses".
    # The OLD regex ([\d,]{2,}) skipped single digits and would pass this.
    rec = _FakeRec("Tier B risk (score 66). 7 prior loss(es), $30,000 incurred.")
    grounded = {"66", "1", "30000"}
    assert _faithful(rec, grounded, "B") is False


def test_faithful_catches_hallucinated_tier():
    # Every number is grounded, but the prose narrates the wrong tier.
    rec = _FakeRec("Tier A risk (score 66). 1 prior loss(es), $30,000 incurred.")
    grounded = {"66", "1", "30000"}
    assert _faithful(rec, grounded, "B") is False
