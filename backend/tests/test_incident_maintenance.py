"""Service tests for incident-bloat control (backlog #37).

Two mechanisms keep the Safety Record honest without manual ops:
  - enforce_open_incident_cap: bounds the number of OPEN app-generated
    incidents per venue (archives the oldest beyond the cap) — runs on every
    new filing, so a long demo can't accumulate unbounded open rows.
  - archive_stale_incidents: age-based remediation (the callable core the
    cleanup script delegates to).

Both archive to 'closed_archived' (never delete), preserving history + audit.
"""
from datetime import timedelta

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, IncidentRecord
from app.services.incident_maintenance import (
    MAX_OPEN_APP_INCIDENTS,
    archive_stale_incidents,
    enforce_open_incident_cap,
    find_stale_incidents,
)
from app.time import now_utc


@pytest.fixture()
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _add_incident(session, *, iid, venue_id="v1", age_days=1.0, status="open"):
    session.add(IncidentRecord(
        id=iid, venue_id=venue_id,
        occurred_at=(now_utc() - timedelta(days=age_days)).isoformat(),
        location="floor", summary="thing happened", reported_by="op",
        injury_observed=False, police_called=False, ems_called=False,
        status=status,
    ))
    session.flush()


# ─── cap ─────────────────────────────────────────────────────────────────────


def test_cap_archives_oldest_beyond_cap(session):
    # cap + 2 open app-generated incidents, ascending age (i=0 newest)
    for i in range(MAX_OPEN_APP_INCIDENTS + 2):
        _add_incident(session, iid=f"inc-{i}", age_days=float(i + 1))
    archived = enforce_open_incident_cap(session, "v1")
    # the 2 OLDEST (largest age) are archived; cap remain open
    assert len(archived) == 2
    open_now = session.exec(
        select(IncidentRecord).where(IncidentRecord.status == "open")
    ).all()
    assert len(open_now) == MAX_OPEN_APP_INCIDENTS
    archived_ids = {r.id for r in archived}
    assert archived_ids == {
        f"inc-{MAX_OPEN_APP_INCIDENTS}", f"inc-{MAX_OPEN_APP_INCIDENTS + 1}"
    }


def test_cap_noop_when_under_limit(session):
    for i in range(3):
        _add_incident(session, iid=f"inc-{i}")
    assert enforce_open_incident_cap(session, "v1") == []


def test_cap_ignores_seed_rows_and_closed(session):
    _add_incident(session, iid="seed-1", age_days=999.0)          # seed: never touched
    _add_incident(session, iid="inc-closed", age_days=999.0, status="closed")
    for i in range(MAX_OPEN_APP_INCIDENTS + 1):
        _add_incident(session, iid=f"inc-{i}", age_days=float(i + 1))
    archived = enforce_open_incident_cap(session, "v1")
    assert len(archived) == 1
    assert all(not r.id.startswith("seed-") for r in archived)


def test_cap_never_archives_protected_just_filed_incident(session):
    # The just-filed incident may have the OLDEST occurred_at, yet must survive.
    _add_incident(session, iid="inc-new", age_days=999.0)  # oldest by date
    for i in range(MAX_OPEN_APP_INCIDENTS):
        _add_incident(session, iid=f"inc-{i}", age_days=float(i + 1))
    archived = enforce_open_incident_cap(session, "v1", protect_ids={"inc-new"})
    assert len(archived) == 1
    assert "inc-new" not in {r.id for r in archived}
    assert session.get(IncidentRecord, "inc-new").status == "open"


def test_cap_emits_audit_event(session):
    for i in range(MAX_OPEN_APP_INCIDENTS + 1):
        _add_incident(session, iid=f"inc-{i}", age_days=float(i + 1))
    archived = enforce_open_incident_cap(session, "v1")
    events = session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == archived[0].id)
    ).all()
    assert any(e.event_type == "incident.closed_archived" for e in events)


# ─── age-based archive ────────────────────────────────────────────────────────


def test_find_and_archive_stale_by_age(session):
    _add_incident(session, iid="inc-old", age_days=120.0)
    _add_incident(session, iid="inc-recent", age_days=5.0)
    _add_incident(session, iid="seed-old", age_days=120.0)        # seed preserved

    stale = find_stale_incidents(session, older_than_days=60)
    assert {r.id for r, _ in stale} == {"inc-old"}

    archived = archive_stale_incidents(session, older_than_days=60)
    assert {r.id for r in archived} == {"inc-old"}
    assert session.get(IncidentRecord, "inc-old").status == "closed_archived"
    assert session.get(IncidentRecord, "inc-recent").status == "open"
