"""Broker waiver: PATCH /api/venues/{id}/compliance/{item}/resolve."""
from fastapi.testclient import TestClient
from app.main import app
from app.auth import create_token

VENUE = "elsewhere-brooklyn"


def _broker():
    return {"Authorization": f"Bearer {create_token('u-broker', 'b@x.com', 'broker', 'tenant-1')}"}


def _operator():
    return {"Authorization": f"Bearer {create_token('u-op', 'o@x.com', 'venue_operator', VENUE)}"}


def _first_item_id(client) -> str:
    live = client.get(f"/api/venues/{VENUE}/live", headers=_broker()).json()
    queue = live.get("compliance_queue") or []
    assert queue, "expected seeded compliance items for elsewhere-brooklyn"
    return queue[0]["id"]


def test_broker_can_resolve_and_item_disappears():
    with TestClient(app) as client:
        item_id = _first_item_id(client)
        resp = client.patch(
            f"/api/venues/{VENUE}/compliance/{item_id}/resolve",
            headers=_broker(),
            json={"reason": "Reviewed off-platform; waiving."},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "resolved", "item_id": item_id}

        live = client.get(f"/api/venues/{VENUE}/live", headers=_broker()).json()
        remaining = {i["id"] for i in (live.get("compliance_queue") or [])}
        assert item_id not in remaining


def test_resolve_unknown_item_404():
    with TestClient(app) as client:
        resp = client.patch(
            f"/api/venues/{VENUE}/compliance/NOPE_DOES_NOT_EXIST/resolve",
            headers=_broker(),
            json={},
        )
        assert resp.status_code == 404


def test_operator_cannot_resolve():
    with TestClient(app) as client:
        item_id = _first_item_id(client)
        resp = client.patch(
            f"/api/venues/{VENUE}/compliance/{item_id}/resolve",
            headers=_operator(),
        )
        assert resp.status_code == 403


def test_anonymous_cannot_resolve():
    with TestClient(app) as client:
        resp = client.patch(f"/api/venues/{VENUE}/compliance/COMP_CAMERA_REAR_001/resolve")
        assert resp.status_code == 401
