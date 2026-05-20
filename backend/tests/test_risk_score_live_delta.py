"""Verify the risk score reacts to new incidents in real time.

This is the test the original audit said was missing: it was the gap between
"the system pitches AI-native risk monitoring" and "the score is computed from
a frozen seed constant." With the delta tracker wired through
`get_risk_score`, an incident logged via the API must move the score (and
eventually the tier) without restarting the server.
"""

from app.seed_data import VENUES
from app.underwriting.scoring import get_risk_score, incident_delta_tracker


VENUE = "elsewhere-brooklyn"


def test_baseline_score_matches_seed():
    incident_delta_tracker.reset()
    baseline = get_risk_score(VENUE, VENUES)
    # Seed says Elsewhere is well-managed (2 incidents, 1 compliance, 12 yrs,
    # high security, prior carrier) — should land in A.
    assert baseline["tier"] == "A"
    assert baseline["delta"] == {"incident_delta": 0, "compliance_delta": 0}


def test_score_drops_when_incidents_accumulate():
    incident_delta_tracker.reset()
    before = get_risk_score(VENUE, VENUES)
    incident_delta_tracker.bump_incident(VENUE)
    incident_delta_tracker.bump_incident(VENUE)
    incident_delta_tracker.bump_incident(VENUE)
    after = get_risk_score(VENUE, VENUES)
    assert after["total_score"] < before["total_score"]
    assert after["delta"]["incident_delta"] == 3


def test_score_drops_when_compliance_grows():
    incident_delta_tracker.reset()
    before = get_risk_score(VENUE, VENUES)
    incident_delta_tracker.bump_compliance(VENUE)
    incident_delta_tracker.bump_compliance(VENUE)
    after = get_risk_score(VENUE, VENUES)
    assert after["total_score"] < before["total_score"]
    assert after["delta"]["compliance_delta"] == 2


def test_seed_baseline_preserved_after_delta():
    """The curated VENUES["incident_count"] must not be mutated by deltas."""
    incident_delta_tracker.reset()
    baseline_value = VENUES[VENUE]["incident_count"]
    incident_delta_tracker.bump_incident(VENUE, by=10)
    get_risk_score(VENUE, VENUES)  # consume the delta
    assert VENUES[VENUE]["incident_count"] == baseline_value


def test_delta_independent_per_venue():
    incident_delta_tracker.reset()
    incident_delta_tracker.bump_incident("elsewhere-brooklyn", by=5)
    other = get_risk_score("brooklyn-mirage", VENUES)
    assert other["delta"]["incident_delta"] == 0
