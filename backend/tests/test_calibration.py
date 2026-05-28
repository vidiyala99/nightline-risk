"""Tests for the calibration metric computers.

In-memory SQLite seeded with hand-crafted packets/decisions/proposals/claims.
The math is deterministic — no LLM calls, no provider stubs needed.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy.pool import StaticPool

from app.models import (
    Claim,
    ClaimProposal,
    ReviewDecision,
    RubricVersion,
    UnderwritingPacket,
    Venue,
)
from app.evals.calibration import (
    compute_broker_agreement,
    compute_outcome_in_band,
    compute_probability_calibration,
    run_calibration,
)


# ─── Fixtures ────────────────────────────────────────────────────────────


@pytest.fixture()
def session() -> Session:
    """Fresh in-memory SQLite with all tables, scoped to each test."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed_rubric_and_venue(session: Session) -> tuple[str, str]:
    """Minimum FK parents a packet needs."""
    rubric = RubricVersion(id="rv-1", name="default", version="1", rules={})
    venue = Venue(id="v-1", name="Brooklyn Mirage")
    session.add(rubric)
    session.add(venue)
    session.commit()
    return rubric.id, venue.id


def _make_packet(
    session: Session,
    *,
    packet_id: str,
    rubric_id: str,
    venue_id: str,
    should_file: bool,
    probability: float = 0.5,
    payout_low: float = 1000.0,
    payout_median: float = 5000.0,
    payout_high: float = 10_000.0,
) -> UnderwritingPacket:
    packet = UnderwritingPacket(
        id=packet_id,
        venue_id=venue_id,
        incident_id=f"inc-{packet_id}",
        rubric_version_id=rubric_id,
        status="needs_review",
        risk_signals={
            "severity": "high",
            "claim_recommendation": {
                "should_file": should_file,
                "probability": probability,
                "expected_payout": {
                    "low_usd": payout_low,
                    "median_usd": payout_median,
                    "high_usd": payout_high,
                },
            },
        },
        memo={"summary": "test"},
        snapshot_hash=f"hash-{packet_id}",
    )
    session.add(packet)
    session.commit()
    return packet


def _make_decision(session: Session, packet_id: str, decision: str) -> None:
    row = ReviewDecision(
        id=f"rd-{packet_id}",
        packet_id=packet_id,
        reviewer_id="broker-1",
        decision=decision,
    )
    session.add(row)
    session.commit()


def _make_proposal_and_claim(
    session: Session,
    *,
    packet_id: str,
    venue_id: str,
    claim_status: str,
    final_indemnity: Decimal | None = None,
    indemnity_paid_to_date: Decimal = Decimal("0.00"),
) -> None:
    """Wire a packet to a Claim via a ClaimProposal.

    Note: SQLite without `PRAGMA foreign_keys = ON` does not enforce FKs, so
    we can create a Claim with a fake `policy_id` without seeding the full
    Submission → CarrierQuote → Policy chain. This keeps the test scoped to
    calibration math, not to the broker-platform FK graph.
    """
    proposal = ClaimProposal(
        id=f"prop-{packet_id}",
        packet_id=packet_id,
        venue_id=venue_id,
        proposed_by="op-1",
        state="approved",
    )
    session.add(proposal)
    session.commit()

    claim = Claim(
        id=f"clm-{packet_id}",
        policy_id="pol-fake",
        proposal_id=proposal.id,
        coverage_line="gl",
        status=claim_status,
        date_of_loss=date.today(),
        final_indemnity=final_indemnity,
        indemnity_paid_to_date=indemnity_paid_to_date,
        closed_at=datetime.now(timezone.utc) if claim_status.startswith("closed") else None,
        snapshot_hash=f"clm-hash-{packet_id}",
    )
    session.add(claim)
    session.commit()


# ─── Broker agreement ────────────────────────────────────────────────────


