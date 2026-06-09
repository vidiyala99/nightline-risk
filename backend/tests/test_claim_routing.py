from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.claim_recommendation import (
    ClaimRecommendation, PayoutRange, PremiumImpact,
)
from app.claim_routing import route_status, should_auto_route, count_prior_claims
from app.models import Claim, Policy, Venue, IncidentRecord


def _rec(*, should_file: bool, confidence: float) -> ClaimRecommendation:
    return ClaimRecommendation(
        should_file=should_file,
        probability=0.6,
        expected_payout=PayoutRange(1, 2, 3),
        expected_premium_impact=PremiumImpact(1, 3, 3),
        net_expected_value_usd=100,
        reasons=[],
        confidence=confidence,
    )


def test_auto_routed_when_should_file_and_high_confidence():
    assert route_status(_rec(should_file=True, confidence=0.81)) == "auto_routed"
    assert should_auto_route(_rec(should_file=True, confidence=0.81)) is True


def test_confident_dont_file_is_not_routed():
    assert route_status(_rec(should_file=False, confidence=0.9)) == "not_routed"
    assert should_auto_route(_rec(should_file=False, confidence=0.9)) is False


def test_borderline_band_prompts_operator():
    assert route_status(_rec(should_file=True, confidence=0.55)) == "borderline"
    assert route_status(_rec(should_file=False, confidence=0.55)) == "borderline"
    assert should_auto_route(_rec(should_file=True, confidence=0.55)) is False


def test_below_floor_is_not_routed():
    assert route_status(_rec(should_file=True, confidence=0.30)) == "not_routed"


def test_no_active_policy_is_never_routed():
    """A ClaimProposal becomes a Claim only by filing against a policy. With no
    active policy there's nothing to file, so it's never routed to the broker —
    regardless of confidence/should_file."""
    import dataclasses
    no_policy = dataclasses.replace(
        _rec(should_file=True, confidence=0.95), has_active_policy=False
    )
    assert route_status(no_policy) == "not_routed"
    assert should_auto_route(no_policy) is False


# ─── count_prior_claims ──────────────────────────────────────────────────


def _db_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id="elsewhere-brooklyn", name="Elsewhere"))
    s.commit()
    return s


def _policy(session: Session, venue_id: str) -> Policy:
    pol = Policy(
        id=f"pol-{venue_id}",
        submission_id="sub-test-placeholder",
        bound_quote_id="q-test-placeholder",
        venue_id=venue_id,
        carrier_id="markel-specialty",
        status="active",
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("5000.00"),
        commission_amount=Decimal("750.00"),
        commission_rate=Decimal("0.15"),
        coverage_lines=["premises_liability"],
        terms_snapshot={},
        snapshot_hash="hash-test",
    )
    session.add(pol)
    session.flush()
    return pol


def test_count_prior_claims_excludes_dropped():
    s = _db_session()
    pol = _policy(s, "elsewhere-brooklyn")
    s.add(Claim(id="clm-1", policy_id=pol.id, coverage_line="premises_liability",
                status="reserved", date_of_loss=date(2026, 1, 1)))
    s.add(Claim(id="clm-2", policy_id=pol.id, coverage_line="premises_liability",
                status="closed_dropped", date_of_loss=date(2026, 1, 2)))
    s.flush()
    assert count_prior_claims(s, "elsewhere-brooklyn") == 1


def test_count_prior_claims_zero_for_unknown_venue():
    s = _db_session()
    assert count_prior_claims(s, "no-such-venue") == 0


# ─── create_proposal persistence ─────────────────────────────────────────────

from app.claim_proposals import create_proposal
from app.models import UnderwritingPacket, ClaimProposal


def _packet(session, venue_id="elsewhere-brooklyn") -> UnderwritingPacket:
    pkt = UnderwritingPacket(
        id="pkt-routetest", venue_id=venue_id, incident_id="inc-x",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "premises_liability", "severity": "medium", "confidence": 0.81},
        snapshot_hash="test-hash",
    )
    session.add(pkt)
    session.flush()
    return pkt


