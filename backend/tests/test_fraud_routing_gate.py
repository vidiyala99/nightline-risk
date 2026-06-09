from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from app.models import (
    AuditEvent,
    ClaimProposal,
    IncidentRecord,
    Policy,
    RubricVersion,
    UnderwritingPacket,
)


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def test_fraud_signal_column_round_trips(db_session):
    pkt = UnderwritingPacket(
        id="pkt-1", venue_id="v1", incident_id="inc-1", rubric_version_id="rv-1",
        status="generated", snapshot_hash="h",
        fraud_signal={"score": 0.55, "tier": "high", "red_flags": [], "summary": "s",
                      "assessed_stage": "v1"},
    )
    db_session.add(pkt)
    db_session.commit()
    db_session.expire_all()
    got = db_session.get(UnderwritingPacket, "pkt-1")
    assert got.fraud_signal["tier"] == "high"


def _seed_packet(session, *, prior_injury=True):
    session.add(RubricVersion(id="rv-1", name="demo", version="demo"))
    # Auto-route presupposes an active policy to file against (no policy → not routed).
    session.add(Policy(
        id="pol-v1", submission_id="sub-x", bound_quote_id="q-x", venue_id="v1",
        carrier_id="markel-specialty", status="active",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("5000.00"), commission_amount=Decimal("750.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["premises_liability"],
        terms_snapshot={}, snapshot_hash="h",
    ))
    session.add(IncidentRecord(
        id="inc-1", venue_id="v1", status="open",
        occurred_at="2026-05-01T22:00:00Z", location="bar",
        summary="x", reported_by="op",
        injury_observed=prior_injury, police_called=False, ems_called=False,
    ))
    pkt = UnderwritingPacket(
        id="pkt-1", venue_id="v1", incident_id="inc-1", rubric_version_id="rv-1",
        status="generated", snapshot_hash="h",
        risk_signals={"type": "altercation_event", "severity": "high",
                      "confidence": 0.95, "should_file": True},
    )
    session.add(pkt)
    session.commit()
    return pkt


def test_high_fraud_suppresses_autoroute_and_audits(db_session, monkeypatch):
    from app import claim_routing
    from app.agents.fraud_agent import FraudSignal
    monkeypatch.setattr(
        claim_routing, "fraud_signal_for_packet",
        lambda session, packet, **kw: FraudSignal(0.7, "high", [], "high risk", "v1"),
    )
    pkt = _seed_packet(db_session)
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    db_session.commit()

    assert db_session.exec(select(ClaimProposal)).first() is None
    holds = db_session.exec(
        select(AuditEvent).where(AuditEvent.event_type == "fraud.hold")
    ).all()
    assert len(holds) == 1
    assert db_session.get(UnderwritingPacket, "pkt-1").fraud_signal["tier"] == "high"


def test_low_fraud_still_routes(db_session, monkeypatch):
    from app import claim_routing
    from app.agents.fraud_agent import FraudSignal
    monkeypatch.setattr(
        claim_routing, "fraud_signal_for_packet",
        lambda session, packet, **kw: FraudSignal(0.0, "none", [], "clean", "v1"),
    )
    pkt = _seed_packet(db_session, prior_injury=False)
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    db_session.commit()
    assert db_session.exec(select(ClaimProposal)).first() is not None


def test_fraud_scoring_failure_does_not_block_routing(db_session, monkeypatch):
    from app import claim_routing

    def _boom(session, packet, **kw):
        raise RuntimeError("scorer exploded")

    monkeypatch.setattr(claim_routing, "fraud_signal_for_packet", _boom)
    pkt = _seed_packet(db_session, prior_injury=False)
    # must NOT raise; fraud is advisory, so routing proceeds normally
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    db_session.commit()
    assert db_session.exec(select(ClaimProposal)).first() is not None


def test_high_fraud_hold_persists_without_caller_commit(db_session, monkeypatch):
    from app import claim_routing
    from app.agents.fraud_agent import FraudSignal
    monkeypatch.setattr(
        claim_routing, "fraud_signal_for_packet",
        lambda session, packet, **kw: FraudSignal(0.7, "high", [], "high risk", "v1"),
    )
    pkt = _seed_packet(db_session)
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    # Do NOT commit here. Roll back to discard anything the function did NOT
    # commit itself; the hold + signal must survive because the function commits.
    db_session.rollback()
    assert db_session.exec(
        select(AuditEvent).where(AuditEvent.event_type == "fraud.hold")
    ).first() is not None
    assert db_session.get(UnderwritingPacket, "pkt-1").fraud_signal.get("tier") == "high"


def test_borderline_fraud_signal_persists_without_caller_commit(db_session, monkeypatch):
    from app import claim_routing
    from app.agents.fraud_agent import FraudSignal
    # elevated (not high) -> no hold, must still persist the signal and NOT suppress routing
    monkeypatch.setattr(
        claim_routing, "fraud_signal_for_packet",
        lambda session, packet, **kw: FraudSignal(0.4, "elevated", [], "elevated", "v1"),
    )
    pkt = _seed_packet(db_session, prior_injury=False)
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    db_session.rollback()
    assert db_session.get(UnderwritingPacket, "pkt-1").fraud_signal.get("tier") == "elevated"


def test_v2_rescore_escalates_with_contradiction():
    from app.agents.fraud_agent import assess_fraud
    from app.agents.corroboration_agent import INJURY_NOT_VISIBLE_FLAG
    import datetime as _dt
    incident = {"occurred_at": "2026-05-01T22:00:00Z", "injury_observed": True,
                "police_called": False, "ems_called": False}
    reported = _dt.datetime(2026, 5, 1, 23, 0, tzinfo=_dt.timezone.utc)
    v1 = assess_fraud(risk_signal={"severity": "high"}, incident=incident,
                      reported_at=reported, prior_claim_count=0, evidence_file_count=2)
    v2 = assess_fraud(risk_signal={"severity": "high"}, incident=incident,
                      reported_at=reported, prior_claim_count=0, evidence_file_count=2,
                      corroboration_status="CONTRADICTED",
                      corroboration_flags=[INJURY_NOT_VISIBLE_FLAG])
    assert v1.tier != "high"
    assert v2.tier == "high"
    assert v2.assessed_stage == "v2"


def test_run_corroboration_writes_v2_fraud_signal(db_session):
    """Integration: the v2 site re-scores fraud onto the corroboration packet."""
    from app.main import _run_corroboration_and_update_packet
    from app.packet_core import create_packet_snapshot
    from app.schemas.domain import IncidentCreate
    from app.models import EvidenceAnalysis, EvidenceFile
    from app.agents.corroboration_agent import INJURY_NOT_VISIBLE_FLAG  # noqa: F401

    incident = IncidentRecord(
        id="inc-1", venue_id="v1", status="open",
        occurred_at="2026-05-01T22:00:00Z", location="bar",
        summary="patron reported injury after altercation", reported_by="op",
        injury_observed=True, police_called=False, ems_called=False,
    )
    db_session.add(incident)
    for i in range(2):
        db_session.add(EvidenceFile(
            id=f"ev-{i}", incident_id="inc-1", filename=f"f{i}.jpg",
            content_type="image/jpeg", file_path=f"k{i}", file_size=10,
        ))
    db_session.commit()

    incident_payload = IncidentCreate(
        occurred_at="2026-05-01T22:00:00Z", location="bar",
        summary="patron reported injury after altercation", reported_by="op",
        injury_observed=True, police_called=False, ems_called=False,
    )
    prior_packet = create_packet_snapshot(
        session=db_session, venue_id="v1", incident_id="inc-1",
        incident=incident_payload,
        risk_signal={"type": "altercation_event", "severity": "high",
                     "confidence": 0.5, "should_file": True},
        action_plan=[], claims_timeline=[],
        underwriting_memo={"summary": "altercation with reported injury"},
        citations=[], rubric_version="demo",
    )
    db_session.commit()

    # A CONTRADICTED finding: injury reported but not visible in evidence.
    finding = {
        "incident_indicators": [], "injury_detail": "no visible injury",
        "crowd_density": "moderate", "security_present": True,
        "security_response_seconds": 30, "environmental_hazards": [],
        "timestamp_in_exif": None, "timestamp_matches_report": True,
        "corroboration": "CONTRADICTED", "confidence_delta": -0.2,
        "raw_description": "no injury visible",
    }
    analysis = EvidenceAnalysis(
        id="an-1", evidence_id="ev-0", incident_id="inc-1",
        analysis_type="image", findings=finding, corroboration="CONTRADICTED",
        status="complete",
    )
    db_session.add(analysis)
    db_session.commit()

    _run_corroboration_and_update_packet(db_session, "inc-1", incident, [analysis])

    db_session.expire_all()
    packets = db_session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == "inc-1")
    ).all()
    v2 = [p for p in packets if p.id != prior_packet.id]
    assert len(v2) == 1, "expected exactly one v2 corroboration packet"
    fraud = v2[0].fraud_signal
    assert fraud, "v2 packet should carry a fraud_signal"
    assert fraud["assessed_stage"] == "v2"
    # CONTRADICTED evidence pushes the v2 re-score to high (v1 was not high),
    # so exactly one fraud.flagged audit event should be emitted.
    assert fraud["tier"] == "high"
    flagged = db_session.exec(
        select(AuditEvent)
        .where(AuditEvent.entity_id == "inc-1")
        .where(AuditEvent.event_type == "fraud.flagged")
    ).all()
    assert len(flagged) == 1, "expected exactly one fraud.flagged event"


