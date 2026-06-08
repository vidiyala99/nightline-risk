"""Gold scenarios for the intelligence eval. Each scenario seeds an in-memory
DB, runs compute_exposure for a persona, and declares the expected finding ids
and severities. These encode the cross-entity / defensibility questions from
the spec — the questions no dashboard answers."""
from __future__ import annotations

from datetime import datetime, timezone, date
from decimal import Decimal

from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.models import IncidentRecord, Policy, CoverageLine

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _operator_evidence_gap():
    s = _fresh_session()
    s.add(IncidentRecord(id="inc-1", venue_id="v1", occurred_at="2026-06-01",
                         location="x", summary="Brawl", reported_by="s",
                         injury_observed=True, police_called=True, ems_called=False,
                         status="open"))
    s.commit()
    return {
        "name": "operator_evidence_gap",
        "user": {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"},
        "session": s,
        "expected_ids": {"evidence_gap:incident:inc-1"},
        "expected_severity": {"evidence_gap:incident:inc-1": "high"},
    }


def _operator_clean_no_false_alarm():
    s = _fresh_session()
    from app.models import EvidenceFile
    s.add(IncidentRecord(id="inc-2", venue_id="v1", occurred_at="2026-06-01",
                         location="x", summary="ok", reported_by="s",
                         injury_observed=False, police_called=False, ems_called=False,
                         status="open"))
    s.add(EvidenceFile(id="ev-1", incident_id="inc-2", filename="c.mp4",
                       content_type="video/mp4", file_path="/x"))
    s.commit()
    return {
        "name": "operator_clean_no_false_alarm",
        "user": {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"},
        "session": s,
        "expected_ids": set(),
        "expected_severity": {},
    }


def _broker_coverage_gap():
    s = _fresh_session()
    s.add(CoverageLine(id="gl", name="General Liability", description="d",
                       is_required_by_default=True,
                       default_per_occurrence_limit=Decimal("1000000")))
    s.add(Policy(id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id="v1",
                 carrier_id="c1", status="active",
                 effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                 annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                 commission_rate=Decimal("0"), coverage_lines=[]))
    s.commit()
    return {
        "name": "broker_coverage_gap",
        "user": {"sub": "b1", "role": "broker", "tenant_id": None},
        "session": s,
        "expected_ids": {"coverage_gap_eo:policy:pol-1"},
        "expected_severity": {"coverage_gap_eo:policy:pol-1": "high"},
    }


SCENARIOS = [
    _operator_evidence_gap,
    _operator_clean_no_false_alarm,
    _broker_coverage_gap,
]
