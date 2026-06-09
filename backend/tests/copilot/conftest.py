"""Shared fixtures for copilot tool tests.

The act-tool tests need a packet whose recommendation lands **borderline**
(confidence 0.55 ∈ [0.40, 0.70)) so ``route_status`` returns ``"borderline"``
— the operator-decision band ``validate_send_to_broker`` gates on. We mirror
the seeding shape from ``tests/test_claim_routing.py``: a Venue, a
RubricVersion, a no-injury IncidentRecord, and an UnderwritingPacket with
``risk_signals={"type":"general_incident","severity":"low","confidence":0.55}``.

Two variants:
  - ``seeded_borderline_incident_no_policy`` — uninsured (rec.has_active_policy
    False), so send-to-broker is blocked on coverage.
  - ``seeded_borderline_incident_insured``  — same packet + an active Policy,
    so the rec is genuinely borderline-and-insured (send-to-broker allowed).

Each yields ``(scope, incident_id)`` where ``scope`` is a ``CopilotScope``
bound to the venue/operator.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
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


def _make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _scope(session: Session) -> CopilotScope:
    return CopilotScope(
        user={"role": "venue_operator", "tenant_id": VENUE, "user_id": "u-op"},
        venue_ids={VENUE},
        session=session,
        now=datetime(2026, 6, 8, tzinfo=timezone.utc),
    )


def _seed_borderline(session: Session) -> None:
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


def _seed_policy(session: Session) -> None:
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


@pytest.fixture
def seeded_borderline_incident_no_policy():
    with _make_session() as s:
        _seed_borderline(s)
        s.commit()
        yield _scope(s), INCIDENT_ID


@pytest.fixture
def seeded_borderline_incident_insured():
    with _make_session() as s:
        _seed_borderline(s)
        _seed_policy(s)
        s.commit()
        # Sanity: with the active policy the packet must actually land borderline.
        from app.claim_routing import recommendation_for_packet, route_status
        pkt = s.get(UnderwritingPacket, PACKET_ID)
        assert route_status(recommendation_for_packet(s, pkt)) == "borderline"
        yield _scope(s), INCIDENT_ID


# ─── Engine-level fixtures (Task 7) ─────────────────────────────────────────
# The engine takes ``(user, session)`` (it resolves the scope itself via
# ``accessible_venue_ids``), so these reuse the SAME seed logic and just unpack
# ``scope.user`` / ``scope.session`` from the scope-based fixtures above. The
# user dict already carries ``role="venue_operator"`` + ``tenant_id=<venue_id>``
# so ``accessible_venue_ids`` resolves the operator's venue.


@pytest.fixture
def seeded_operator_session(seeded_borderline_incident_insured):
    scope, _incident_id = seeded_borderline_incident_insured
    yield scope.user, scope.session


@pytest.fixture
def seeded_borderline_incident_insured_user(seeded_borderline_incident_insured):
    scope, incident_id = seeded_borderline_incident_insured
    yield scope.user, scope.session, incident_id


@pytest.fixture
def seeded_no_policy_incident_user(seeded_borderline_incident_no_policy):
    scope, incident_id = seeded_borderline_incident_no_policy
    yield scope.user, scope.session, incident_id
