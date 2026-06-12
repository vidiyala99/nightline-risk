"""GET /api/certificate-holders — prior holders for COI auto-fill, broker-gated."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import CertificateOfInsurance, Policy, Venue


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path/'coi.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as s:
        s.add(Venue(id="v1", name="V"))
        s.add(Policy(
            id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id="v1",
            carrier_id="c1", status="active", effective_date=date(2026, 1, 1),
            expiration_date=date(2027, 1, 1), annual_premium=Decimal("0"),
            commission_amount=Decimal("0"), commission_rate=Decimal("0"), coverage_lines=["gl"],
        ))
        def _coi(cid, holder, addr, issued):
            s.add(CertificateOfInsurance(
                id=cid, policy_id="pol-1", certificate_holder=holder,
                certificate_holder_address=addr, description_of_operations="ops",
                status="active", expires_on=date(2027, 1, 1),
                issued_at=datetime(*issued, tzinfo=timezone.utc), issued_by="b1",
            ))
        _coi("c1", "Acme LLC", "1 Old St", (2026, 1, 1))
        _coi("c2", "ACME, LLC", "2 New St", (2026, 4, 1))   # same holder, newer
        _coi("c3", "Beacon Co", "9 Bee Rd", (2026, 2, 1))
        s.commit()

    def override():
        with Session(engine) as session:
            yield session
    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _broker():
    return {"Authorization": f"Bearer {create_token('b1', 'b@x.com', 'broker', 't1')}"}


def test_lists_deduped_holders_with_prefill(client):
    res = client.get("/api/certificate-holders", headers=_broker())
    assert res.status_code == 200, res.text
    rows = res.json()
    assert len(rows) == 2                      # Acme group + Beacon
    acme = next(r for r in rows if r["certificate_holder"] == "ACME, LLC")
    assert acme["times_used"] == 2
    assert acme["certificate_holder_address"] == "2 New St"   # newest detail
    assert rows[0]["certificate_holder"] == "ACME, LLC"       # most-used first


def test_requires_broker(client):
    res = client.get(
        "/api/certificate-holders",
        headers={"Authorization": f"Bearer {create_token('op', 'o@x.com', 'venue_operator', 'v1')}"},
    )
    assert res.status_code == 403
