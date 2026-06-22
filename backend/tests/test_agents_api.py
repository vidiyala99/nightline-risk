from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import AgentRun

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


@pytest.fixture
def seeded_client(tmp_path, monkeypatch):
    # Isolated engine (mirrors tests/test_ingestion_runs_api.py): seed one AgentRun
    # through the SAME session the app reads, so the populated-payload path actually
    # executes — and the row stays out of the shared test_run.db (auto-cleaned).
    # File-based (not :memory:) so every connection sees the same tables/rows.
    engine = create_engine(
        f"sqlite:///{tmp_path / 'agents_api.db'}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as s:
        s.add(
            AgentRun(
                id="arun-agt-test", agent_name="risk_evaluator_agent",
                agent_kind="pipeline", contract_version="v1", provider="groq",
                model="m", input_hash="h", entity_type="incident",
                entity_id="inc-agt-test", status="succeeded", outcome="success",
                auto_completed=True, cost_usd=Decimal("0.000400"),
            )
        )
        s.commit()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_runs_returns_populated_payload_with_full_precision_cost(seeded_client):
    resp = seeded_client.get("/api/agents/runs", headers=BROKER_HEADERS)
    assert resp.status_code == 200, resp.text
    runs = resp.json()["runs"]
    run = next(r for r in runs if r["id"] == "arun-agt-test")
    # Native 6dp precision survives — sub-cent cost is NOT truncated to "0.00".
    assert run["cost_usd"] == "0.000400"
    assert run["cost_usd"] != "0.00"
    # Internal fingerprints never leave the API.
    assert "input_hash" not in run and "snapshot_hash" not in run
