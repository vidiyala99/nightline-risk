from app.evals.fraud_scorer import score_fraud_scorer


def test_fraud_scorer_is_100pct_on_labelled_fixtures():
    report = score_fraud_scorer()
    assert report["n"] >= 5
    assert report["accuracy"] == 1.0
