"""Onboarding coverage-profile rules: completion, validation, gate guard, write."""
import pytest

from app.services.coverage_profile import (
    CoverageProfileError,
    OnboardingIncompleteError,
    assert_onboarding_complete,
    compute_onboarding_complete,
    validate_coverage_interest,
)


def test_complete_with_real_carrier_and_line():
    assert compute_onboarding_complete("Hiscox", ["gl"]) is True


def test_complete_with_uninsured_and_line_no_renewal():
    assert compute_onboarding_complete("uninsured", ["gl"]) is True


def test_complete_with_unsure_and_line():
    assert compute_onboarding_complete("unsure", ["liquor"]) is True


def test_incomplete_without_carrier_answer():
    assert compute_onboarding_complete(None, ["gl"]) is False


def test_incomplete_with_no_coverage_line():
    assert compute_onboarding_complete("Hiscox", []) is False


def test_validate_rejects_unknown_line():
    with pytest.raises(CoverageProfileError):
        validate_coverage_interest(["gl", "not_a_line"])


def test_validate_accepts_known_lines():
    assert validate_coverage_interest(["gl", "assault_battery"]) == ["gl", "assault_battery"]


def test_assert_guard_raises_when_incomplete():
    with pytest.raises(OnboardingIncompleteError) as ei:
        assert_onboarding_complete({"current_carrier": None, "coverage_interest": []})
    assert "current_carrier" in ei.value.missing


def test_assert_guard_passes_when_complete():
    assert_onboarding_complete({"current_carrier": "Hiscox", "coverage_interest": ["gl"]})


# ─── set_coverage_profile (DB write) ─────────────────────────────────────

from sqlmodel import Session  # noqa: E402

from app.database import create_db_and_tables, engine  # noqa: E402
from app.models import Venue  # noqa: E402
from app.services.coverage_profile import set_coverage_profile  # noqa: E402


def _fresh_venue(vid):
    create_db_and_tables()
    with Session(engine) as s:
        existing = s.get(Venue, vid)
        if existing:
            s.delete(existing)
            s.commit()
        s.add(Venue(id=vid, name=vid))
        s.commit()


def test_set_profile_real_carrier_persists_and_completes():
    _fresh_venue("scp-1")
    with Session(engine) as s:
        v = s.get(Venue, "scp-1")
        set_coverage_profile(s, v, current_carrier="Hiscox",
                             renewal_date="2026-09-01", coverage_interest=["gl", "liquor"])
        s.commit()
        v = s.get(Venue, "scp-1")
        assert v.current_carrier == "Hiscox"
        assert v.renewal_date == "2026-09-01"
        assert v.coverage_interest == '["gl", "liquor"]'
        assert v.onboarding_complete is True


def test_set_profile_uninsured_completes_without_renewal():
    _fresh_venue("scp-2")
    with Session(engine) as s:
        v = s.get(Venue, "scp-2")
        set_coverage_profile(s, v, current_carrier="uninsured",
                             renewal_date=None, coverage_interest=["gl"])
        assert v.onboarding_complete is True


def test_set_profile_real_carrier_without_renewal_raises():
    _fresh_venue("scp-3")
    with Session(engine) as s:
        v = s.get(Venue, "scp-3")
        with pytest.raises(CoverageProfileError):
            set_coverage_profile(s, v, current_carrier="Hiscox",
                                 renewal_date=None, coverage_interest=["gl"])
