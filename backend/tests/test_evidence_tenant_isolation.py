"""Cross-tenant access control on the evidence read routes + the cross-venue
incident list.

Before this fix, the evidence read endpoints took only an ``incident_id`` /
``evidence_id`` plus a DB session — no auth gate at all. Any authenticated
operator (or an anonymous caller) who knew or guessed an id could read another
venue's evidence metadata, vision-analysis findings, and the raw file bytes
(injury photos, police reports). The bare ``GET /api/incidents`` list likewise
returned every venue's incidents to anyone.

This file pins the corrected behavior: only the owner-operator (matching
tenant_id / extra_venue_ids) — plus brokers/admins — may read these resources;
anonymous callers get 401, cross-tenant operators get 403.

Covered routes:
  GET /api/incidents/{incident_id}/evidence
  GET /api/incidents/{incident_id}/evidence-analysis
  GET /api/evidence/{evidence_id}/file
  GET /api/incidents                      (role-aware scoping)
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
    token = create_token("user-broker-ev", "broker@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _owner_op_headers():
    token = create_token("user-op-ev", "op@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


def _other_op_headers():
    # Operator scoped to a DIFFERENT venue; must be denied elsewhere-brooklyn data.
    token = create_token("user-other-ev", "other@example.com", "venue_operator", "house-of-yes")
    return {"Authorization": f"Bearer {token}"}


def _make_incident_with_evidence(client) -> tuple[str, str]:
    """Owner files an incident in elsewhere-brooklyn and attaches one text file.

    Returns ``(incident_id, evidence_id)``. A ``text/plain`` upload avoids the
    image/video vision background task. ``occurred_at`` is far-future so the row
    sorts to the top of the ``occurred_at desc limit 100`` list — that way the
    operator-scoping test proves a row that *would* be in-window is actively
    hidden, not merely buried past the limit.
    """
    h = _owner_op_headers()
    inc = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json={
            "occurred_at": "2099-01-01T01:00:00Z",
            "location": "rear bar",
            "summary": "Evidence isolation fixture incident.",
            "reported_by": "shift-lead",
            "injury_observed": False,
            "police_called": False,
            "ems_called": False,
        },
        headers=h,
    )
    incident_id = inc.json()["incident"]["id"]
    up = client.post(
        f"/api/incidents/{incident_id}/evidence",
        files={"file": ("note.txt", b"sensitive evidence bytes", "text/plain")},
        headers=h,
    )
    assert up.status_code == 201, up.text
    return incident_id, up.json()["id"]


# ─── list_evidence ───────────────────────────────────────────────────────


def test_list_evidence_denies_anonymous(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get(f"/api/incidents/{incident_id}/evidence")
    assert r.status_code == 401


def test_list_evidence_denies_cross_tenant_operator(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get(f"/api/incidents/{incident_id}/evidence", headers=_other_op_headers())
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "venue_access_denied"


def test_list_evidence_allows_owner(client):
    incident_id, evidence_id = _make_incident_with_evidence(client)
    r = client.get(f"/api/incidents/{incident_id}/evidence", headers=_owner_op_headers())
    assert r.status_code == 200
    assert any(f["id"] == evidence_id for f in r.json())


def test_list_evidence_allows_broker(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get(f"/api/incidents/{incident_id}/evidence", headers=_broker_headers())
    assert r.status_code == 200


# ─── evidence-analysis ───────────────────────────────────────────────────


def test_evidence_analysis_denies_anonymous(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get(f"/api/incidents/{incident_id}/evidence-analysis")
    assert r.status_code == 401


def test_evidence_analysis_denies_cross_tenant_operator(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get(
        f"/api/incidents/{incident_id}/evidence-analysis", headers=_other_op_headers()
    )
    assert r.status_code == 403


def test_evidence_analysis_allows_owner(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get(
        f"/api/incidents/{incident_id}/evidence-analysis", headers=_owner_op_headers()
    )
    assert r.status_code == 200


# ─── serve_evidence (raw file bytes) ─────────────────────────────────────


def test_serve_evidence_denies_anonymous(client):
    _, evidence_id = _make_incident_with_evidence(client)
    r = client.get(f"/api/evidence/{evidence_id}/file")
    assert r.status_code == 401


def test_serve_evidence_denies_cross_tenant_operator(client):
    _, evidence_id = _make_incident_with_evidence(client)
    r = client.get(f"/api/evidence/{evidence_id}/file", headers=_other_op_headers())
    assert r.status_code == 403


def test_serve_evidence_allows_owner(client):
    _, evidence_id = _make_incident_with_evidence(client)
    r = client.get(f"/api/evidence/{evidence_id}/file", headers=_owner_op_headers())
    assert r.status_code == 200
    assert r.content == b"sensitive evidence bytes"


# ─── cross-venue incident list scoping ───────────────────────────────────


def test_incidents_list_denies_anonymous(client):
    r = client.get("/api/incidents")
    assert r.status_code == 401


def test_incidents_list_hides_cross_tenant_rows_from_operator(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get("/api/incidents", headers=_other_op_headers())
    assert r.status_code == 200
    assert all(row["id"] != incident_id for row in r.json())


def test_incidents_list_shows_all_rows_to_broker(client):
    incident_id, _ = _make_incident_with_evidence(client)
    r = client.get("/api/incidents", headers=_broker_headers())
    assert r.status_code == 200
    assert any(row["id"] == incident_id for row in r.json())
