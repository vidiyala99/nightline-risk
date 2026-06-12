"""Coverage-advice API — broker records, acknowledges, and actions the
clause-cited E&O advice trail. Mirrors the policy_requests router conventions
(broker-gated; CoverageAdviceError → 400/404, InvalidTransitionError → 422)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, Venue


@pytest.fixture
def client_and_engine(tmp_path, monkeypatch):
    db_path = tmp_path / "test_cov_advice.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as boot:
        boot.add(Venue(id="v1", name="Test Venue"))
        boot.add(Policy(
            id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id="v1",
            carrier_id="c1", status="active",
            effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
            annual_premium=Decimal("0"), commission_amount=Decimal("0"),
            commission_rate=Decimal("0"), coverage_lines=["gl"],
        ))
        boot.commit()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _broker():
    return {"Authorization": f"Bearer {create_token('user-broker-1', 'b@x.com', 'broker', 't1')}"}


def _operator():
    return {"Authorization": f"Bearer {create_token('op-1', 'o@x.com', 'venue_operator', 'v1')}"}


def _body(**over):
    b = {
        "venue_id": "v1", "policy_id": "pol-1", "kind": "exclusion_review",
        "summary": "A&B excluded but it's the venue's #1 loss.",
        "cited_node_ids": ["node-ab"], "loss_category": "assault_battery",
    }
    b.update(over)
    return b


def test_record_returns_surfaced_item(client_and_engine):
    c = client_and_engine
    res = c.post("/api/coverage-advice", json=_body(), headers=_broker())
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["id"].startswith("covadvice-")
    assert body["status"] == "surfaced"
    assert body["kind"] == "exclusion_review"


def test_record_is_idempotent(client_and_engine):
    c = client_and_engine
    a = c.post("/api/coverage-advice", json=_body(), headers=_broker()).json()
    b = c.post("/api/coverage-advice", json=_body(), headers=_broker()).json()
    assert a["id"] == b["id"]


def test_record_requires_broker(client_and_engine):
    c = client_and_engine
    res = c.post("/api/coverage-advice", json=_body(), headers=_operator())
    assert res.status_code == 403


def test_unknown_kind_is_400(client_and_engine):
    c = client_and_engine
    res = c.post("/api/coverage-advice", json=_body(kind="bogus"), headers=_broker())
    assert res.status_code == 400


def test_missing_policy_is_404(client_and_engine):
    c = client_and_engine
    res = c.post("/api/coverage-advice", json=_body(policy_id="nope"), headers=_broker())
    assert res.status_code == 404


def test_acknowledge_transition(client_and_engine):
    c = client_and_engine
    rec = c.post("/api/coverage-advice", json=_body(), headers=_broker()).json()
    res = c.post(f"/api/coverage-advice/{rec['id']}/transition",
                 json={"to": "acknowledged"}, headers=_broker())
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "acknowledged"


def test_illegal_transition_is_422(client_and_engine):
    c = client_and_engine
    rec = c.post("/api/coverage-advice", json=_body(), headers=_broker()).json()
    res = c.post(f"/api/coverage-advice/{rec['id']}/transition",
                 json={"to": "actioned"}, headers=_broker())
    assert res.status_code == 422


def test_list_for_venue(client_and_engine):
    c = client_and_engine
    c.post("/api/coverage-advice", json=_body(), headers=_broker())
    res = c.get("/api/venues/v1/coverage-advice", headers=_broker())
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    assert rows[0]["policy_id"] == "pol-1"
