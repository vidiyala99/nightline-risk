import pytest
from app.services.underwriting_desk import validate_coverage_terms
from app.services.submissions import SubmissionsError


def _ok_terms():
    return {
        "lines": {"gl": {"limit": "1000000", "deductible": "2500", "sublimit": None}},
        "subjectivities": [{"text": "Proof of licensed security staffing", "status": "open"}],
        "exclusions": ["Communicable disease"],
        "endorsements": ["Liquor liability endorsement"],
        "schedule_mods": [{"category": "Loss experience", "kind": "debit", "pct": "10"}],
        "valid_until": "2099-01-01",
    }


def test_valid_terms_pass():
    validate_coverage_terms(_ok_terms(), coverage_lines=["gl", "liquor"])


def test_empty_terms_allowed():
    validate_coverage_terms({}, coverage_lines=["gl"])


def test_bad_subjectivity_status_rejected():
    t = _ok_terms(); t["subjectivities"][0]["status"] = "maybe"
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])


def test_line_not_in_submission_rejected():
    t = _ok_terms(); t["lines"]["cyber"] = {"limit": "1000000", "deductible": "0"}
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])


def test_past_valid_until_rejected():
    t = _ok_terms(); t["valid_until"] = "2000-01-01"
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])


def test_negative_pct_rejected():
    t = _ok_terms(); t["schedule_mods"][0]["pct"] = "-5"
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])
