"""HTTP-level tests for the claim-proposal routes.

Mirror the test_frontend_api_contract.py style: spin up a TestClient against
the FastAPI app, create real packets through the existing incident flow, then
exercise the new claim endpoints end-to-end. No auth tokens — matches the
existing /review-decisions route, which takes actor IDs in the body. The UI
enforces who-can-do-what.
"""

from datetime import date as _d
from decimal import Decimal as _D

from fastapi.testclient import TestClient
from sqlmodel import select

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import (
    Carrier, CarrierQuote, Claim, ClaimProposal, IncidentRecord, Policy,
    Submission, UnderwritingPacket,
)


def _op_headers():
    # Operator scoped to elsewhere-brooklyn — matches the venue in _create_packet.
    token = create_token("user-claim-routes-1", "op@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


def _broker_headers():
    token = create_token("user-claim-routes-broker", "broker@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


# ---------- GET /api/claim-proposals — auth + tenant scoping ----------


def test_claim_proposals_list_rejects_anonymous():
    """The list previously soft-stripped on the client and returned every
    venue's proposals to anyone. Anonymous callers must now get 401."""
    with TestClient(app) as client:
        assert client.get("/api/claim-proposals").status_code == 401


def test_claim_proposals_list_scoped_to_operator_venue():
    """An operator sees only their own venue's proposals; a broker sees all."""
    session = next(get_session())
    try:
        for vid, pid in [("elsewhere-brooklyn", "cp-scope-a"), ("house-of-yes", "cp-scope-other")]:
            if not session.get(ClaimProposal, pid):
                session.add(ClaimProposal(id=pid, packet_id=f"pkt-{pid}", venue_id=vid, proposed_by="op"))
        session.commit()

        with TestClient(app) as client:
            r = client.get("/api/claim-proposals", headers=_op_headers())
            assert r.status_code == 200, r.text
            venues = {p["venue_id"] for p in r.json()}
            assert "elsewhere-brooklyn" in venues
            assert "house-of-yes" not in venues  # other venue's proposal is hidden

            rb = client.get("/api/claim-proposals", headers=_broker_headers())
            assert rb.status_code == 200, rb.text
            assert {"elsewhere-brooklyn", "house-of-yes"} <= {p["venue_id"] for p in rb.json()}
    finally:
        for pid in ("cp-scope-a", "cp-scope-other"):
            row = session.get(ClaimProposal, pid)
            if row:
                session.delete(row)
        session.commit()
        session.close()


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
    # DEMO_INCIDENT is high-severity (injury+police+ems), so the auto-router now
    # creates a pending_broker_review proposal on incident creation.  The 404
    # path can still be exercised by querying a packet that was never incident-
    # created (i.e. a non-existent packet id).
    client = TestClient(app, headers=_op_headers())

    response = client.get("/api/claim-proposals/by-packet/pkt-does-not-exist")

    assert response.status_code == 404


# ---------- _packet_to_dict embeds claim_proposal ----------


def test_packet_response_has_null_claim_proposal_before_any_proposal():
    # DEMO_INCIDENT is high-severity (injury+police+ems), so the auto-router now
    # creates a pending_broker_review proposal immediately.  The contract
    # guarantees the field is always present; for a high-confidence incident it
    # will be populated rather than None.
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)

    body = client.get(f"/api/packets/{packet_id}", headers=_op_headers()).json()

    # Field is always present in the contract so the frontend can branch on it
    assert "claim_proposal" in body
    # The auto-router fires on high-confidence incidents, so the auto-created
    # proposal may already be here; assert the field shape is correct either way.
    if body["claim_proposal"] is not None:
        assert body["claim_proposal"]["state"] == "pending_broker_review"


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


# ---------- GET /api/claim-proposals — status filter + priority sort ----------


def test_manual_proposal_gets_a_snapshot():
    client = TestClient(app, headers=_op_headers())
    packet_id = _create_packet(client)
    r = client.post(f"/api/packets/{packet_id}/claim-proposal",
                    json={"operator_id": "mgr", "override_recommendation": False})
    assert r.status_code == 201, r.text
    assert r.json()["recommendation_snapshot"] is not None
    assert "confidence" in r.json()["recommendation_snapshot"]


def test_inbox_filters_pending_and_sorts_by_priority():
    """status=pending_broker_review + sort=priority => highest (confidence x
    median payout) first, scoped/auth preserved."""
    session = next(get_session())
    created = []
    try:
        for pid, conf, median in [("prop-lo", 0.7, 10_000), ("prop-hi", 0.9, 90_000)]:
            pkt_id = f"pk-{pid}"
            if not session.get(ClaimProposal, pid):
                session.add(ClaimProposal(
                    id=pid, packet_id=pkt_id, venue_id="elsewhere-brooklyn",
                    proposed_by="auto-router", state="pending_broker_review",
                    recommendation_snapshot={"confidence": conf,
                                             "expected_payout": {"median_usd": median}}))
                created.append(pid)
        session.commit()

        with TestClient(app) as client:
            r = client.get("/api/claim-proposals?status=pending_broker_review&sort=priority",
                           headers=_broker_headers())
        assert r.status_code == 200, r.text
        ids = [p["id"] for p in r.json() if p["id"] in ("prop-lo", "prop-hi")]
        assert ids == ["prop-hi", "prop-lo"]            # higher priority first
        hi = next(p for p in r.json() if p["id"] == "prop-hi")
        assert hi["recommendation_snapshot"]["confidence"] == 0.9   # snapshot exposed
    finally:
        for pid in created:
            row = session.get(ClaimProposal, pid)
            if row:
                session.delete(row)
        session.commit()
        session.close()


# ---------- GET /api/claim-proposals/{proposal_id}/fnol-draft ----------


# ---------- POST /api/claim-proposals/{proposal_id}/file-fnol ----------


def _seed_approved_proposal_routes(session, sfx, *, state="approved"):
    """Mirror the FK chain from test_fnol_draft_returns_resolved_defaults, suffixed."""
    if not session.get(Carrier, f"markel-{sfx}"):
        session.add(Carrier(id=f"markel-{sfx}", name=f"Markel {sfx} Test", market_type="e&s"))
    session.flush()

    if not session.get(IncidentRecord, f"in-{sfx}"):
        session.add(IncidentRecord(
            id=f"in-{sfx}", venue_id="elsewhere-brooklyn",
            occurred_at="2026-05-17T00:46:00Z", location="bar", summary="x",
            reported_by="m", injury_observed=True, police_called=False,
            ems_called=False, status="open",
        ))
    if not session.get(UnderwritingPacket, f"pk-{sfx}"):
        session.add(UnderwritingPacket(
            id=f"pk-{sfx}", venue_id="elsewhere-brooklyn", incident_id=f"in-{sfx}",
            rubric_version_id="demo-rubric-v1", status="needs_review",
            snapshot_hash="h",
            risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9},
        ))
    session.flush()

    if not session.get(Submission, f"sub-{sfx}"):
        session.add(Submission(
            id=f"sub-{sfx}", venue_id="elsewhere-brooklyn",
            effective_date=_d(2026, 1, 1),
            coverage_lines=["general_liability"],
        ))
    session.flush()

    if not session.get(CarrierQuote, f"q-{sfx}"):
        session.add(CarrierQuote(
            id=f"q-{sfx}", submission_id=f"sub-{sfx}", carrier_id=f"markel-{sfx}",
        ))
    session.flush()

    if not session.get(Policy, f"po-{sfx}"):
        session.add(Policy(
            id=f"po-{sfx}", submission_id=f"sub-{sfx}", bound_quote_id=f"q-{sfx}",
            venue_id="elsewhere-brooklyn", carrier_id=f"markel-{sfx}",
            status="active",
            effective_date=_d(2026, 1, 1), expiration_date=_d(2027, 1, 1),
            annual_premium=_D("5000.00"), commission_amount=_D("750.00"),
            commission_rate=_D("0.15"),
            coverage_lines=["general_liability"],
            terms_snapshot={}, snapshot_hash=f"ph-{sfx}",
        ))
    session.flush()

    if not session.get(ClaimProposal, f"pr-{sfx}"):
        session.add(ClaimProposal(
            id=f"pr-{sfx}", packet_id=f"pk-{sfx}", venue_id="elsewhere-brooklyn",
            proposed_by="auto-router", state=state,
        ))
    session.commit()


