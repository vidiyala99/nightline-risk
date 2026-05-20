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


def test_per_venue_reset_does_not_affect_other_venues():
    incident_delta_tracker.reset()
    incident_delta_tracker.bump_incident("elsewhere-brooklyn", by=3)
    incident_delta_tracker.bump_incident("brooklyn-mirage", by=2)
    incident_delta_tracker.reset("elsewhere-brooklyn")
    assert incident_delta_tracker.incident_delta("elsewhere-brooklyn") == 0
    assert incident_delta_tracker.incident_delta("brooklyn-mirage") == 2


# ─── HTTP integration: POST incident → score moves → quote tier reflects ───

def test_http_post_incident_moves_risk_score():
    """The full request loop: POST /api/venues/{id}/incidents bumps the
    tracker via incident_flow, and a subsequent GET on /risk-score reflects
    the new delta. This is the test that proves the demo claim end-to-end."""
    from fastapi.testclient import TestClient
    from app.main import app

    incident_delta_tracker.reset()
    with TestClient(app) as client:
        before = client.get(f"/api/venues/{VENUE}/risk-score").json()
        assert before["delta"]["incident_delta"] == 0

        post = client.post(
            f"/api/venues/{VENUE}/incidents",
            json={
                "occurred_at": "2026-05-20T22:00:00Z",
                "location": "main floor",
                "summary": "Test incident from delta-tracker integration test.",
                "reported_by": "test-suite",
                "injury_observed": False,
                "police_called": False,
                "ems_called": False,
            },
        )
        assert post.status_code == 201

        after = client.get(f"/api/venues/{VENUE}/risk-score").json()
        assert after["delta"]["incident_delta"] == 1
        assert after["total_score"] <= before["total_score"]


def test_http_quote_tier_reflects_accumulated_deltas():
    """Premium tier is derived from the (live) risk score, so accumulating
    deltas must change the quote tier — not just the underlying score."""
    from fastapi.testclient import TestClient
    from app.main import app

    incident_delta_tracker.reset()
    with TestClient(app) as client:
        before_quote = client.get(f"/api/venues/{VENUE}/quote").json()
        before_tier = before_quote["tier"]

        # Drop the tier by force-bumping enough incidents to definitively cross
        # a tier threshold. Baseline Elsewhere = score 85 (tier A); 10 incidents
        # of baseline (10*10 = -100 incident pts -> incident_score=0 -> total
        # falls into C/D range).
        incident_delta_tracker.bump_incident(VENUE, by=10)

        after_quote = client.get(f"/api/venues/{VENUE}/quote").json()
        after_tier = after_quote["tier"]
        assert after_tier != before_tier, (
            f"Quote tier should change after 10 deltas; "
            f"got before={before_tier} after={after_tier}"
        )
        # Premium goes up when tier degrades (D=2.5x base, A=0.7x base).
        if "D" in (before_tier, after_tier) or "C" in (before_tier, after_tier):
            assert after_quote["annual_premium"] >= before_quote["annual_premium"]


def test_unknown_venue_returns_clean_error():
    """Sanity: passing a venue_id not in VENUES should fail loudly, not return
    a misleading 0/A. The underlying engine raises ValueError — caller's job
    to handle, but at least it doesn't silently succeed."""
    import pytest
    incident_delta_tracker.reset()
    with pytest.raises(ValueError, match="not found"):
        get_risk_score("nonexistent-venue", VENUES)