def _seed_v2_corroboration_fixture(db_session):
    """Seed incident + evidence + v1 packet + a CONTRADICTED analysis.

    Returns (incident, prior_packet, [analysis]) ready for
    _run_corroboration_and_update_packet.
    """
    from app.packet_core import create_packet_snapshot
    from app.schemas.domain import IncidentCreate
    from app.models import EvidenceAnalysis, EvidenceFile

    incident = IncidentRecord(
        id="inc-1", venue_id="v1", status="open",
        occurred_at="2026-05-01T22:00:00Z", location="bar",
        summary="patron reported injury after altercation", reported_by="op",
        injury_observed=True, police_called=False, ems_called=False,
    )
    db_session.add(incident)
    for i in range(2):
        db_session.add(EvidenceFile(
            id=f"ev-{i}", incident_id="inc-1", filename=f"f{i}.jpg",
            content_type="image/jpeg", file_path=f"k{i}", file_size=10,
        ))
    db_session.commit()

    incident_payload = IncidentCreate(
        occurred_at="2026-05-01T22:00:00Z", location="bar",
        summary="patron reported injury after altercation", reported_by="op",
        injury_observed=True, police_called=False, ems_called=False,
    )
    prior_packet = create_packet_snapshot(
        session=db_session, venue_id="v1", incident_id="inc-1",
        incident=incident_payload,
        risk_signal={"type": "altercation_event", "severity": "high",
                     "confidence": 0.5, "should_file": True},
        action_plan=[], claims_timeline=[],
        underwriting_memo={"summary": "altercation with reported injury"},
        citations=[], rubric_version="demo",
    )
    db_session.commit()

    finding = {
        "incident_indicators": [], "injury_detail": "no visible injury",
        "crowd_density": "moderate", "security_present": True,
        "security_response_seconds": 30, "environmental_hazards": [],
        "timestamp_in_exif": None, "timestamp_matches_report": True,
        "corroboration": "CONTRADICTED", "confidence_delta": -0.2,
        "raw_description": "no injury visible",
    }
    analysis = EvidenceAnalysis(
        id="an-1", evidence_id="ev-0", incident_id="inc-1",
        analysis_type="image", findings=finding, corroboration="CONTRADICTED",
        status="complete",
    )
    db_session.add(analysis)
    db_session.commit()
    return incident, prior_packet, [analysis]


