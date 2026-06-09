import json

from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


def _op():
    return {"Authorization": f"Bearer {create_token('user_op','op@x.com','venue_operator','elsewhere-brooklyn')}"}


def _broker():
    return {"Authorization": f"Bearer {create_token('user_b','b@x.com','broker',None)}"}


def test_message_requires_auth():
    with TestClient(app) as c:
        assert c.post("/api/copilot/message", json={"message": "hi"}).status_code == 401


def test_broker_is_forbidden():
    with TestClient(app) as c:
        assert c.post("/api/copilot/message", json={"message": "hi"}, headers=_broker()).status_code == 403


def test_operator_can_ask():
    with TestClient(app) as c:
        r = c.post("/api/copilot/message", json={"message": "what needs my attention?"}, headers=_op())
        assert r.status_code == 200
        assert r.json()["answer_type"] in ("answer", "refuse", "clarify")


def test_confirm_route_parses_multipart_and_returns_200():
    action = {
        "kind": "resolve_compliance",
        "target_id": "nonexistent-item",
        "summary": "resolve unknown compliance item",
        "gating_passed": True,
        "requires_attachment": True,
    }
    with TestClient(app) as c:
        r = c.post(
            "/api/copilot/message/confirm",
            data={"confirm_action": json.dumps(action)},
            files={"file": ("evidence.pdf", b"%PDF-1.4 fake", "application/pdf")},
            headers=_op(),
        )
        assert r.status_code == 200
        assert r.json()["answer_type"] in ("answer", "refuse", "clarify")
