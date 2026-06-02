"""HTTP integration tests for the carrier adjuster desk (Phase 2).

  GET  /api/adjusting/queue                  (carrier-only)
  GET  /api/adjusting/claims/{cid}           (carrier-only)
  POST /api/adjusting/claims/{cid}/decide-coverage
  POST /api/adjusting/claims/{cid}/reserve
  POST /api/adjusting/claims/{cid}/payment
  POST /api/adjusting/claims/{cid}/close

All routes are carrier-gated; broker and unauthenticated requests are rejected.
"""
from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.claims import file_fnol

VENUE_ID = "elsewhere-brooklyn"


def _carrier_headers():
    return {"Authorization": f"Bearer {create_token('u-adj', 'adj@nightline.risk', 'carrier', None)}"}


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk', 'brk@nightline.risk', 'broker', None)}"}


@pytest.fixture
def client_claim(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 't.db'}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)

    with Session(engine) as s:
        s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
        seed_broker_platform_data(s)
        s.commit()

        pol = Policy(
            id="pol-adj-test",
            policy_number="POL-ADJ-001",
            submission_id="sub-adj-test",
            bound_quote_id="q-adj-test",
            venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            status="active",
            effective_date=date(2026, 1, 1),
            expiration_date=date(2027, 1, 1),
            annual_premium=Decimal("5000.00"),
            commission_amount=Decimal("750.00"),
            commission_rate=Decimal("0.15"),
            coverage_lines=["gl"],
            terms_snapshot={},
            snapshot_hash="hash-adj",
        )
        s.add(pol)
        s.commit()

        claim = file_fnol(
            s,
            policy_id="pol-adj-test",
            coverage_line="gl",
            date_of_loss=date(2026, 3, 1),
            filed_by="u-brk",
        )
        s.commit()
        cid = claim.id

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c, cid
    app.dependency_overrides.clear()


# ─── Role gating ────────────────────────────────────────────────────────────


def test_decide_coverage_carrier_only(client_claim):
    client, cid = client_claim
    r = client.post(
        f"/api/adjusting/claims/{cid}/decide-coverage",
        headers=_carrier_headers(),
        json={"decision": "covered", "rationale": "policy responds"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["coverage_decision"] == "covered"

    denied = client.post(
        f"/api/adjusting/claims/{cid}/decide-coverage",
        headers=_broker_headers(),
        json={"decision": "covered", "rationale": "x"},
    )
    assert denied.status_code == 403


def test_adjuster_queue_carrier_only(client_claim):
    client, cid = client_claim
    ok = client.get("/api/adjusting/queue", headers=_carrier_headers())
    assert ok.status_code == 200
    assert any(row["claim_id"] == cid for row in ok.json())
    assert client.get("/api/adjusting/queue", headers=_broker_headers()).status_code == 403


def test_indemnity_gate_returns_400(client_claim):
    client, cid = client_claim
    client.post(
        f"/api/adjusting/claims/{cid}/reserve",
        headers=_carrier_headers(),
        json={"new_reserve": "5000", "change_reason": "init"},
    )
    r = client.post(
        f"/api/adjusting/claims/{cid}/payment",
        headers=_carrier_headers(),
        json={
            "amount": "1000",
            "payment_type": "indemnity",
            "paid_on": "2026-06-02",
            "description": "x",
        },
    )
    assert r.status_code == 400, r.text


# ─── Happy paths ─────────────────────────────────────────────────────────────


def test_adjuster_claim_dossier(client_claim):
    client, cid = client_claim
    r = client.get(f"/api/adjusting/claims/{cid}", headers=_carrier_headers())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["claim"]["id"] == cid
    assert "payments" in body
    assert "reserve_history" in body


def test_reserve_then_payment_after_coverage(client_claim):
    client, cid = client_claim
    # Set coverage first.
    client.post(
        f"/api/adjusting/claims/{cid}/decide-coverage",
        headers=_carrier_headers(),
        json={"decision": "covered", "rationale": "policy responds"},
    )
    # Set a reserve.
    rr = client.post(
        f"/api/adjusting/claims/{cid}/reserve",
        headers=_carrier_headers(),
        json={"new_reserve": "10000", "change_reason": "initial estimate"},
    )
    assert rr.status_code == 200, rr.text

    # Approve an indemnity payment.
    pr = client.post(
        f"/api/adjusting/claims/{cid}/payment",
        headers=_carrier_headers(),
        json={
            "amount": "2500",
            "payment_type": "indemnity",
            "paid_on": "2026-06-02",
            "description": "partial settlement",
        },
    )
    assert pr.status_code == 200, pr.text
    assert Decimal(pr.json()["indemnity_paid_to_date"]) == Decimal("2500")


def test_close_claim_as_carrier(client_claim):
    client, cid = client_claim
    # Need a reserve before closing.
    client.post(
        f"/api/adjusting/claims/{cid}/reserve",
        headers=_carrier_headers(),
        json={"new_reserve": "500", "change_reason": "setup"},
    )
    r = client.post(
        f"/api/adjusting/claims/{cid}/close",
        headers=_carrier_headers(),
        json={"disposition": "denied"},
    )
    assert r.status_code == 200, r.text
    assert "closed" in r.json()["status"]