def test_run_corroboration_fraud_flagged_is_idempotent(db_session):
    """Re-running the v2 re-score must not duplicate the fraud.flagged event."""
    from app.main import _run_corroboration_and_update_packet

    incident, _prior, analyses = _seed_v2_corroboration_fixture(db_session)

    _run_corroboration_and_update_packet(db_session, "inc-1", incident, analyses)
    _run_corroboration_and_update_packet(db_session, "inc-1", incident, analyses)

    db_session.expire_all()
    flagged = db_session.exec(
        select(AuditEvent)
        .where(AuditEvent.entity_id == "inc-1")
        .where(AuditEvent.event_type == "fraud.flagged")
    ).all()
    assert len(flagged) == 1, "fraud.flagged must not be duplicated on re-run"


def test_v2_rescore_failure_keeps_corroboration_packet(db_session, monkeypatch):
    """A fraud-scoring fault rolls back only the fraud mutation, not the v2 packet."""
    from app import claim_routing
    from app.main import _run_corroboration_and_update_packet

    incident, prior_packet, analyses = _seed_v2_corroboration_fixture(db_session)

    def _boom(session, packet, **kw):
        raise RuntimeError("scorer exploded")

    # The fraud block imports fraud_signal_for_packet from app.claim_routing
    # inside the function, so patch the module attribute.
    monkeypatch.setattr(claim_routing, "fraud_signal_for_packet", _boom)

    # Must NOT raise — the re-score is advisory/best-effort.
    _run_corroboration_and_update_packet(db_session, "inc-1", incident, analyses)

    db_session.expire_all()
    packets = db_session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == "inc-1")
    ).all()
    v2 = [p for p in packets if p.id != prior_packet.id]
    assert len(v2) == 1, "the committed v2 corroboration packet must survive"