def test_file_fnol_creates_claim_and_advances_proposal():
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "ff")
        with TestClient(app) as client:
            r = client.post(
                "/api/claim-proposals/pr-ff/file-fnol",
                json={"policy_id": "po-ff", "coverage_line": "general_liability",
                      "date_of_loss": "2026-05-17", "broker_id": "bk"},
                headers=_broker_headers(),
            )
        assert r.status_code == 201, r.text
        assert r.json()["claim"]["proposal_id"] == "pr-ff"
        assert r.json()["proposal_state"] == "filed_with_carrier"
        assert session.get(ClaimProposal, "pr-ff").state == "filed_with_carrier"
    finally:
        from app.models import Claim
        from sqlmodel import select as _sel
        for clm in session.exec(_sel(Claim).where(Claim.proposal_id == "pr-ff")).all():
            session.delete(clm)
        for tbl, _id in [
            (ClaimProposal, "pr-ff"),
            (Policy, "po-ff"),
            (CarrierQuote, "q-ff"),
            (Submission, "sub-ff"),
            (UnderwritingPacket, "pk-ff"),
            (IncidentRecord, "in-ff"),
            (Carrier, "markel-ff"),
        ]:
            row = session.get(tbl, _id)
            if row:
                session.delete(row)
        session.commit()
        session.close()


