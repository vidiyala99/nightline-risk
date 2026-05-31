"""Operator-platform Phase A — gate the operator WRITE endpoints.

Before this, POST incidents / evidence / compliance-upload / claim-proposal /
operator-response were ungated: any caller could write to any venue. This pins
the same contract the read endpoints already enforce (see test_tenant_isolation
and the /risk-score gate): anonymous -> 401, an operator scoped to a different
venue -> 403, the owning operator + brokers -> success.
"""
import io

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import IncidentRecord

VENUE = "elsewhere-brooklyn"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk-gate', 'b@e.com', 'broker', None)}"}


def _owner_headers():
    return {"Authorization": f"Bearer {create_token('u-own-gate', 'o@e.com', 'venue_operator', VENUE)}"}


def _other_headers():
    # Operator scoped to a DIFFERENT venue — must be denied writes to VENUE.
    return {"Authorization": f"Bearer {create_token('u-oth-gate', 'x@e.com', 'venue_operator', 'house-of-yes')}"}


_INCIDENT = {
    "occurred_at": "2026-05-22T01:00:00Z",
    "location": "rear bar",
    "summary": "Write-gating fixture incident.",
    "reported_by": "shift-lead",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def _evidence_file():
    return {"file": ("e.txt", io.BytesIO(b"placeholder"), "text/plain")}


def _create_incident(client, headers):
    r = client.post(f"/api/venues/{VENUE}/incidents", json=_INCIDENT, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["incident"]["id"]


def _make_packet(client):
    inc = _create_incident(client, _owner_headers())
    pkts = client.get(f"/api/incidents/{inc}/packets", headers=_owner_headers()).json()
    assert pkts, "expected at least one packet for the incident"
    return pkts[0]["id"]


# ── POST /venues/{id}/incidents ──────────────────────────────────────────

def test_create_incident_denies_anonymous(client):
    assert client.post(f"/api/venues/{VENUE}/incidents", json=_INCIDENT).status_code == 401


def test_create_incident_denies_cross_tenant(client):
    r = client.post(f"/api/venues/{VENUE}/incidents", json=_INCIDENT, headers=_other_headers())
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "venue_access_denied"


def test_create_incident_allows_owner(client):
    assert client.post(f"/api/venues/{VENUE}/incidents", json=_INCIDENT, headers=_owner_headers()).status_code == 201


def test_create_incident_allows_broker(client):
    assert client.post(f"/api/venues/{VENUE}/incidents", json=_INCIDENT, headers=_broker_headers()).status_code == 201


# ── POST /incidents/{id}/evidence ────────────────────────────────────────

def test_evidence_denies_anonymous(client):
    inc = _create_incident(client, _owner_headers())
    assert client.post(f"/api/incidents/{inc}/evidence", files=_evidence_file()).status_code == 401


def test_evidence_denies_cross_tenant(client):
    inc = _create_incident(client, _owner_headers())
    r = client.post(f"/api/incidents/{inc}/evidence", files=_evidence_file(), headers=_other_headers())
    assert r.status_code == 403


def test_evidence_allows_owner(client):
    inc = _create_incident(client, _owner_headers())
    r = client.post(f"/api/incidents/{inc}/evidence", files=_evidence_file(), headers=_owner_headers())
    assert r.status_code == 201


def test_evidence_unknown_incident_is_404_even_without_token(client):
    # Entity 404 precedes the auth gate (matches GET /incidents/{id}).
    assert client.post("/api/incidents/inc-nope/evidence", files=_evidence_file()).status_code == 404


def test_evidence_append_blocked_on_archived(client):
    """POST evidence to a closed_archived incident must return 409 Conflict."""
    session = next(get_session())
    try:
        if not session.get(IncidentRecord, "in-arch"):
            session.add(IncidentRecord(
                id="in-arch", venue_id=VENUE,
                occurred_at="2026-01-01T00:00:00Z", location="bar",
                summary="archived fixture", reported_by="shift-lead",
                injury_observed=False, police_called=False, ems_called=False,
                status="closed_archived",
            ))
            session.commit()
    finally:
        session.close()

    r = client.post(
        "/api/incidents/in-arch/evidence",
        files=_evidence_file(),
        headers=_owner_headers(),
    )
    assert r.status_code == 409, r.text

    # cleanup
    session2 = next(get_session())
    row = session2.get(IncidentRecord, "in-arch")
    if row:
        session2.delete(row)
    session2.commit()
    session2.close()


# ── POST /venues/{id}/compliance/{item}/upload ───────────────────────────

# Probe a bogus item id: the gate fires before any item lookup, so denials are
# deterministic; for the owner, a non-existent signal row skips the resolve
# transition and returns 200 — independent of mutable seed-item state.
_ITEM = "gate-probe-item"


def test_compliance_upload_denies_anonymous(client):
    assert client.post(f"/api/venues/{VENUE}/compliance/{_ITEM}/upload", files=_evidence_file()).status_code == 401


def test_compliance_upload_denies_cross_tenant(client):
    r = client.post(f"/api/venues/{VENUE}/compliance/{_ITEM}/upload", files=_evidence_file(), headers=_other_headers())
    assert r.status_code == 403


def test_compliance_upload_allows_owner(client):
    r = client.post(f"/api/venues/{VENUE}/compliance/{_ITEM}/upload", files=_evidence_file(), headers=_owner_headers())
    assert r.status_code not in (401, 403)


# ── POST /packets/{id}/claim-proposal ────────────────────────────────────

_PROP_BODY = {"operator_id": "op-gate", "override_recommendation": False}


def test_claim_proposal_denies_anonymous(client):
    pk = _make_packet(client)
    assert client.post(f"/api/packets/{pk}/claim-proposal", json=_PROP_BODY).status_code == 401


def test_claim_proposal_denies_cross_tenant(client):
    pk = _make_packet(client)
    r = client.post(f"/api/packets/{pk}/claim-proposal", json=_PROP_BODY, headers=_other_headers())
    assert r.status_code == 403


def test_claim_proposal_allows_owner(client):
    pk = _make_packet(client)
    r = client.post(f"/api/packets/{pk}/claim-proposal", json=_PROP_BODY, headers=_owner_headers())
    assert r.status_code == 201


# ── POST /claim-proposals/{id}/operator-response ─────────────────────────

def test_operator_response_denies_anonymous(client):
    pk = _make_packet(client)
    prop = client.post(f"/api/packets/{pk}/claim-proposal", json=_PROP_BODY, headers=_owner_headers()).json()
    r = client.post(
        f"/api/claim-proposals/{prop['id']}/operator-response",
        json={"operator_id": "op-gate", "response_note": "more info"},
    )
    assert r.status_code == 401
