"""HTTP tests for PATCH /api/auth/me and POST /api/auth/me/change-password."""
import pytest
from fastapi.testclient import TestClient

from app.auth import create_token, create_password_hash, verify_password
from app.database import get_session
from app.main import app
from app.models import UserRecord


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _seed_user(uid: str, email: str, *, name: str = "Test User", pw: str = "demo123", role: str = "broker"):
    session = next(get_session())
    try:
        rec = session.get(UserRecord, uid)
        if rec:
            rec.email = email
            rec.name = name
            rec.password_hash = create_password_hash(pw)
            rec.role = role
        else:
            rec = UserRecord(id=uid, email=email, password_hash=create_password_hash(pw), name=name, role=role)
            session.add(rec)
        session.commit()
    finally:
        session.close()


def _headers(uid: str, role: str = "broker"):
    return {"Authorization": f"Bearer {create_token(uid, 'token@x.com', role, None)}"}


# ── profile update ────────────────────────────────────────────────────────

def test_profile_update_requires_auth(client):
    assert client.patch("/api/auth/me", json={"name": "X"}).status_code == 401


def test_profile_update_name_and_strips_hash(client):
    _seed_user("u-prof-1", "prof1@x.com")
    r = client.patch("/api/auth/me", json={"name": "New Name"}, headers=_headers("u-prof-1"))
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "New Name"
    assert "password_hash" not in body


def test_profile_update_email_normalized(client):
    _seed_user("u-prof-email", "old@x.com")
    r = client.patch("/api/auth/me", json={"email": "New@Example.COM"}, headers=_headers("u-prof-email"))
    assert r.status_code == 200
    assert r.json()["email"] == "new@example.com"


def test_profile_update_rejects_invalid_email(client):
    _seed_user("u-prof-bad", "badcase@x.com")
    r = client.patch("/api/auth/me", json={"email": "not-an-email"}, headers=_headers("u-prof-bad"))
    assert r.status_code == 400


def test_profile_update_email_collision(client):
    _seed_user("u-prof-2", "prof2@x.com")
    _seed_user("u-prof-3", "taken@x.com")
    r = client.patch("/api/auth/me", json={"email": "taken@x.com"}, headers=_headers("u-prof-2"))
    assert r.status_code == 409


# ── change password ───────────────────────────────────────────────────────

def test_change_password_requires_auth(client):
    r = client.post("/api/auth/me/change-password", json={"old_password": "a", "new_password": "bbbbbb"})
    assert r.status_code == 401


def test_change_password_happy(client):
    _seed_user("u-pw-1", "pw1@x.com", pw="oldpass")
    r = client.post(
        "/api/auth/me/change-password",
        json={"old_password": "oldpass", "new_password": "newpass1"},
        headers=_headers("u-pw-1"),
    )
    assert r.status_code == 200
    assert r.json() == {"success": True}
    session = next(get_session())
    try:
        rec = session.get(UserRecord, "u-pw-1")
        assert verify_password("newpass1", rec.password_hash)
        assert not verify_password("oldpass", rec.password_hash)
    finally:
        session.close()


def test_change_password_wrong_old_rejected(client):
    _seed_user("u-pw-2", "pw2@x.com", pw="oldpass")
    r = client.post(
        "/api/auth/me/change-password",
        json={"old_password": "WRONG", "new_password": "newpass1"},
        headers=_headers("u-pw-2"),
    )
    assert r.status_code == 401


def test_change_password_too_short_rejected(client):
    _seed_user("u-pw-3", "pw3@x.com", pw="oldpass")
    r = client.post(
        "/api/auth/me/change-password",
        json={"old_password": "oldpass", "new_password": "x"},
        headers=_headers("u-pw-3"),
    )
    assert r.status_code == 400
