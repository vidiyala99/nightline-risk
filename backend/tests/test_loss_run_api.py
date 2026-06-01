"""API tests for the per-venue loss run (JSON + CSV export).

  GET /api/venues/{venue_id}/loss-run       → JSON
  GET /api/venues/{venue_id}/loss-run.csv   → text/csv attachment

Venue-access gated: brokers pass for any venue; an operator passes for their
own venue only.
"""
from fastapi.testclient import TestClient

from app.main import app
from app.auth import create_token

VENUE = "elsewhere-brooklyn"


def _broker_headers():
    token = create_token("user-broker-1", "broker@example.com", "broker", "tenant-1")
    return {"Authorization": f"Bearer {token}"}


def _owner_headers():
    token = create_token("user-op-1", "operator@example.com", "venue_operator", VENUE)
    return {"Authorization": f"Bearer {token}"}


def _other_operator_headers():
    token = create_token("user-op-2", "other@example.com", "venue_operator", "house-of-yes")
    return {"Authorization": f"Bearer {token}"}


def test_loss_run_broker_ok():
    with TestClient(app) as client:
        resp = client.get(f"/api/venues/{VENUE}/loss-run", headers=_broker_headers())
    assert resp.status_code == 200
    data = resp.json()
    for key in ("venue_id", "claims", "by_coverage_line", "summary"):
        assert key in data
    for key in ("claim_count", "open_count", "total_incurred", "total_paid"):
        assert key in data["summary"]


def test_loss_run_owning_operator_ok():
    with TestClient(app) as client:
        resp = client.get(f"/api/venues/{VENUE}/loss-run", headers=_owner_headers())
    assert resp.status_code == 200


def test_loss_run_other_operator_forbidden():
    with TestClient(app) as client:
        resp = client.get(f"/api/venues/{VENUE}/loss-run", headers=_other_operator_headers())
    assert resp.status_code == 403


def test_loss_run_anonymous_rejected():
    with TestClient(app) as client:
        resp = client.get(f"/api/venues/{VENUE}/loss-run")
    assert resp.status_code == 401


def test_loss_run_csv_export():
    with TestClient(app) as client:
        resp = client.get(f"/api/venues/{VENUE}/loss-run.csv", headers=_broker_headers())
    assert resp.status_code == 200
    assert "text/csv" in resp.headers["content-type"]
    assert "attachment" in resp.headers.get("content-disposition", "")
    assert "Date of Loss" in resp.text  # header row
