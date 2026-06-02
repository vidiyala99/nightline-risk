"""HTTP tests for the carrier underwriter desk (carrier persona, Phase 1).

  GET  /api/underwriting/queue            (carrier-only)
  POST /api/quotes/{qid}/underwrite       (carrier-only)

Asserts the role gate (broker/operator are NOT the carrier) and that a carrier
decision flows through to the quote.
"""
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.submissions import create_submission, submit_to_market

VENUE_ID = "elsewhere-brooklyn"


def _carrier_headers():
    return {"Authorization": f"Bearer {create_token('u-carrier', 'uw@nightline.risk', 'carrier', None)}"}


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk', 'broker@nightline.risk', 'broker', None)}"}


def _operator_headers():
    return {"Authorization": f"Bearer {create_token('u-op', 'op@nightline.risk', 'venue_operator', VENUE_ID)}"}


def _breakdown(total: str = "5894.84") -> dict:
    return {
        "lines": {
            "gl": {"base": "5500.00", "tier_multiplier": "0.7", "premium": "3850.00"},
            "liquor": {"base": "2500.00", "tier_multiplier": "0.7", "premium": "1750.00"},
        },
        "fees": {"policy_fee": "150.00", "surplus_lines_tax": "144.84"},
        "subtotal": "5600.00",
        "total": total,
        "commission_rate": "0.15",
    }


@pytest.fixture
def client_qid(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as s:
        s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
        seed_broker_platform_data(s)
        s.commit()
        sub = create_submission(
            s, venue_id=VENUE_ID, effective_date=date(2026, 11, 1),
            coverage_lines=["gl", "liquor"],
            requested_limits={"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
            actor_id="u-brk",
        )
        s.commit()
        result = submit_to_market(s, sub.id, target_carriers=["markel-specialty"], submitted_by="u-brk")
        s.commit()
        qid = result.quotes_created[0].id

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c, qid
    app.dependency_overrides.clear()


def test_carrier_quotes_a_submission(client_qid):
    client, qid = client_qid
    r = client.post(f"/api/quotes/{qid}/underwrite", headers=_carrier_headers(),
                    json={"decision": "quote", "premium_breakdown": _breakdown()})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "quoted"


def test_carrier_declines_a_submission(client_qid):
    client, qid = client_qid
    r = client.post(f"/api/quotes/{qid}/underwrite", headers=_carrier_headers(),
                    json={"decision": "decline", "decline_reason": "Outside capacity for late-night liquor."})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "declined"
    assert "capacity" in (body["decline_reason"] or "").lower()


def test_underwrite_rejects_broker_and_operator(client_qid):
    client, qid = client_qid
    for hdr in (_broker_headers(), _operator_headers()):
        r = client.post(f"/api/quotes/{qid}/underwrite", headers=hdr,
                        json={"decision": "quote", "premium_breakdown": _breakdown()})
        assert r.status_code == 403, r.text


def test_underwrite_requires_auth(client_qid):
    client, qid = client_qid
    r = client.post(f"/api/quotes/{qid}/underwrite", json={"decision": "quote"})
    assert r.status_code == 401


def test_bad_premium_math_422(client_qid):
    client, qid = client_qid
    r = client.post(f"/api/quotes/{qid}/underwrite", headers=_carrier_headers(),
                    json={"decision": "quote", "premium_breakdown": _breakdown(total="9999.99")})
    assert r.status_code == 422, r.text


def test_queue_is_carrier_only(client_qid):
    client, qid = client_qid
    ok = client.get("/api/underwriting/queue", headers=_carrier_headers())
    assert ok.status_code == 200
    assert any(row["quote_id"] == qid for row in ok.json())
    denied = client.get("/api/underwriting/queue", headers=_broker_headers())
    assert denied.status_code == 403
