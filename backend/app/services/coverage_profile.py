"""Onboarding coverage-profile rules: completion, validation, and the quote gate.

Pure functions over primitives + dicts — no DB, no session — so they're trivially
testable and reusable by the venue write path (#1) and the placement quote action (#2).
"""
from __future__ import annotations

CARRIER_SENTINELS = {"uninsured", "unsure"}


class CoverageProfileError(Exception):
    """Invalid coverage-profile input (e.g. unknown coverage line). Maps to 400."""


class OnboardingIncompleteError(Exception):
    """Venue isn't shoppable yet. Maps to 422. Carries the missing field names."""

    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__(f"Onboarding incomplete; missing: {', '.join(missing)}")


def _coverage_line_ids() -> set[str]:
    from app.seed_carriers import COVERAGE_LINES
    return {line["id"] for line in COVERAGE_LINES}


def validate_coverage_interest(ids: list[str]) -> list[str]:
    """Return the ids unchanged if every one is a known CoverageLine; else raise."""
    known = _coverage_line_ids()
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise CoverageProfileError(f"Unknown coverage line(s): {', '.join(unknown)}")
    return ids


def compute_onboarding_complete(current_carrier: str | None, coverage_interest: list[str]) -> bool:
    """Shoppable iff the operator answered the insurance question (any branch) and
    picked at least one coverage line. The 'I have a policy' branch's renewal_date
    requirement is enforced at field-validation time (set_coverage_profile), not here."""
    answered = bool(current_carrier)
    return answered and len(coverage_interest) >= 1


def assert_onboarding_complete(venue: dict) -> None:
    """Guard for the quote/coverage-request action. Raises OnboardingIncompleteError
    with the list of missing fields. (Wired to the live quote action in sub-project #2.)"""
    missing: list[str] = []
    if not venue.get("current_carrier"):
        missing.append("current_carrier")
    if not (venue.get("coverage_interest") or []):
        missing.append("coverage_interest")
    if missing:
        raise OnboardingIncompleteError(missing)


def set_coverage_profile(session, venue, *, current_carrier, renewal_date, coverage_interest):
    """Validate + write the four onboarding columns onto a Venue row (no commit —
    the caller owns the transaction). Raises CoverageProfileError on bad input."""
    import json as _json

    carrier = (current_carrier or "").strip() or None
    lines = validate_coverage_interest(list(coverage_interest or []))

    is_real_carrier = carrier is not None and carrier not in CARRIER_SENTINELS
    if is_real_carrier and not renewal_date:
        raise CoverageProfileError("renewal_date is required when a current carrier is given")

    venue.current_carrier = carrier
    venue.renewal_date = renewal_date or None
    venue.coverage_interest = _json.dumps(lines)
    venue.onboarding_complete = compute_onboarding_complete(carrier, lines)
    session.add(venue)
