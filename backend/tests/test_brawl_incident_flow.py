from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


def _op_headers():
    # incident-create is now venue-access gated; file as the owning operator.
    token = create_token("user-brawl-op", "op@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


DEMO_INCIDENT = {
    "occurred_at": "2026-05-02T23:13:00Z",
    "location": "rear bar",
    "summary": "Two patrons began fighting near the rear bar during a sold-out DJ event.",
    "reported_by": "shift-lead",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def test_brawl_incident_flow_creates_cited_review_packet():
    client = TestClient(app)

    response = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json=DEMO_INCIDENT,
        headers=_op_headers(),
    )

    assert response.status_code == 201
    payload = response.json()

    assert payload["incident"]["venue_id"] == "elsewhere-brooklyn"
    assert payload["risk_signal"]["review_status"] == "needs_review"
    assert payload["risk_signal"]["severity"] == "medium"
    assert payload["action_plan"][0]["title"] == "Preserve incident evidence"
    assert payload["claims_timeline"][0]["source"] == "stream:door-count"
    assert payload["underwriting_memo"]["review_status"] == "draft"
    assert "underwriter review" in payload["underwriting_memo"]["summary"].lower()
    assert len(payload["underwriting_memo"]["citations"]) >= 3
    assert all(citation["source_id"] for citation in payload["underwriting_memo"]["citations"])


def test_brawl_incident_flow_can_log_same_demo_incident_more_than_once():
    client = TestClient(app)

    first_response = client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT, headers=_op_headers())
    second_response = client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT, headers=_op_headers())

    assert first_response.status_code == 201
    assert second_response.status_code == 201
    assert first_response.json()["incident"]["id"] != second_response.json()["incident"]["id"]
