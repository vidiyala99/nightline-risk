from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.claim_recommendation import (
    ClaimRecommendation, PayoutRange, PremiumImpact,
)
from app.claim_routing import route_status, should_auto_route, count_prior_claims
from app.models import Claim, Policy, Venue


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
