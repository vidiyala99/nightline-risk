"""Tests for the PR1 connectors (app/ingestion/connectors.py)."""
import json
from datetime import datetime

from sqlmodel import Session, SQLModel, create_engine, select

from app.ingestion.base import run_connector
from app.ingestion.connectors import (
    IdScanConnector,
    NycOpenDataConnector,
    PosConnector,
    StaffingConnector,
)
from app.ingestion.quality import is_valid_event
from app.models import Venue, VenueOperationalEvent


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


# ── PosConnector (simulated operational feed) ────────────────────────────

def test_pos_connector_emits_one_over_pour_event_per_venue():
    conn = PosConnector(venue_ids=["v1", "v2"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    events = [e for raw in conn.extract() for e in conn.transform(raw)]

    assert {e.venue_id for e in events} == {"v1", "v2"}
    assert all(e.metric_name == "over_pour_rate" for e in events)
    assert all(0.0 <= e.value <= 1.0 for e in events)
    assert all(e.occurred_at == datetime(2026, 5, 26, 2, 0, 0) for e in events)


def test_pos_connector_is_deterministic_per_as_of():
    a = PosConnector(venue_ids=["v1"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    b = PosConnector(venue_ids=["v1"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    va = next(e for raw in a.extract() for e in a.transform(raw)).value
    vb = next(e for raw in b.extract() for e in b.transform(raw)).value
    assert va == vb


def test_pos_run_loads_events_and_rolls_up_to_venue():
    s = _session()
    s.add(Venue(id="v1", name="Elsewhere", venue_data=json.dumps({"name": "Elsewhere"})))
    s.commit()

    venues_index: dict = {"v1": {"name": "Elsewhere"}}
    conn = PosConnector(
        venue_ids=["v1"], as_of=datetime(2026, 5, 26, 2, 0, 0), venues_index=venues_index
    )
    run = run_connector(conn, s)

    assert run.loaded == 1
    assert len(s.exec(select(VenueOperationalEvent)).all()) == 1
    # rollup wrote operational_data into both DB and the in-memory index
    assert "operational_data" in json.loads(s.get(Venue, "v1").venue_data)
    assert "over_pour_rate" in venues_index["v1"]["operational_data"]


# ── IdScanConnector + StaffingConnector ──────────────────────────────────

def test_id_scan_emits_rejection_and_occupancy_within_gate():
    conn = IdScanConnector(venue_ids=["v1"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    events = [e for raw in conn.extract() for e in conn.transform(raw)]
    metrics = {e.metric_name for e in events}
    assert metrics == {"id_rejection_rate", "occupancy_ratio"}
    # every emitted signal must pass the data-quality gate
    assert all(is_valid_event(e) for e in events)


def test_staffing_emits_ratio_within_gate():
    conn = StaffingConnector(venue_ids=["v1", "v2"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    events = [e for raw in conn.extract() for e in conn.transform(raw)]
    assert {e.venue_id for e in events} == {"v1", "v2"}
    assert all(e.metric_name == "staffing_ratio" for e in events)
    assert all(is_valid_event(e) for e in events)


def test_new_connectors_are_deterministic():
    a = IdScanConnector(venue_ids=["v1"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    b = IdScanConnector(venue_ids=["v1"], as_of=datetime(2026, 5, 26, 2, 0, 0))
    va = sorted((e.metric_name, e.value) for raw in a.extract() for e in a.transform(raw))
    vb = sorted((e.metric_name, e.value) for raw in b.extract() for e in b.transform(raw))
    assert va == vb


# ── NycOpenDataConnector (master-data upsert) ────────────────────────────

def test_nyc_connector_upserts_prospects_idempotently():
    s = _session()
    rows = [
        {"id": "SLA-1", "name": "The Owl Bar", "address": "1 Main St, Brooklyn"},
        {"id": "SLA-2", "name": "Mirage", "address": "2 Kent Ave, Brooklyn"},
    ]
    conn = NycOpenDataConnector(records=rows)
    first = run_connector(conn, s)
    assert first.loaded == 2

    prospects = s.exec(select(Venue).where(Venue.id.like("prospect-%"))).all()  # type: ignore[attr-defined]
    assert {p.id for p in prospects} == {"prospect-SLA-1", "prospect-SLA-2"}

    # rerun is idempotent — no new rows
    second = run_connector(NycOpenDataConnector(records=rows), s)
    assert second.loaded == 0
    assert second.skipped == 2
    assert len(s.exec(select(Venue).where(Venue.id.like("prospect-%"))).all()) == 2  # type: ignore[attr-defined]
