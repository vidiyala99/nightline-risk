from __future__ import annotations

from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app

client = TestClient(app)

BROKER_HEADERS = {
    "Authorization": f"Bearer {create_token('u-agt-brk', 'agt-brk@nightline.risk', 'broker', None)}"
}


def test_runs_requires_auth():
    assert client.get("/api/agents/runs").status_code == 401


def test_rollup_requires_auth():
    assert client.get("/api/agents/rollup").status_code == 401


def test_runs_returns_shape_for_broker():
    resp = client.get("/api/agents/runs", headers=BROKER_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "runs" in body and isinstance(body["runs"], list)
    if body["runs"]:
        run = body["runs"][0]
        assert isinstance(run["cost_usd"], str)  # money is a string
        assert "input_hash" not in run and "snapshot_hash" not in run


def test_rollup_returns_shape_for_broker():
    resp = client.get("/api/agents/rollup", headers=BROKER_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["window"] == "7d"
    assert "agents" in body and isinstance(body["agents"], list)
    for row in body["agents"]:
        assert isinstance(row["total_cost_usd"], str)
        assert isinstance(row["fallback_rate"], str)