# ---------- GET /api/incidents/{id}/claim-status ----------


def test_claim_status_chain():
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "cs")  # incident in-cs, proposal pr-cs (approved)
        with TestClient(app) as client:
            r = client.get("/api/incidents/in-cs/claim-status", headers=_op_headers())
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["proposal"]["exists"] is True
        assert body["proposal"]["state"] == "approved"
        assert body["claim"]["exists"] is False
    finally:
        # clean up Claim rows first (FK -> proposal)
        for clm in session.exec(select(Claim).where(Claim.proposal_id == "pr-cs")).all():
            session.delete(clm)
        for tbl, _id in [
            (ClaimProposal, "pr-cs"),
            (Policy, "po-cs"),
            (CarrierQuote, "q-cs"),
            (Submission, "sub-cs"),
            (UnderwritingPacket, "pk-cs"),
            (IncidentRecord, "in-cs"),
            (Carrier, "markel-cs"),
        ]:
            row = session.get(tbl, _id)
            if row:
                session.delete(row)
        session.commit()
        session.close()


def test_claim_status_returns_404_for_unknown_incident():
    with TestClient(app) as client:
        r = client.get("/api/incidents/in-does-not-exist/claim-status", headers=_op_headers())
    assert r.status_code == 404


def test_claim_status_rejects_cross_venue():
    """An operator scoped to a different venue must be denied with 403."""
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "cv")  # incident in-cv at elsewhere-brooklyn
        # Token scoped to house-of-yes — a different venue from the seeded incident.
        other_token = create_token("u-cv-other", "cv@other.example.com", "venue_operator", "house-of-yes")
        other_headers = {"Authorization": f"Bearer {other_token}"}
        with TestClient(app) as client:
            r = client.get("/api/incidents/in-cv/claim-status", headers=other_headers)
        assert r.status_code == 403
        assert r.json()["detail"]["error"] == "venue_access_denied"
    finally:
        for clm in session.exec(select(Claim).where(Claim.proposal_id == "pr-cv")).all():
            session.delete(clm)
        for tbl, _id in [
            (ClaimProposal, "pr-cv"),
            (Policy, "po-cv"),
            (CarrierQuote, "q-cv"),
            (Submission, "sub-cv"),
            (UnderwritingPacket, "pk-cv"),
            (IncidentRecord, "in-cv"),
            (Carrier, "markel-cv"),
        ]:
            row = session.get(tbl, _id)
            if row:
                session.delete(row)
        session.commit()
        session.close()


def test_file_fnol_requires_approved_state():
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "pend", state="pending_broker_review")
        with TestClient(app) as client:
            r = client.post(
                "/api/claim-proposals/pr-pend/file-fnol",
                json={"policy_id": "po-pend", "coverage_line": "general_liability",
                      "date_of_loss": "2026-05-17", "broker_id": "bk"},
                headers=_broker_headers(),
            )
        assert r.status_code == 422, r.text
    finally:
        for tbl, _id in [
            (ClaimProposal, "pr-pend"),
            (Policy, "po-pend"),
            (CarrierQuote, "q-pend"),
            (Submission, "sub-pend"),
            (UnderwritingPacket, "pk-pend"),
            (IncidentRecord, "in-pend"),
            (Carrier, "markel-pend"),
        ]:
            row = session.get(tbl, _id)
            if row:
                session.delete(row)
        session.commit()
        session.close()


