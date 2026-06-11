from app.evals.loss_run_scorers import score_confidence_calibration, score_field_mapping


def test_field_mapping_accuracy_is_perfect_on_known_synonyms():
    result = score_field_mapping()
    assert result["accuracy"] == 1.0, result["misses"]


def test_confidence_separates_clean_from_garbled():
    result = score_confidence_calibration()
    assert result["passed"] is True, result
