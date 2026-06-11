import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app

# Quoted money value so the thousands-comma survives CSV parsing.
_CSV = b'Date of Loss,Coverage,Net Paid,Outstanding\n2026-05-01,A&B,"$1,200.50",500\n'


def _headers(role, venue=None):
    return {"Authorization": f"Bearer {create_token('u-'+role, role+'@x.com', role, venue)}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_broker_can_upload_and_read_back(client):
    up = client.post(
        "/api/loss-run-imports",
        files={"file": ("lr.csv", _CSV, "text/csv")},
        data={"source_format": "csv"},
        headers=_headers("broker"),
    )
    assert up.status_code == 201, up.text
    body = up.json()
    assert body["row_count"] == 1
    import_id = body["id"]

    detail = client.get(f"/api/loss-run-imports/{import_id}", headers=_headers("carrier"))
    assert detail.status_code == 200
    row = detail.json()["rows"][0]
    assert row["paid"] == "1200.50"                      # money serialized as string
    assert row["coverage_line"] == "assault_battery"
    assert row["field_confidence"]["paid"] == 0.9        # JSON coerced at read boundary


def test_operator_is_forbidden(client):
    r = client.post(
        "/api/loss-run-imports",
        files={"file": ("lr.csv", _CSV, "text/csv")},
        data={"source_format": "csv"},
        headers=_headers("venue_operator", "elsewhere-brooklyn"),
    )
    assert r.status_code == 403


def test_bad_format_returns_400(client):
    r = client.post(
        "/api/loss-run-imports",
        files={"file": ("x.pdf", b"x", "application/pdf")},
        data={"source_format": "pdf"},
        headers=_headers("broker"),
    )
    assert r.status_code == 400
