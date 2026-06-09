"""Shared, importable seed helpers for the copilot.

The borderline-insured / no-policy seeding used to live inside the pytest
fixtures in ``tests/copilot/conftest.py``. It is extracted here so there is one
definition that BOTH the conftest fixtures (Tasks 3/7) and the gold eval
scenarios (Task 10, ``app/evals/copilot_scenarios.py``) import.

A "borderline" packet has ``risk_signals={"type":"general_incident",
"severity":"low","confidence":0.55}`` (confidence 0.55 ∈ [0.40, 0.70)) so
``route_status`` returns ``"borderline"`` — the operator-decision band
``validate_send_to_broker`` gates on.

  - ``seed_borderline`` seeds Venue + RubricVersion + IncidentRecord +
    UnderwritingPacket (uninsured: send-to-broker blocked on coverage).
  - ``seed_policy`` adds an active Policy on top (insured: send-to-broker
    allowed once the rec lands borderline-and-insured).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

from app.copilot.tools import CopilotScope
from app.models import (
    IncidentRecord,
    Policy,
    RubricVersion,
    UnderwritingPacket,
    Venue,
)

VENUE = "elsewhere-brooklyn"
INCIDENT_ID = "inc-borderline"
PACKET_ID = "pkt-borderline"

# Fixed clock for determinism (mirrors intelligence_scenarios.NOW).
NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def operator_scope(session: Session) -> CopilotScope:
    return CopilotScope(
        user={"role": "venue_operator", "tenant_id": VENUE, "user_id": "u-op"},
        venue_ids={VENUE},
        session=session,
        now=NOW,
    )


def seed_borderline(session: Session) -> None:
    """Seed the uninsured borderline incident (no active policy)."""
    session.add(Venue(id=VENUE, name="Elsewhere"))
    session.add(RubricVersion(id="demo-rubric-v1", name="Demo", version="1"))
    session.add(IncidentRecord(
        id=INCIDENT_ID, venue_id=VENUE, occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="minor verbal dispute, de-escalated", reported_by="mgr",
        injury_observed=False, police_called=False, ems_called=False, status="open",
    ))
    session.add(UnderwritingPacket(
        id=PACKET_ID, venue_id=VENUE, incident_id=INCIDENT_ID,
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "general_incident", "severity": "low", "confidence": 0.55},
        snapshot_hash="h",
    ))
    session.flush()


def seed_policy(session: Session) -> None:
    """Add an active Policy so the borderline rec is genuinely insured."""
    session.add(Policy(
        id=f"pol-{VENUE}", submission_id="sub-test-placeholder",
        bound_quote_id="q-test-placeholder", venue_id=VENUE,
        carrier_id="markel-specialty", status="active",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("5000.00"), commission_amount=Decimal("750.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["premises_liability"],
        terms_snapshot={}, snapshot_hash="hash-test",
    ))
    session.flush()
