"""Regression: public /api/auth/register must NOT honor a client-supplied role.

Before the fix, `RegisterRequest.role` was client-controlled and passed straight
into `register_user`, so anyone could POST {"role": "carrier"} and mint a token
that satisfied every `require_carrier`/`require_broker` gate. Public registration
must always produce a `venue_operator`; privileged roles come only from an authed
admin/seed path.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.auth import verify_token
from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _unique_email() -> str:
    return f"reg-{uuid.uuid4().hex[:12]}@example.com"


@pytest.mark.parametrize("attempted_role", ["carrier", "broker", "admin", "staff"])
def test_register_ignores_client_supplied_privileged_role(client, attempted_role):
    email = _unique_email()
    res = client.post(
        "/api/auth/register",
        json={"email": email, "password": "demo123", "name": "Mallory", "role": attempted_role},
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # The returned user record must be a venue_operator, never the attempted role.
    assert body["user"]["role"] == "venue_operator"

    # And the minted token must NOT carry the escalated role — this is what every
    # require_* gate reads.
    decoded = verify_token(body["access_token"])
    assert decoded is not None
    assert decoded["role"] == "venue_operator"


def test_register_default_is_venue_operator(client):
    email = _unique_email()
    res = client.post(
        "/api/auth/register",
        json={"email": email, "password": "demo123", "name": "Honest User"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["user"]["role"] == "venue_operator"