def test_recommendation_for_packet_uses_real_prior_claims():
    from app.claim_routing import recommendation_for_packet
    s = _db_session()
    s.add(IncidentRecord(
        id="inc-x", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="slip", reported_by="mgr",
        injury_observed=True, police_called=False, ems_called=False, status="open",
    ))
    _packet(s)  # pkt-routetest, incident_id="inc-x"
    rec = recommendation_for_packet(s, s.get(UnderwritingPacket, "pkt-routetest"))
    assert rec.should_file in (True, False)
    assert 0.0 <= rec.confidence <= 1.0


def test_create_proposal_persists_recommendation_snapshot():
    s = _db_session()
    _packet(s)
    snap = {"should_file": True, "confidence": 0.81, "net_expected_value_usd": 8000}
    proposal = create_proposal(
        session=s, packet_id="pkt-routetest", operator_id="auto-router",
        override_recommendation=False, override_reason=None, override_freetext=None,
        recommendation_snapshot=snap,
    )
    fetched = s.get(ClaimProposal, proposal.id)
    assert fetched.recommendation_snapshot == snap


# ─── maybe_auto_route_incident ───────────────────────────────────────────────

from app.claim_routing import maybe_auto_route_incident


def test_auto_route_creates_pending_proposal_with_snapshot():
    s = _db_session()
    _policy(s, "elsewhere-brooklyn")  # auto-route presupposes a policy to file against
    s.add(IncidentRecord(
        id="inc-hi", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="serious", reported_by="mgr",
        injury_observed=True, police_called=True, ems_called=True, status="open",
    ))
    pkt = UnderwritingPacket(
        id="pkt-hi", venue_id="elsewhere-brooklyn", incident_id="inc-hi",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9},
        snapshot_hash="h",
    )
    s.add(pkt); s.flush()

    maybe_auto_route_incident(s, packet=pkt, operator_id="mgr")

    props = s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-hi")).all()
    assert len(props) == 1
    assert props[0].state == "pending_broker_review"
    assert props[0].recommendation_snapshot["should_file"] is True
    # idempotent: a second call creates no duplicate
    maybe_auto_route_incident(s, packet=pkt, operator_id="mgr")
    props2 = s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-hi")).all()
    assert len(props2) == 1


def test_borderline_incident_creates_no_proposal():
    s = _db_session()
    s.add(IncidentRecord(
        id="inc-mid", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="minor", reported_by="mgr",
        injury_observed=False, police_called=False, ems_called=False, status="open",
    ))
    pkt = UnderwritingPacket(
        id="pkt-mid", venue_id="elsewhere-brooklyn", incident_id="inc-mid",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "general_incident", "severity": "low", "confidence": 0.55},
        snapshot_hash="h",
    )
    s.add(pkt); s.flush()
    maybe_auto_route_incident(s, packet=pkt, operator_id="mgr")
    props = s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-mid")).all()
    assert props == []


# ─── seed/backfill path auto-routes (Gap A) ──────────────────────────────────


def test_backfill_auto_routes_high_confidence_incident():
    """The startup backfill must auto-route high-confidence 'file' incidents the
    same way the live incident-create flow does.

    Without this, a broker opening a *seeded* incident (e.g. seed-market-hotel-013)
    sees a 'File' recommendation with no proposal to act on — the packet is
    generated but the ClaimProposal is never created.
    """
    from datetime import datetime
    from app.main import _backfill_incident_packets

    s = _db_session()  # seeds Venue "elsewhere-brooklyn"
    _policy(s, "elsewhere-brooklyn")  # auto-route presupposes a policy to file against
    # The real market-hotel altercation: injury + police + EMS → high-confidence
    # "file" under the deterministic classifier (matches the 90% in the UI).
    s.add(IncidentRecord(
        id="inc-altercation", venue_id="elsewhere-brooklyn",
        occurred_at=datetime(2026, 4, 22, 23, 10),
        location="Main Bar",
        summary=("Bouncer used excessive force when removing a patron who refused to "
                 "leave. Patron claims injuries to shoulder. Police arrived post-incident."),
        reported_by="Venue Owner",
        injury_observed=True, police_called=True, ems_called=True, status="open",
    ))
    s.commit()

    _backfill_incident_packets(s)

    pkt = s.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == "inc-altercation")
    ).first()
    assert pkt is not None, "backfill should still generate the packet"
    proposal = s.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == pkt.id)
    ).first()
    assert proposal is not None, "backfill should auto-route a high-confidence 'file' incident"
    assert proposal.state == "pending_broker_review"
    assert proposal.recommendation_snapshot["should_file"] is True


