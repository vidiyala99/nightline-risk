"""API: GET /api/coverage-lines catalog + coverage-profile capture on PATCH venue."""
import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _op():
    token = create_token("u-cp", "cp@x.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


def test_coverage_lines_catalog_endpoint(client):
    r = client.get("/api/coverage-lines")
    assert r.status_code == 200
    ids = {l["id"] for l in r.json()}
    assert {"gl", "liquor", "assault_battery"} <= ids
    gl = next(l for l in r.json() if l["id"] == "gl")
    assert gl["name"] and "is_required_by_default" in gl


def test_patch_venue_sets_coverage_profile(client):
    r = client.patch("/api/venues/elsewhere-brooklyn", json={
        "current_carrier": "Hiscox", "renewal_date": "2026-09-01",
        "coverage_interest": ["gl", "liquor"],
    }, headers=_op())
    assert r.status_code == 200, r.text
    assert r.json()["onboarding_complete"] is True
    g = client.get("/api/venues/elsewhere-brooklyn", headers=_op())
    assert g.json()["current_carrier"] == "Hiscox"


def test_patch_venue_rejects_unknown_coverage_line(client):
    r = client.patch("/api/venues/elsewhere-brooklyn", json={
        "current_carrier": "Hiscox", "renewal_date": "2026-09-01",
        "coverage_interest": ["gl", "bogus"],
    }, headers=_op())
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "invalid_coverage_line"


def test_patch_venue_real_carrier_requires_renewal(client):
    # Order-independence: a sibling test persists a renewal_date on this shared
    # venue, and the write path correctly falls back to an existing date. Reset
    # the row so we test the genuine "real carrier with no renewal anywhere" path.
    from sqlmodel import Session
    from app.api.v1.venues import VENUES
    from app.database import engine
    from app.models import Venue
    with Session(engine) as s:
        v = s.get(Venue, "elsewhere-brooklyn")
        v.current_carrier = None
        v.renewal_date = None
        s.add(v)
        s.commit()
    VENUES.pop("elsewhere-brooklyn", None)

    r = client.patch("/api/venues/elsewhere-brooklyn", json={
        "current_carrier": "Hiscox", "coverage_interest": ["gl"],
    }, headers=_op())
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "renewal_date_required"
