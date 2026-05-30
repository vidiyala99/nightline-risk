"""HTTP-level tests for the claim-proposal routes.

Mirror the test_frontend_api_contract.py style: spin up a TestClient against
the FastAPI app, create real packets through the existing incident flow, then
exercise the new claim endpoints end-to-end. No auth tokens — matches the
existing /review-decisions route, which takes actor IDs in the body. The UI
enforces who-can-do-what.
"""

from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


def _op_headers():
    # Operator scoped to elsewhere-brooklyn — matches the venue in _create_packet.
    token = create_token("user-claim-routes-1", "op@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


DEMO_INCIDENT = {
    "occurred_at": "2026-05-02T23:13:00Z",
    "location": "rear bar",
    "summary": "Patron required EMS after altercation; police on scene.",
    "reported_by": "shift-lead",
    "injury_observed": True,
    "police_called": True,
    "ems_called": True,
}


def _create_packet(client: TestClient) -> str:
    """Walk through the existing incident → packet pipeline; return packet_id."""
    incident_response = client.post(
        "/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT
    )
    assert incident_response.status_code == 201
    incident_id = incident_response.json()["incident"]["id"]
    packets = client.get(f"/api/incidents/{incident_id}/packets").json()
    assert len(packets) >= 1
    return packets[0]["id"]


# ---------- POST /api/packets/{packet_id}/claim-proposal ----------


def test_operator_can_create_claim_proposal_without_override():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    response = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={
            "operator_id": "op-1",
            "override_recommendation": False,
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["state"] == "pending_broker_review"
    assert body["packet_id"] == packet_id
    assert body["override_recommendation"] is False
    assert body["proposed_by"] == "op-1"
    assert body["id"].startswith("prop-")


def test_operator_can_create_proposal_with_structured_override_reason():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    response = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={
            "operator_id": "op-1",
            "override_recommendation": True,
            "override_reason": "additional_evidence",
        },
    )

    assert response.status_code == 201
    assert response.json()["override_reason"] == "additional_evidence"


def test_proposal_with_override_but_no_reason_returns_400():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    response = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={
            "operator_id": "op-1",
            "override_recommendation": True,
        },
    )

    assert response.status_code == 400
    assert "override_reason is required" in response.json()["detail"]


def test_proposal_with_other_reason_but_no_freetext_returns_400():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    response = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={
            "operator_id": "op-1",
            "override_recommendation": True,
            "override_reason": "other",
        },
    )

    assert response.status_code == 400
    assert "override_freetext is required" in response.json()["detail"]


def test_proposal_for_unknown_packet_returns_404():
    client = TestClient(app, headers=_op_headers())

    response = client.post(
        "/api/packets/pkt-does-not-exist/claim-proposal",
        json={
            "operator_id": "op-1",
            "override_recommendation": False,
        },
    )

    assert response.status_code == 404


# ---------- POST /api/claim-proposals/{proposal_id}/broker-decision ----------


def test_broker_can_approve_pending_proposal():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    proposal_id = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    ).json()["id"]

    response = client.post(
        f"/api/claim-proposals/{proposal_id}/broker-decision",
        json={"broker_id": "br-1", "decision": "approved"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "approved"
    assert body["broker_decided_by"] == "br-1"


def test_broker_can_reject_with_notes():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    proposal_id = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    ).json()["id"]

    response = client.post(
        f"/api/claim-proposals/{proposal_id}/broker-decision",
        json={
            "broker_id": "br-1",
            "decision": "rejected",
            "notes": "Net EV is negative; recommend not filing.",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "rejected_by_broker"
    assert body["broker_notes"] == "Net EV is negative; recommend not filing."


def test_double_decision_returns_400():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    proposal_id = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    ).json()["id"]
    client.post(
        f"/api/claim-proposals/{proposal_id}/broker-decision",
        json={"broker_id": "br-1", "decision": "approved"},
    )

    response = client.post(
        f"/api/claim-proposals/{proposal_id}/broker-decision",
        json={"broker_id": "br-1", "decision": "rejected"},
    )

    assert response.status_code == 400
    assert "already decided" in response.json()["detail"]


def test_broker_decision_on_unknown_proposal_returns_404():
    client = TestClient(app, headers=_op_headers())

    response = client.post(
        "/api/claim-proposals/prop-does-not-exist/broker-decision",
        json={"broker_id": "br-1", "decision": "approved"},
    )

    assert response.status_code == 404


# ---------- GET /api/claim-proposals, GET /api/claim-proposals/by-packet/{packet_id} ----------


def test_get_claims_lists_proposals_newest_first():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    )

    response = client.get("/api/claim-proposals")
    assert response.status_code == 200
    proposals = response.json()
    assert isinstance(proposals, list)
    assert len(proposals) >= 1
    assert any(p["packet_id"] == packet_id for p in proposals)


def test_get_claims_filters_by_venue_id():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    )

    matching = client.get("/api/claim-proposals?venue_id=elsewhere-brooklyn").json()
    non_matching = client.get("/api/claim-proposals?venue_id=some-other-venue").json()

    assert any(p["packet_id"] == packet_id for p in matching)
    assert all(p["packet_id"] != packet_id for p in non_matching)


