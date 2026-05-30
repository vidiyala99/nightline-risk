"""Deterministic synthetic dataset for the calibration regression gate.

Calibration metrics (broker agreement, outcome-in-band, Brier) are normally
computed against the live DB by `scripts/run_calibration.py`. With no live data
in CI, this module seeds a fixed, hand-designed dataset whose metrics are
stable — the calibration analogue of `docs/evals/gold_standard.json`.

The CI gate (`scripts/run_calibration.py --compare-baseline`) seeds this into
an in-memory DB, recomputes the metrics, and fails if they drift from the
committed baseline (`app/evals/calibration_baseline.json`). That catches
accidental regressions in the calibration *computation* (the "offensive" eval
gate: is the recommender-vs-reality math still correct?), complementing the
synthetic-scenario gate in `runner.py`. Regenerate the baseline intentionally
with `--write-baseline` when the math legitimately changes.

The dataset is mixed on purpose so the metrics are non-degenerate:
  - broker agreement has both concurrence and override, plus a deferral
    (`needs_more_info`) that must be excluded;
  - outcome-in-band has in/above/below cases plus denied claims (excluded);
  - probability calibration spans low→high probability with paid+denied.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlmodel import Session

from app.models import (
    Claim,
    ClaimProposal,
    ReviewDecision,
    RubricVersion,
    UnderwritingPacket,
    Venue,
)

_RUBRIC_ID = "rv-calib"
_VENUE_ID = "venue-calib"

# (packet_id, should_file, probability, broker_decision, claim_status,
#  final_indemnity, payout_band(low, median, high))
_FIXTURE_ROWS = [
    ("p1", True,  0.90, "approved",        "closed_paid",   Decimal("5000"),  (1000, 5000, 10000)),
    ("p2", True,  0.85, "approved",        "closed_paid",   Decimal("12000"), (1000, 5000, 10000)),
    ("p3", True,  0.70, "blocked",         "closed_paid",   Decimal("500"),   (1000, 5000, 10000)),
    ("p4", False, 0.20, "blocked",         "closed_denied", None,             (1000, 5000, 10000)),
    ("p5", False, 0.30, "approved",        "closed_denied", None,             (1000, 5000, 10000)),
    ("p6", True,  0.80, "needs_more_info", "closed_paid",   Decimal("3000"),  (1000, 5000, 10000)),
    ("p7", True,  0.60, "approved",        "closed_paid",   Decimal("4000"),  (2000, 5000,  8000)),
    ("p8", False, 0.10, "blocked",         "closed_denied", None,             (1000, 5000, 10000)),
]


def _packet(session: Session, *, pid, should_file, probability, band) -> None:
    low, median, high = band
    session.add(UnderwritingPacket(
        id=pid, venue_id=_VENUE_ID, incident_id=f"inc-{pid}",
        rubric_version_id=_RUBRIC_ID, status="needs_review",
        risk_signals={
            "severity": "high",
            "claim_recommendation": {
                "should_file": should_file,
                "probability": probability,
                "expected_payout": {
                    "low_usd": low, "median_usd": median, "high_usd": high,
                },
            },
        },
        memo={"summary": "calibration fixture"}, snapshot_hash=f"hash-{pid}",
    ))


def _decision(session: Session, pid: str, decision: str) -> None:
    session.add(ReviewDecision(
        id=f"rd-{pid}", packet_id=pid, reviewer_id="broker-calib", decision=decision,
    ))


def _claim(session: Session, *, pid: str, status: str, final: Optional[Decimal]) -> None:
    session.add(ClaimProposal(
        id=f"prop-{pid}", packet_id=pid, venue_id=_VENUE_ID,
        proposed_by="op-calib", state="approved",
    ))
    session.add(Claim(
        id=f"clm-{pid}", policy_id="pol-calib", proposal_id=f"prop-{pid}",
        coverage_line="gl", status=status, date_of_loss=date(2026, 1, 1),
        final_indemnity=final, indemnity_paid_to_date=Decimal("0.00"),
        closed_at=datetime(2026, 2, 1, tzinfo=timezone.utc) if status.startswith("closed") else None,
        snapshot_hash=f"clm-hash-{pid}",
    ))


def seed_calibration_fixture(session: Session) -> None:
    """Seed the fixed calibration dataset. Caller owns the engine/session."""
    session.add(RubricVersion(id=_RUBRIC_ID, name="calib", version="1", rules={}))
    session.add(Venue(id=_VENUE_ID, name="Calibration Fixture Venue"))
    for pid, should_file, prob, decision, cstatus, final, band in _FIXTURE_ROWS:
        _packet(session, pid=pid, should_file=should_file, probability=prob, band=band)
        _decision(session, pid, decision)
        _claim(session, pid=pid, status=cstatus, final=final)
    session.commit()