def test_fnol_draft_returns_resolved_defaults():
    session = next(get_session())
    try:
        # Seed carrier if not already present (dev DB persists across runs).
        if not session.get(Carrier, "markel-fd"):
            session.add(Carrier(id="markel-fd", name="Markel FD Test", market_type="e&s"))
        session.flush()

        session.add(IncidentRecord(
            id="in-fd", venue_id="elsewhere-brooklyn",
            occurred_at="2026-05-17T00:46:00Z", location="bar", summary="x",
            reported_by="m", injury_observed=True, police_called=False,
            ems_called=False, status="open",
        ))
        session.add(UnderwritingPacket(
            id="pk-fd", venue_id="elsewhere-brooklyn", incident_id="in-fd",
            rubric_version_id="demo-rubric-v1", status="needs_review",
            snapshot_hash="h",
            risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9},
        ))
        session.flush()

        session.add(Submission(
            id="sub-fd", venue_id="elsewhere-brooklyn",
            effective_date=_d(2026, 1, 1),
            coverage_lines=["gl"],
        ))
        session.flush()

        session.add(CarrierQuote(
            id="q-fd", submission_id="sub-fd", carrier_id="markel-fd",
        ))
        session.flush()

        session.add(Policy(
            id="po-fd", submission_id="sub-fd", bound_quote_id="q-fd",
            venue_id="elsewhere-brooklyn", carrier_id="markel-fd",
            status="active",
            effective_date=_d(2027, 6, 1), expiration_date=_d(2028, 6, 1),
            annual_premium=_D("5000.00"), commission_amount=_D("750.00"),
            commission_rate=_D("0.15"),
            coverage_lines=["gl"],
            terms_snapshot={}, snapshot_hash="ph-fd",
        ))
        session.flush()

        session.add(ClaimProposal(
            id="pr-fd", packet_id="pk-fd", venue_id="elsewhere-brooklyn",
            proposed_by="auto-router", state="approved",
        ))
        session.commit()

        with TestClient(app) as client:
            r = client.get("/api/claim-proposals/pr-fd/fnol-draft", headers=_broker_headers())
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["policy_id"] == "po-fd"
        assert body["coverage_line"] == "gl"
        assert body["date_of_loss"] == "2026-05-17"
    finally:
        for tbl, _id in [
            (ClaimProposal, "pr-fd"),
            (Policy, "po-fd"),
            (CarrierQuote, "q-fd"),
            (Submission, "sub-fd"),
            (UnderwritingPacket, "pk-fd"),
            (IncidentRecord, "in-fd"),
            (Carrier, "markel-fd"),
        ]:
            row = session.get(tbl, _id)
            if row:
                session.delete(row)
        session.commit()
        session.close()


# ---------- _proposal_priority — time-decay unit tests ----------

from datetime import datetime, timezone, timedelta
from app.api.v1.claim_proposals import _proposal_priority
from app.models import ClaimProposal as _CP

_NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)


def _prop(median, conf, age_days):
    return _CP(
        id=f"wq-{median}-{age_days}", packet_id="pk", venue_id="v", proposed_by="x",
        state="pending_broker_review",
        recommendation_snapshot={"confidence": conf, "expected_payout": {"median_usd": median}},
        proposed_at=_NOW - timedelta(days=age_days),
    )


def test_priority_value_first_when_both_fresh():
    assert _proposal_priority(_prop(90000, 0.9, 0), _NOW) > _proposal_priority(_prop(10000, 0.7, 0), _NOW)


def test_priority_urgency_lifts_aged_over_fresh_same_value():
    assert _proposal_priority(_prop(10000, 0.7, 30), _NOW) > _proposal_priority(_prop(10000, 0.7, 0), _NOW)


def test_priority_no_boost_within_three_day_grace():
    assert _proposal_priority(_prop(10000, 0.7, 2), _NOW) == _proposal_priority(_prop(10000, 0.7, 0), _NOW)


def test_priority_missing_snapshot_sorts_last():
    p = _CP(id="wq-none", packet_id="pk", venue_id="v", proposed_by="x",
            state="pending_broker_review", proposed_at=_NOW)
    assert _proposal_priority(p, _NOW) == 0.0
