"""HTTP-level tests for the override-stats routes.

Two endpoints:
    GET /api/override-stats                       — cross-venue aggregate
    GET /api/venues/{venue_id}/override-stats     — single-venue scoped

Both return the OverrideStats dataclass serialized as JSON. The single-venue
route returns 404 if the venue isn't recognized; this matches the existing
pattern from /api/venues/{venue_id}/risk-score.
"""

from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


def _broker():
    # incident-create + claim-proposal are venue-access gated; these helpers span
    # multiple venues, so use a broker token (passes any venue).
    return {"Authorization": f"Bearer {create_token('u-ovr-brk', 'b@e.com', 'broker', None)}"}


# A benign, low-severity incident: it classifies BELOW the auto-route threshold,
# so the agentic flow creates NO proposal. That matters here because these tests
# file a *manual override* proposal on the packet — if the incident auto-routed
# first, create_proposal's per-packet idempotency guard would return that
# (non-override) auto-proposal instead, and override_approved would stay 0. With
# a borderline packet the manual override proposal is the first and only one.
DEMO_INCIDENT = {
    "occurred_at": "2026-05-02T21:05:00Z",
    "location": "rear bar",
    "summary": "Minor verbal disagreement between two patrons; no contact, no injuries, resolved by staff.",
    "reported_by": "shift-lead",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def _create_packet_for_venue(client: TestClient, venue_id: str) -> str:
    inc = client.post(f"/api/venues/{venue_id}/incidents", json=DEMO_INCIDENT, headers=_broker())
    assert inc.status_code == 201, inc.text
    incident_id = inc.json()["incident"]["id"]
    packets = client.get(f"/api/incidents/{incident_id}/packets").json()
    return packets[0]["id"]


def _propose(client: TestClient, packet_id: str, *, override: bool, reason: str | None = None) -> str:
    body = {"operator_id": "op-1", "override_recommendation": override}
    if reason:
        body["override_reason"] = reason
    return client.post(f"/api/packets/{packet_id}/claim-proposal", json=body, headers=_broker()).json()["id"]


def _decide(client: TestClient, proposal_id: str, decision: str) -> None:
    client.post(
        f"/api/claim-proposals/{proposal_id}/broker-decision",
        json={"decision": decision, "notes": "x" if decision == "rejected" else None},
        headers=_broker(),
    )


# ---------- GET /api/override-stats (cross-venue) ----------


def test_cross_venue_override_stats_returns_stable_contract_shape():
    """Contract test: every field the frontend reads must be present and the
    right type. We can't assert exact zero counts because TestClient shares
    a file-backed SQLite with the running app (so prior test data lingers)
    — that's a pre-existing setup quirk, not a behaviour of this route."""
    client = TestClient(app)

    response = client.get("/api/override-stats")

    assert response.status_code == 200
    body = response.json()
    expected_keys = {
        "override_total", "override_approved", "override_rejected", "override_pending",
        "override_right_rate",
        "non_override_total", "non_override_approved", "non_override_rejected", "non_override_pending",
        "non_override_right_rate",
        "by_reason",
    }
    assert set(body.keys()) == expected_keys
    assert isinstance(body["override_total"], int)
    assert body["override_right_rate"] is None or isinstance(body["override_right_rate"], (int, float))
    assert isinstance(body["by_reason"], dict)


def test_cross_venue_override_stats_aggregates_across_venues():
    client = TestClient(app)

    p1 = _create_packet_for_venue(client, "elsewhere-brooklyn")
    p2 = _create_packet_for_venue(client, "elsewhere-brooklyn")
    prop1 = _propose(client, p1, override=True, reason="legal_counsel")
    prop2 = _propose(client, p2, override=True, reason="legal_counsel")
    _decide(client, prop1, "approved")
    _decide(client, prop2, "rejected")

    response = client.get("/api/override-stats")

    assert response.status_code == 200
    body = response.json()
    assert body["override_total"] >= 2
    assert body["override_approved"] >= 1
    assert body["override_rejected"] >= 1
    # Rate is computed from decided overrides only
    assert body["override_right_rate"] is not None
    assert 0.0 <= body["override_right_rate"] <= 1.0


# ---------- GET /api/venues/{venue_id}/override-stats ----------


def test_per_venue_override_stats_scopes_to_venue():
    client = TestClient(app)

    p = _create_packet_for_venue(client, "elsewhere-brooklyn")
    prop = _propose(client, p, override=True, reason="additional_evidence")
    _decide(client, prop, "approved")

    response = client.get(
        "/api/venues/elsewhere-brooklyn/override-stats", headers=_broker()
    )

    assert response.status_code == 200
    body = response.json()
    assert body["override_total"] >= 1
    assert "additional_evidence" in body["by_reason"]


def test_per_venue_override_stats_requires_access():
    """Venue-scoped like its siblings — an unauthenticated caller can't read
    another venue's QA aggregates by id (was an unscoped IDOR)."""
    client = TestClient(app)
    _create_packet_for_venue(client, "elsewhere-brooklyn")

    response = client.get("/api/venues/elsewhere-brooklyn/override-stats")

    assert response.status_code == 401


def test_per_venue_override_stats_for_unknown_venue_returns_404():
    """Mirrors /api/venues/{venue_id}/risk-score behaviour — unknown venue
    is a hard 404, not an empty-stats response."""
    client = TestClient(app)

    response = client.get("/api/venues/does-not-exist/override-stats")

    assert response.status_code == 404
