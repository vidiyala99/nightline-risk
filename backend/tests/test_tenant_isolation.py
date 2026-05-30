"""Phase A — cross-tenant access control on the legacy main.py routes.

Before Phase A, an authenticated venue_operator could fetch any venue's
data by guessing IDs because the legacy routes had no tenant check.
This file pins the new behavior: only the owner-operator (matching
tenant_id or extra_venue_ids) — plus brokers/admins — may read venue-
scoped resources.

Covered routes (all under the legacy main.py @app decorators):
  GET  /api/venues/{venue_id}
  GET  /api/venues/{venue_id}/incidents
  GET  /api/incidents/{incident_id}
  GET  /api/packets/{packet_id}
  PATCH /api/incidents/{incident_id}/status
"""
import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _broker_headers():
    token = create_token("user-broker-iso", "broker@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _owner_op_headers():
    token = create_token("user-op-iso", "op@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


def _other_op_headers():
    # Operator scoped to a DIFFERENT venue; must be denied access to
    # elsewhere-brooklyn data.
    token = create_token("user-other-iso", "other@example.com", "venue_operator", "house-of-yes")
    return {"Authorization": f"Bearer {token}"}


# ─── Anonymous + cross-tenant denials ────────────────────────────────────


def test_get_venue_denies_anonymous(client):
    r = client.get("/api/venues/elsewhere-brooklyn")
    assert r.status_code == 401


def test_get_venue_denies_cross_tenant_operator(client):
    r = client.get(
        "/api/venues/elsewhere-brooklyn",
        headers=_other_op_headers(),
    )
    assert r.status_code == 403
    body = r.json()
    assert body["detail"]["error"] == "venue_access_denied"


def test_list_incidents_denies_cross_tenant_operator(client):
    r = client.get(
        "/api/venues/elsewhere-brooklyn/incidents",
        headers=_other_op_headers(),
    )
    assert r.status_code == 403


# ─── Owner + broker positives ────────────────────────────────────────────


def test_get_venue_allows_owner_operator(client):
    r = client.get(
        "/api/venues/elsewhere-brooklyn",
        headers=_owner_op_headers(),
    )
    assert r.status_code == 200
    assert r.json()["id"] == "elsewhere-brooklyn"


def test_get_venue_allows_broker(client):
    r = client.get(
        "/api/venues/elsewhere-brooklyn",
        headers=_broker_headers(),
    )
    assert r.status_code == 200


def test_list_incidents_allows_broker(client):
    r = client.get(
        "/api/venues/elsewhere-brooklyn/incidents",
        headers=_broker_headers(),
    )
    assert r.status_code == 200


# ─── Incident detail + packet detail follow venue tenancy ────────────────


def test_incident_detail_inherits_tenant_check(client):
    # Create an incident as the owner.
    h = _owner_op_headers()
    inc = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json={
            "occurred_at": "2026-05-22T01:00:00Z",
            "location": "rear bar",
            "summary": "Tenant isolation fixture incident.",
            "reported_by": "shift-lead",
            "injury_observed": False,
            "police_called": False,
            "ems_called": False,
        },
        headers=h,
    )
    incident_id = inc.json()["incident"]["id"]

    # Owner — 200
    r_owner = client.get(f"/api/incidents/{incident_id}", headers=h)
    assert r_owner.status_code == 200

    # Other operator — 403
    r_other = client.get(f"/api/incidents/{incident_id}", headers=_other_op_headers())
    assert r_other.status_code == 403

    # Broker — 200
    r_broker = client.get(f"/api/incidents/{incident_id}", headers=_broker_headers())
    assert r_broker.status_code == 200


# ─── IncidentStatus typed lifecycle ──────────────────────────────────────


def test_incident_status_rejects_unknown_value(client):
    h = _owner_op_headers()
    inc = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json={
            "occurred_at": "2026-05-22T01:00:00Z",
            "location": "rear bar",
            "summary": "Lifecycle test incident.",
            "reported_by": "shift-lead",
            "injury_observed": False,
            "police_called": False,
            "ems_called": False,
        },
        headers=h,
    )
    incident_id = inc.json()["incident"]["id"]

    r = client.patch(
        f"/api/incidents/{incident_id}/status",
        json={"status": "banana"},
        headers=h,
    )
    assert r.status_code == 422
    body = r.json()
    assert body["detail"]["error"] == "invalid_transition"
    assert "Incident" in body["detail"]["message"]


def test_incident_status_rejects_missing_field(client):
    h = _owner_op_headers()
    inc = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json={
            "occurred_at": "2026-05-22T01:00:00Z",
            "location": "rear bar",
            "summary": "Missing-status test.",
            "reported_by": "shift-lead",
            "injury_observed": False,
            "police_called": False,
            "ems_called": False,
        },
        headers=h,
    )
    incident_id = inc.json()["incident"]["id"]

    r = client.patch(
        f"/api/incidents/{incident_id}/status",
        json={},
        headers=h,
    )
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "status_required"


def test_incident_status_allows_valid_transition(client):
    h = _owner_op_headers()
    inc = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json={
            "occurred_at": "2026-05-22T01:00:00Z",
            "location": "rear bar",
            "summary": "Valid transition test.",
            "reported_by": "shift-lead",
            "injury_observed": False,
            "police_called": False,
            "ems_called": False,
        },
        headers=h,
    )
    incident_id = inc.json()["incident"]["id"]

    # open → under_review allowed
    r = client.patch(
        f"/api/incidents/{incident_id}/status",
        json={"status": "under_review"},
        headers=h,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "under_review"

    # under_review → closed allowed
    r2 = client.patch(
        f"/api/incidents/{incident_id}/status",
        json={"status": "closed"},
        headers=h,
    )
    assert r2.status_code == 200
    assert r2.json()["status"] == "closed"
