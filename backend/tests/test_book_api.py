"""API tests for GET /api/book/financials — broker-only money rollup."""
from fastapi.testclient import TestClient

from app.main import app
from app.auth import create_token


def _broker_headers():
    token = create_token("user-broker-1", "broker@example.com", "broker", "tenant-1")
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token("user-op-1", "operator@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


def test_book_financials_broker_ok():
    with TestClient(app) as client:
        resp = client.get("/api/book/financials", headers=_broker_headers())
    assert resp.status_code == 200
    data = resp.json()
    for key in (
        "written_premium",
        "earned_premium",
        "commission_revenue",
        "incurred_losses",
        "loss_ratio",
        "policy_count",
        "open_claim_count",
        "by_coverage_line",
        "by_carrier",
    ):
        assert key in data
    assert isinstance(data["by_coverage_line"], list)
    assert isinstance(data["by_carrier"], list)


def test_book_financials_operator_rejected():
    with TestClient(app) as client:
        resp = client.get("/api/book/financials", headers=_operator_headers())
    assert resp.status_code == 403


def test_book_financials_anonymous_rejected():
    with TestClient(app) as client:
        resp = client.get("/api/book/financials")
    assert resp.status_code == 401
