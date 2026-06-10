"""Staff tier — floor employees who log in (role="staff") to report incidents.

Covers provisioning (operator creates a venue-scoped staff login), and the
least-privilege gate: staff may file an incident for THEIR OWN venue (attributed
to them) and read their own via /api/incidents/mine, but are denied other
venues and the operator venue-CRUD surfaces.
"""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.services.staff import StaffError, create_staff_account, list_staff
from factories import ensure_user


# --- service layer (in-memory, isolated) ------------------------------------

def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_create_staff_account_is_scoped_and_unique():
    s = _session()
    user, token = create_staff_account(s, venue_id="v1", name="Dana", email="Dana@Example.com")
    s.commit()
    assert user.role == "staff"
    assert user.tenant_id == "v1"
    assert user.email == "dana@example.com"  # normalized
    assert token  # set-password token issued
    with pytest.raises(StaffError):
        create_staff_account(s, venue_id="v1", name="Dupe", email="dana@example.com")


def test_list_staff_scopes_to_venue():
    s = _session()
    create_staff_account(s, venue_id="vA", name="A1", email="a1@x.com")
    create_staff_account(s, venue_id="vA", name="A2", email="a2@x.com")
    create_staff_account(s, venue_id="vB", name="B1", email="b1@x.com")
    s.commit()
    assert len(list_staff(s, "vA")) == 2
    assert len(list_staff(s, "vB")) == 1


# --- API + auth layer -------------------------------------------------------

@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk-staff', 'b@x.com', 'broker', None)}"}


def _staff_token(venue_id: str) -> tuple[str, dict]:
    """A minted staff token for a venue. Unique user id per call so /mine results
    don't leak across runs in the shared DB. Also persists the backing UserRecord
    so incidents filed under this staff_id satisfy the reported_by_staff_id FK
    (Postgres enforces it; SQLite silently tolerated a dangling ref)."""
    uid = f"staff-{uuid4().hex[:8]}"
    sess = next(get_session())
    try:
        ensure_user(sess, uid, email=f"{uid}@x.com", name="Staff", role="staff")
        sess.commit()
    finally:
        sess.close()
    return uid, {"Authorization": f"Bearer {create_token(uid, f'{uid}@x.com', 'staff', venue_id)}"}


def _email() -> str:
    return f"staff-{uuid4().hex[:8]}@example.com"


def _incident_payload(summary: str) -> dict:
    return {
        # A past date on purpose: a far-future date would sort to the top of the
        # broker's `occurred_at desc limit 100` list and crowd out other tests'
        # fixtures (test_evidence_tenant_isolation relies on that ordering).
        "occurred_at": "2026-02-02T03:00:00Z",
        "location": "dance floor",
        "summary": summary,
        "reported_by": "Dana",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    }


def test_provision_requires_auth(client):
    r = client.post("/api/venues/elsewhere-brooklyn/staff", json={"name": "Dana", "email": _email()})
    assert r.status_code == 401


def test_broker_provisions_staff(client):
    email = _email()
    r = client.post(
        "/api/venues/elsewhere-brooklyn/staff",
        json={"name": "Dana", "email": email},
        headers=_broker_headers(),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["role"] == "staff"
    assert body["venue_id"] == "elsewhere-brooklyn"
    assert body["email"] == email.lower()
    assert body["set_password_token"]


def test_staff_reports_own_venue_and_sees_it_in_mine(client):
    uid, h = _staff_token("elsewhere-brooklyn")
    r = client.post(
        "/api/venues/elsewhere-brooklyn/incidents",
        json=_incident_payload("Staff-filed test incident at the door."),
        headers=h,
    )
    assert r.status_code == 201, r.text
    inc_id = r.json()["incident"]["id"]

    mine = client.get("/api/incidents/mine", headers=h)
    assert mine.status_code == 200, mine.text
    rows = mine.json()
    assert any(row["id"] == inc_id for row in rows)
    assert all(row["reported_by_staff_id"] == uid for row in rows)


def test_staff_cannot_report_other_venue(client):
    _, h = _staff_token("elsewhere-brooklyn")
    r = client.post(
        "/api/venues/house-of-yes/incidents",
        json=_incident_payload("should be blocked"),
        headers=h,
    )
    assert r.status_code == 403


def test_staff_denied_operator_venue_incident_list(client):
    # Least privilege: staff use /incidents/mine, not the venue CRUD list.
    _, h = _staff_token("elsewhere-brooklyn")
    r = client.get("/api/venues/elsewhere-brooklyn/incidents", headers=h)
    assert r.status_code == 403


def test_mine_requires_staff_role(client):
    # A broker hitting the staff-only endpoint is rejected.
    r = client.get("/api/incidents/mine", headers=_broker_headers())
    assert r.status_code == 403