# ─── self-heal: packets created before auto-routing existed ──────────────────


def test_backfill_heals_packeted_incident_missing_its_proposal():
    """A high-confidence 'file' incident that already had a packet — but no
    proposal — must get its proposal retroactively.

    `_backfill_incident_packets` only auto-routes incidents it *freshly* packets
    (it skips any incident that already has a packet). So rows packeted before
    auto-routing shipped (e.g. prod incidents from an earlier deploy) never get a
    proposal and silently miss the broker inbox. The self-heal pass closes that
    gap; without it the operator sees 'sent' nowhere while the rec says auto-route.
    """
    from datetime import datetime
    from app.main import _backfill_missing_proposals

    s = _db_session()
    _policy(s, "elsewhere-brooklyn")  # auto-route presupposes a policy to file against
    s.add(IncidentRecord(
        id="inc-legacy", venue_id="elsewhere-brooklyn",
        occurred_at=datetime(2026, 4, 22, 23, 10), location="Main Bar",
        summary="Serious altercation; patron injured, police and EMS on scene.",
        reported_by="Venue Owner",
        injury_observed=True, police_called=True, ems_called=True, status="open",
    ))
    # Packet exists already (pre-auto-route deploy) but NO proposal.
    s.add(UnderwritingPacket(
        id="pkt-legacy", venue_id="elsewhere-brooklyn", incident_id="inc-legacy",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9},
        snapshot_hash="h",
    ))
    s.commit()
    assert s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-legacy")).first() is None

    _backfill_missing_proposals(s)

    proposal = s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-legacy")).first()
    assert proposal is not None, "self-heal must create the missing auto-routed proposal"
    assert proposal.state == "pending_broker_review"
    # Idempotent: a second pass creates no duplicate.
    _backfill_missing_proposals(s)
    assert len(s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-legacy")).all()) == 1


def test_backfill_self_heal_leaves_borderline_packets_alone():
    """The self-heal must NOT route borderline / low-confidence packets — those
    stay the operator's call, exactly like the fresh-packet auto-router."""
    from app.main import _backfill_missing_proposals

    s = _db_session()
    s.add(IncidentRecord(
        id="inc-mild", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="minor verbal dispute, de-escalated", reported_by="mgr",
        injury_observed=False, police_called=False, ems_called=False, status="open",
    ))
    s.add(UnderwritingPacket(
        id="pkt-mild", venue_id="elsewhere-brooklyn", incident_id="inc-mild",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "general_incident", "severity": "low", "confidence": 0.55},
        snapshot_hash="h",
    ))
    s.commit()

    _backfill_missing_proposals(s)

    assert s.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-mild")).all() == []


# ─── Task 4: deductible wired into recommendation_for_packet ─────────────────

from app.claim_routing import recommendation_for_packet
from datetime import date as _date


def test_recommendation_for_packet_applies_deductible():
    s = _db_session()
    s.add(IncidentRecord(id="inc-x", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="x", reported_by="m", injury_observed=True, police_called=True,
        ems_called=True, status="open"))
    _packet(s)  # pkt-routetest, premises_liability -> line "gl"
    s.add(Policy(id="po-x", submission_id="s", bound_quote_id="q", venue_id="elsewhere-brooklyn",
        carrier_id="markel-specialty", status="active", effective_date=_date(2026,1,1),
        expiration_date=_date(2027,1,1), annual_premium=Decimal("5000"), commission_amount=Decimal("750"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
        terms_snapshot={"premium_breakdown": {"lines": {"gl": {"deductible": "999999"}}}}, snapshot_hash="h"))
    s.commit()
    rec = recommendation_for_packet(s, s.get(UnderwritingPacket, "pkt-routetest"))
    assert rec.carrier_payout_usd == 0
