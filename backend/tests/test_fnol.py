from datetime import date
from decimal import Decimal
from sqlmodel import Session, SQLModel, create_engine
from app.models import (
    Carrier, CarrierQuote, ClaimProposal, IncidentRecord, Policy,
    RubricVersion, Submission, UnderwritingPacket, Venue,
)
from app.services.fnol import resolve_fnol_defaults


def _session() -> Session:
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    s.add(Venue(id="elsewhere-brooklyn", name="Elsewhere"))
    s.add(Carrier(
        id="markel-specialty", name="Markel Specialty",
        market_type="e&s",
    ))
    s.add(RubricVersion(
        id="demo-rubric-v1", name="Demo Rubric", version="1.0",
    ))
    s.commit()
    return s


def _proposal(s, *, risk_type="premises_liability", with_policy=True) -> ClaimProposal:
    s.add(IncidentRecord(
        id="inc-1", venue_id="elsewhere-brooklyn",
        occurred_at="2026-05-17T00:46:00Z", location="bar", summary="x",
        reported_by="mgr", injury_observed=True, police_called=False,
        ems_called=False, status="open",
    ))
    s.add(UnderwritingPacket(
        id="pkt-1", venue_id="elsewhere-brooklyn", incident_id="inc-1",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        snapshot_hash="h",
        risk_signals={"type": risk_type, "severity": "high", "confidence": 0.9},
    ))
    if with_policy:
        s.add(Submission(
            id="sub-1", venue_id="elsewhere-brooklyn",
            effective_date=date(2026, 1, 1),
            coverage_lines=["general_liability"],
        ))
        s.flush()
        s.add(CarrierQuote(
            id="q-1", submission_id="sub-1", carrier_id="markel-specialty",
        ))
        s.flush()
        s.add(Policy(
            id="pol-1", submission_id="sub-1", bound_quote_id="q-1",
            venue_id="elsewhere-brooklyn", carrier_id="markel-specialty",
            status="bound",
            effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
            annual_premium=Decimal("5000.00"),
            commission_amount=Decimal("750.00"),
            commission_rate=Decimal("0.15"),
            coverage_lines=["general_liability"],
            terms_snapshot={}, snapshot_hash="ph",
        ))
    prop = ClaimProposal(
        id="prop-1", packet_id="pkt-1", venue_id="elsewhere-brooklyn",
        proposed_by="auto-router", state="approved",
    )
    s.add(prop)
    s.flush()
    return prop


def test_resolves_policy_line_date():
    s = _session()
    p = _proposal(s)
    d = resolve_fnol_defaults(s, p)
    assert d["policy_id"] == "pol-1"
    assert d["coverage_line"] == "general_liability"   # premises_liability -> GL
    assert d["date_of_loss"] == date(2026, 5, 17)
    assert d["blockers"] == []


def test_blocks_when_no_active_policy():
    s = _session()
    p = _proposal(s, with_policy=False)
    d = resolve_fnol_defaults(s, p)
    assert "no_active_policy" in d["blockers"]
    assert d["policy_id"] is None
