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
