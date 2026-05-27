"""Tests for password-reset tokens + the forgot/reset endpoints."""
import time

import pytest
from fastapi.testclient import TestClient

from app.auth import (
    create_reset_token,
    create_token,
    verify_reset_token,
    verify_token,
    create_password_hash,
    verify_password,
)
from app.database import get_session
from app.main import app
from app.models import UserRecord


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _seed_user(uid: str, email: str, *, pw: str = "demo123", role: str = "venue_operator"):
    session = next(get_session())
    try:
        rec = session.get(UserRecord, uid)
        if rec:
            rec.email = email
            rec.password_hash = create_password_hash(pw)
        else:
            rec = UserRecord(id=uid, email=email, password_hash=create_password_hash(pw), name="Reset User", role=role)
            session.add(rec)
        session.commit()
    finally:
        session.close()


# ── token unit tests ───────────────────────────────────────────────────────

def test_reset_token_round_trip():
    token = create_reset_token("user-xyz")
    assert verify_reset_token(token) == "user-xyz"


def test_reset_token_expires(monkeypatch):
    token = create_reset_token("user-xyz")
    monkeypatch.setattr(time, "time", lambda: time.time() + 7200)  # +2h > 1h expiry
    assert verify_reset_token(token) is None


def test_session_token_is_not_a_valid_reset_token():
    session_token = create_token("user-xyz", "a@b.com", "broker", None)
    assert verify_reset_token(session_token) is None


def test_reset_token_is_not_a_valid_session_token():
    reset_token = create_reset_token("user-xyz")
    assert verify_token(reset_token) is None


# ── endpoint tests ───────────────────────────────────────────────────────────

def test_forgot_password_returns_200_for_unknown_email(client):
    r = client.post("/api/auth/forgot-password", json={"email": "nobody@nowhere.test"})
    assert r.status_code == 200  # no account-existence leak


def test_forgot_password_returns_200_for_known_email(client):
    _seed_user("u-forgot-1", "forgot1@x.com")
    r = client.post("/api/auth/forgot-password", json={"email": "forgot1@x.com"})
    assert r.status_code == 200


def test_reset_password_happy_path_then_login(client):
    _seed_user("u-reset-1", "reset1@x.com", pw="oldpass")
    token = create_reset_token("u-reset-1")

    r = client.post("/api/auth/reset-password", json={"token": token, "new_password": "brandnew1"})
    assert r.status_code == 200

    session = next(get_session())
    try:
        rec = session.get(UserRecord, "u-reset-1")
        assert verify_password("brandnew1", rec.password_hash)
    finally:
        session.close()

    # the new password works at login
    login = client.post("/api/auth/login", json={"email": "reset1@x.com", "password": "brandnew1"})
    assert login.status_code == 200


def test_reset_password_rejects_bad_token(client):
    r = client.post("/api/auth/reset-password", json={"token": "garbage.token", "new_password": "brandnew1"})
    assert r.status_code == 400


def test_reset_password_rejects_short_password(client):
    _seed_user("u-reset-2", "reset2@x.com")
    token = create_reset_token("u-reset-2")
    r = client.post("/api/auth/reset-password", json={"token": token, "new_password": "x"})
    assert r.status_code == 400
