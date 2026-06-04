"""HTTP tests for the real-time push ingestion endpoints (app/api/v1/ingestion.py).

These prove the push lane is no longer a print-only stub: a posted signal now
flows through the same spine as batch (quality gate + content-hash dedupe +
IngestionRun log + rollup), so "POST a signal -> Savings Score inputs move" is
true. Each test uses a unique venue_id to isolate its VenueOperationalEvent rows
in the shared test DB.
"""
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.database import get_session
from app.main import app
from app.models import IngestionRun, Venue, VenueOperationalEvent


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _vid(prefix: str) -> str:
    """A unique venue id per test run so the shared DB's accumulated rows can't
    leak between runs (these tests assert exact per-venue row counts)."""
    return f"{prefix}-{uuid4().hex[:8]}"


def _events(venue_id: str, metric: str):
    session = next(get_session())
    try:
        rows = session.exec(
            select(VenueOperationalEvent)
            .where(VenueOperationalEvent.venue_id == venue_id)
            .where(VenueOperationalEvent.metric_name == metric)
        ).all()
        return rows
    finally:
        session.close()


def _ensure_venue(venue_id: str, capacity: int) -> None:
    session = next(get_session())
    try:
        if session.get(Venue, venue_id) is None:
            session.add(
                Venue(
                    id=venue_id,
                    name=venue_id,
                    venue_data=json.dumps({"name": venue_id, "capacity": capacity}),
                )
            )
            session.commit()
    finally:
        session.close()


# --- generic signal webhook -------------------------------------------------

def test_signal_webhook_persists_and_returns_operational_data(client):
    v = _vid("push-sig")
    resp = client.post(
        f"/api/v1/ingest/{v}/signal",
        json={"source_system": "pos", "metric_name": "over_pour_rate", "value": 0.62},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["loaded"] == 1
    assert body["rejected"] == 0
    assert body["operational_data"]["over_pour_rate"] == 0.62

    rows = _events(v, "over_pour_rate")
    assert len(rows) == 1
    assert rows[0].value == 0.62
    assert rows[0].source_system == "pos"


def test_signal_webhook_rejects_out_of_range_value(client):
    v = _vid("push-sig-bad")
    resp = client.post(
        f"/api/v1/ingest/{v}/signal",
        json={"source_system": "pos", "metric_name": "over_pour_rate", "value": 5.0},
    )
    # Request is well-formed and accepted, but the quality gate rejects the
    # value so nothing is persisted (no score pollution).
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["loaded"] == 0
    assert body["rejected"] == 1
    assert _events(v, "over_pour_rate") == []


def test_signal_webhook_logs_an_ingestion_run(client):
    v = _vid("push-sig-run")
    client.post(
        f"/api/v1/ingest/{v}/signal",
        json={"source_system": "id_scanner", "metric_name": "id_rejection_rate", "value": 0.1},
    )
    session = next(get_session())
    try:
        runs = session.exec(
            select(IngestionRun).where(IngestionRun.source_system == "id_scanner")
        ).all()
        assert any(r.status == "success" and r.loaded >= 1 for r in runs)
    finally:
        session.close()


# --- camera: faithful instantaneous occupancy reading ----------------------

def test_camera_push_derives_occupancy_ratio(client):
    v = _vid("push-cam")
    _ensure_venue(v, capacity=1000)
    resp = client.post(
        f"/api/v1/ingest/{v}/camera",
        json={
            "venue_id": v,
            "payload": {
                "zone_id": "dance-floor",
                "person_count": 750,
                "detections": [],
                "aggression_score": 0.2,
            },
        },
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["loaded"] == 1
    # 750 / 1000 capacity
    assert body["operational_data"]["occupancy_ratio"] == 0.75
    rows = _events(v, "occupancy_ratio")
    assert len(rows) == 1 and rows[0].value == 0.75


# --- pos: alcohol-share over-pour proxy ------------------------------------

def test_pos_push_derives_over_pour_rate(client):
    v = _vid("push-pos")
    resp = client.post(
        f"/api/v1/ingest/{v}/pos",
        json={
            "venue_id": v,
            "payload": {
                "order_id": "o-1",
                "total_amount": 60.0,
                "items": [
                    {"sku": "a", "name": "Beer", "quantity": 3, "price_total": 30.0, "category": "alcohol"},
                    {"sku": "w", "name": "Water", "quantity": 1, "price_total": 5.0, "category": "water"},
                ],
                "payment_method": "card",
            },
        },
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["loaded"] == 1
    # 3 alcohol / 4 total = 0.75
    assert body["operational_data"]["over_pour_rate"] == 0.75


# --- staffing: persists a provided coverage ratio --------------------------

def test_staffing_push_with_ratio_persists(client):
    v = _vid("push-staff")
    resp = client.post(
        f"/api/v1/ingest/{v}/staffing",
        json={
            "venue_id": v,
            "payload": {
                "staff_id": "s1",
                "name": "Dana",
                "role": "security",
                "action": "clock-in",
                "staffing_ratio": 0.8,
            },
        },
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["loaded"] == 1
    rows = _events(v, "staffing_ratio")
    assert len(rows) == 1 and rows[0].value == 0.8


def test_staffing_push_without_ratio_records_no_metric(client):
    v = _vid("push-staff-2")
    resp = client.post(
        f"/api/v1/ingest/{v}/staffing",
        json={
            "venue_id": v,
            "payload": {"staff_id": "s2", "name": "Lee", "role": "bartender", "action": "clock-in"},
        },
    )
    # A bare clock event carries no coverage level — accepted, nothing scored.
    assert resp.status_code == 202, resp.text
    assert resp.json()["loaded"] == 0
    assert _events(v, "staffing_ratio") == []


# --- guardrails preserved ---------------------------------------------------

def test_venue_id_mismatch_still_rejected(client):
    resp = client.post(
        "/api/v1/ingest/push-mismatch/pos",
        json={
            "venue_id": "some-other-venue",
            "payload": {
                "order_id": "o-2",
                "total_amount": 10.0,
                "items": [{"sku": "x", "name": "Soda", "quantity": 1, "price_total": 5.0, "category": "food"}],
                "payment_method": "cash",
            },
        },
    )
    assert resp.status_code == 400
