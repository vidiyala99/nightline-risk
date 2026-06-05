import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from app.models import (
    AuditEvent,
    ClaimProposal,
    IncidentRecord,
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