def test_broker_agreement_perfect(session: Session) -> None:
    rv, v = _seed_rubric_and_venue(session)
    # Recommender said file → broker approved (agreement)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_decision(session, "p1", "approved")
    # Recommender said don't file → broker blocked (agreement)
    _make_packet(session, packet_id="p2", rubric_id=rv, venue_id=v, should_file=False)
    _make_decision(session, "p2", "blocked")

    result = compute_broker_agreement(session)
    assert result.total_packets_with_decision == 2
    assert result.agreed == 2
    assert result.disagreed == 0
    assert result.agreement_rate == 1.0
    assert result.file_approved == 1
    assert result.nofile_blocked == 1


def test_broker_agreement_disagreement(session: Session) -> None:
    rv, v = _seed_rubric_and_venue(session)
    # Recommender said file → broker blocked (false positive)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_decision(session, "p1", "blocked")
    # Recommender said don't file → broker approved (false negative)
    _make_packet(session, packet_id="p2", rubric_id=rv, venue_id=v, should_file=False)
    _make_decision(session, "p2", "approved")

    result = compute_broker_agreement(session)
    assert result.agreed == 0
    assert result.disagreed == 2
    assert result.agreement_rate == 0.0
    assert result.file_blocked == 1
    assert result.nofile_approved == 1


def test_broker_agreement_excludes_needs_more_info(session: Session) -> None:
    """`needs_more_info` is a deferral, not a disagreement — must be excluded."""
    rv, v = _seed_rubric_and_venue(session)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_decision(session, "p1", "needs_more_info")
    _make_packet(session, packet_id="p2", rubric_id=rv, venue_id=v, should_file=True)
    _make_decision(session, "p2", "approved")

    result = compute_broker_agreement(session)
    assert result.total_packets_with_decision == 1  # only p2 counted
    assert result.agreed == 1
    assert result.agreement_rate == 1.0


def test_broker_agreement_empty(session: Session) -> None:
    result = compute_broker_agreement(session)
    assert result.total_packets_with_decision == 0
    assert result.agreement_rate == 0.0


def test_broker_agreement_uses_latest_decision(session: Session) -> None:
    """When a broker revises their decision, the most recent one wins."""
    rv, v = _seed_rubric_and_venue(session)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)

    old = ReviewDecision(
        id="rd-old", packet_id="p1", reviewer_id="b1",
        decision="blocked",
        decided_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    new = ReviewDecision(
        id="rd-new", packet_id="p1", reviewer_id="b1",
        decision="approved",
        decided_at=datetime.now(timezone.utc),
    )
    session.add(old)
    session.add(new)
    session.commit()

    result = compute_broker_agreement(session)
    assert result.agreed == 1  # latest (approved) matches should_file=True
    assert result.disagreed == 0


# ─── Outcome in band ─────────────────────────────────────────────────────


def test_outcome_in_band(session: Session) -> None:
    rv, v = _seed_rubric_and_venue(session)
    # Predicted [1000, 10000] median 5000 — actual paid $5500 → in-band
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_proposal_and_claim(
        session, packet_id="p1", venue_id=v,
        claim_status="closed_paid", final_indemnity=Decimal("5500.00"),
    )

    result = compute_outcome_in_band(session)
    assert result.total_closed_with_prediction == 1
    assert result.in_band == 1
    assert result.in_band_rate == 1.0


def test_outcome_above_band(session: Session) -> None:
    rv, v = _seed_rubric_and_venue(session)
    # Predicted [1000, 10000] — actual paid $20000 → above-band (under-predicted)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_proposal_and_claim(
        session, packet_id="p1", venue_id=v,
        claim_status="closed_paid", final_indemnity=Decimal("20000.00"),
    )

    result = compute_outcome_in_band(session)
    assert result.above_band == 1
    assert result.in_band_rate == 0.0


def test_outcome_below_band(session: Session) -> None:
    rv, v = _seed_rubric_and_venue(session)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_proposal_and_claim(
        session, packet_id="p1", venue_id=v,
        claim_status="closed_paid", final_indemnity=Decimal("500.00"),
    )

    result = compute_outcome_in_band(session)
    assert result.below_band == 1


