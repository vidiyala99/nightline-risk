from app.services.underwriting_memo import recommendation_from_dossier_parts


def test_maps_dossier_parts_to_recommendation():
    rec = recommendation_from_dossier_parts(
        risk={"tier": "C", "total_score": 68},
        loss_run={"by_coverage_line": [
            {"coverage_line": "gl", "claim_count": 2, "incurred": "60000"},
        ]},
        coverage_lines=["gl"],
        suggested_premium_breakdown={"total": "18500"},
        in_appetite=None,
    )
    assert rec is not None
    assert rec.posture == "quote_with_conditions"
    assert rec.rate_adequacy == "lean_debit"


def test_failure_isolated_returns_none_on_bad_input():
    # missing risk → must not raise; returns None (never 500 the dossier)
    rec = recommendation_from_dossier_parts(
        risk=None, loss_run=None, coverage_lines=[],
        suggested_premium_breakdown=None, in_appetite=None,
    )
    assert rec is None