def test_get_claim_by_packet_id_returns_latest_proposal():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    proposal_id = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    ).json()["id"]

    response = client.get(f"/api/claim-proposals/by-packet/{packet_id}")

    assert response.status_code == 200
    assert response.json()["id"] == proposal_id


def test_get_claim_by_packet_id_returns_404_when_no_proposal():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    response = client.get(f"/api/claim-proposals/by-packet/{packet_id}")

    assert response.status_code == 404


# ---------- _packet_to_dict embeds claim_proposal ----------


def test_packet_response_has_null_claim_proposal_before_any_proposal():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    body = client.get(f"/api/packets/{packet_id}", headers=_op_headers()).json()

    # Field is always present in the contract so the frontend can branch on it
    assert "claim_proposal" in body
    assert body["claim_proposal"] is None


def test_packet_response_embeds_latest_claim_proposal_after_creation():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    proposal_id = client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={
            "operator_id": "op-1",
            "override_recommendation": True,
            "override_reason": "legal_counsel",
        },
    ).json()["id"]

    body = client.get(f"/api/packets/{packet_id}", headers=_op_headers()).json()

    assert body["claim_proposal"] is not None
    assert body["claim_proposal"]["id"] == proposal_id
    assert body["claim_proposal"]["state"] == "pending_broker_review"
    assert body["claim_proposal"]["override_recommendation"] is True
    assert body["claim_proposal"]["override_reason"] == "legal_counsel"


# ---------- needs_more_info round-trip (HTTP) ----------


def _pending_proposal_id(client: TestClient, packet_id: str) -> str:
    return client.post(
        f"/api/packets/{packet_id}/claim-proposal",
        json={"operator_id": "op-1", "override_recommendation": False},
    ).json()["id"]


def test_broker_request_more_info_returns_needs_more_info():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    pid = _pending_proposal_id(client, packet_id)

    response = client.post(
        f"/api/claim-proposals/{pid}/broker-decision",
        json={"broker_id": "br-1", "decision": "needs_more_info", "notes": "Upload the door footage."},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "needs_more_info"
    assert body["info_request_note"] == "Upload the door footage."
    assert body["broker_decided_by"] is None


def test_request_more_info_without_notes_returns_400():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    pid = _pending_proposal_id(client, packet_id)

    response = client.post(
        f"/api/claim-proposals/{pid}/broker-decision",
        json={"broker_id": "br-1", "decision": "needs_more_info"},
    )

    assert response.status_code == 400
    assert "notes are required" in response.json()["detail"]


def test_operator_response_requeues_then_broker_approves():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    pid = _pending_proposal_id(client, packet_id)
    client.post(
        f"/api/claim-proposals/{pid}/broker-decision",
        json={"broker_id": "br-1", "decision": "needs_more_info", "notes": "Need the report."},
    )

    resp = client.post(
        f"/api/claim-proposals/{pid}/operator-response",
        json={"operator_id": "op-1", "response_note": "Report attached."},
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "pending_broker_review"
    assert resp.json()["operator_response_note"] == "Report attached."

    approved = client.post(
        f"/api/claim-proposals/{pid}/broker-decision",
        json={"broker_id": "br-1", "decision": "approved"},
    )
    assert approved.status_code == 200
    assert approved.json()["state"] == "approved"


def test_operator_response_on_unknown_proposal_returns_404():
    client = TestClient(app, headers=_op_headers())
    response = client.post(
        "/api/claim-proposals/prop-does-not-exist/operator-response",
        json={"operator_id": "op-1", "response_note": "x"},
    )
    assert response.status_code == 404


def test_operator_response_on_pending_proposal_returns_400():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    pid = _pending_proposal_id(client, packet_id)  # still pending, no info requested

    response = client.post(
        f"/api/claim-proposals/{pid}/operator-response",
        json={"operator_id": "op-1", "response_note": "unsolicited"},
    )
    assert response.status_code == 400
    assert "not awaiting more info" in response.json()["detail"]