def test_outcome_skips_denied_and_open(session: Session) -> None:
    """Denied claims = $0 paid → not a payout-band signal. Open claims excluded too."""
    rv, v = _seed_rubric_and_venue(session)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_proposal_and_claim(session, packet_id="p1", venue_id=v, claim_status="closed_denied")
    _make_packet(session, packet_id="p2", rubric_id=rv, venue_id=v, should_file=True)
    _make_proposal_and_claim(session, packet_id="p2", venue_id=v, claim_status="notified")

    result = compute_outcome_in_band(session)
    assert result.total_closed_with_prediction == 0


def test_outcome_falls_back_to_paid_to_date(session: Session) -> None:
    """If final_indemnity is None but indemnity_paid_to_date is set, use that."""
    rv, v = _seed_rubric_and_venue(session)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True)
    _make_proposal_and_claim(
        session, packet_id="p1", venue_id=v,
        claim_status="closed_paid",
        final_indemnity=None,
        indemnity_paid_to_date=Decimal("3000.00"),
    )

    result = compute_outcome_in_band(session)
    assert result.in_band == 1


# ─── Probability calibration ─────────────────────────────────────────────


def test_probability_calibration_perfect(session: Session) -> None:
    """If recommender predicts probability=1.0 and outcome is always paid → Brier = 0."""
    rv, v = _seed_rubric_and_venue(session)
    for i in range(5):
        _make_packet(
            session, packet_id=f"p{i}", rubric_id=rv, venue_id=v,
            should_file=True, probability=1.0,
        )
        _make_proposal_and_claim(
            session, packet_id=f"p{i}", venue_id=v,
            claim_status="closed_paid", final_indemnity=Decimal("5000"),
        )

    result = compute_probability_calibration(session, n_buckets=5)
    assert result.n_total == 5
    assert result.overall_brier_score == 0.0
    # All samples land in the last bucket (0.8–1.0)
    last_bucket = result.buckets[-1]
    assert last_bucket.n == 5
    assert last_bucket.paid_rate == 1.0


def test_probability_calibration_miscalibrated(session: Session) -> None:
    """Predicts 0.9 but actual paid rate is 0.5 → calibration gap is large."""
    rv, v = _seed_rubric_and_venue(session)
    # 4 packets all predicted at 0.9; 2 paid, 2 denied
    for i, status in enumerate(["closed_paid", "closed_paid", "closed_denied", "closed_denied"]):
        _make_packet(
            session, packet_id=f"p{i}", rubric_id=rv, venue_id=v,
            should_file=True, probability=0.9,
        )
        _make_proposal_and_claim(session, packet_id=f"p{i}", venue_id=v, claim_status=status)

    result = compute_probability_calibration(session, n_buckets=5)
    assert result.n_total == 4
    last_bucket = result.buckets[-1]
    assert last_bucket.n == 4
    assert last_bucket.paid_rate == 0.5
    # Predicted midpoint 0.9, actual 0.5 → gap of -0.4
    assert last_bucket.calibration_gap == pytest.approx(-0.4)


def test_probability_calibration_empty(session: Session) -> None:
    result = compute_probability_calibration(session)
    assert result.n_total == 0
    assert result.overall_brier_score is None
    assert result.buckets == []


# ─── Top-level integration ───────────────────────────────────────────────


def test_run_calibration_assembles_all_three(session: Session) -> None:
    rv, v = _seed_rubric_and_venue(session)
    _make_packet(session, packet_id="p1", rubric_id=rv, venue_id=v, should_file=True, probability=0.8)
    _make_decision(session, "p1", "approved")
    _make_proposal_and_claim(
        session, packet_id="p1", venue_id=v,
        claim_status="closed_paid", final_indemnity=Decimal("5000"),
    )

    report = run_calibration(session)
    assert set(report.keys()) == {"broker_agreement", "outcome_in_band", "probability_calibration"}
    assert report["broker_agreement"]["agreement_rate"] == 1.0
    assert report["outcome_in_band"]["in_band"] == 1
    assert report["probability_calibration"]["n_total"] == 1
