"""E — new-operator first-run: creating a venue seeds one starter compliance item.

A brand-new operator's compliance queue would otherwise be empty, so the loop
isn't demonstrable. POST /venues now seeds ONE clearly-labeled `starter_seed`
item ("upload your policy"). It MUST NOT dent the new venue's A-tier score, so
it's excluded from the compliance factor (the fusion engine fails loud on an
unknown provenance, so a non-excluded starter would 500 the risk-score read).
"""
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select

from app.auth import create_token
from app.main import app
from app.models import ComplianceSignal
from app.services.compliance_signals import seed_starter_compliance_item


def _op(tenant):
    return {"Authorization": f"Bearer {create_token('u-onb', 'o@e.com', 'venue_operator', tenant)}"}


def _broker():
    return {"Authorization": f"Bearer {create_token('u-onb-b', 'b@e.com', 'broker', None)}"}


def test_create_venue_seeds_one_starter_compliance_item():
    vid = "onboard-test-venue"
    with TestClient(app) as client:
        r = client.post("/api/venues", json={"id": vid, "name": "Onboard Test Venue", "capacity": 300}, headers=_op(vid))
        assert r.status_code == 201, r.text
        live = client.get(f"/api/venues/{vid}/live", headers=_broker()).json()
    starters = [c for c in live["compliance_queue"] if c["id"] == f"STARTER_{vid}"]
    assert len(starters) == 1


def test_starter_seed_is_idempotent():
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    seed_starter_compliance_item(s, "v1")
    s.commit()
    seed_starter_compliance_item(s, "v1")
    s.commit()
    rows = s.exec(select(ComplianceSignal).where(ComplianceSignal.venue_id == "v1")).all()
    assert len(rows) == 1
    assert rows[0].provenance == "starter_seed"
    assert rows[0].id == "STARTER_v1"


def test_starter_item_excluded_from_compliance_factor():
    vid = "onboard-score-venue"
    with TestClient(app) as client:
        client.post("/api/venues", json={"id": vid, "name": "Onboard Score", "capacity": 300}, headers=_op(vid))
        score = client.get(f"/api/venues/{vid}/risk-score", headers=_broker()).json()
    # starter_seed is excluded from the compliance signals -> no load -> factor 100.
    # (If not excluded, fuse() KeyErrors on the unknown provenance and this 500s.)
    assert score["factors"]["compliance"]["score"] == 100
