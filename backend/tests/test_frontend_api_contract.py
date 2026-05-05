from fastapi.testclient import TestClient

from app.main import app


DEMO_INCIDENT = {
    "occurred_at": "2026-05-02T23:13:00Z",
    "location": "rear bar",
    "summary": "Two patrons began fighting near the rear bar during a sold-out DJ event.",
    "reported_by": "shift-lead",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def test_frontend_can_list_created_incidents():
    client = TestClient(app)

    created = client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
    assert created.status_code == 201

    response = client.get("/api/venues/elsewhere-brooklyn/incidents")

    assert response.status_code == 200
    incidents = response.json()
    assert any(incident["id"] == created.json()["incident"]["id"] for incident in incidents)


def test_frontend_can_read_live_state_and_upload_compliance_evidence():
    client = TestClient(app)

    live_response = client.get("/api/venues/elsewhere-brooklyn/live")
    assert live_response.status_code == 200
    live_state = live_response.json()
    assert live_state["venue_id"] == "elsewhere-brooklyn"
    assert "compliance_queue" in live_state

    upload_response = client.post(
        "/api/venues/elsewhere-brooklyn/compliance/INCIDENT_99A8B1/upload",
        files={"file": ("evidence.txt", b"placeholder evidence", "text/plain")},
    )

    assert upload_response.status_code == 200
    assert upload_response.json()["status"] == "accepted"


def test_frontend_can_read_dashboard_underwriting_metrics():
    client = TestClient(app)

    risk_response = client.get("/api/venues/elsewhere-brooklyn/risk-score")
    quote_response = client.get("/api/venues/elsewhere-brooklyn/quote")

    assert risk_response.status_code == 200
    assert risk_response.json()["venue_id"] == "elsewhere-brooklyn"
    assert "total_score" in risk_response.json()

    assert quote_response.status_code == 200
    assert quote_response.json()["venue_id"] == "elsewhere-brooklyn"
    assert "annual_premium" in quote_response.json()


def test_frontend_can_retrieve_packet_record_decision_and_read_audit_events():
    client = TestClient(app)

    created = client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
    assert created.status_code == 201
    incident_id = created.json()["incident"]["id"]

    packets_response = client.get(f"/api/incidents/{incident_id}/packets")
    assert packets_response.status_code == 200
    packets = packets_response.json()
    assert len(packets) == 1
    packet_id = packets[0]["id"]
    assert packets[0]["status"] == "needs_review"
    assert packets[0]["snapshot_hash"]

    decision_response = client.post(
        f"/api/packets/{packet_id}/review-decisions",
        json={
            "reviewer_id": "uw-1",
            "decision": "approved",
            "override_reason": None,
            "notes": "Evidence package reviewed.",
        },
    )
    assert decision_response.status_code == 201
    assert decision_response.json()["decision"] == "approved"

    packet_response = client.get(f"/api/packets/{packet_id}")
    assert packet_response.status_code == 200
    assert packet_response.json()["status"] == "approved"

    audit_response = client.get(f"/api/packets/{packet_id}/audit-events")
    assert audit_response.status_code == 200
    assert [event["event_type"] for event in audit_response.json()] == [
        "packet.generated",
        "packet.review_decision_recorded",
    ]
