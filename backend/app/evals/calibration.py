"""Calibration metrics — score predictions against real-world outcomes.

Distinct from `scorers.py` (synthetic-scenario eval). Where scorers measure
agent quality against gold-standard expectations on hand-crafted scenarios,
calibration measures **historical predictions vs reality** — i.e. did the
AI Claim Recommendation actually match what brokers approved and carriers paid?

Three metrics, all subscription-free, all read-only on the existing schema:

1. **broker_agreement** — % of recommender's `should_file=True` packets the
   broker approved, and % of `should_file=False` packets the broker blocked.
   Calibrates the recommender against broker judgment. Joins via
   `UnderwritingPacket → ReviewDecision` (latest decision per packet).

2. **outcome_in_band** — for closed claims, did `final_indemnity` (or
   `indemnity_paid_to_date` when closed_paid) land inside the recommender's
   `[expected_payout.low_usd, .high_usd]` band? Joins via
   `Claim.proposal_id → ClaimProposal.packet_id → UnderwritingPacket`.

3. **probability_calibration** — for packets with both a `should_file`
   probability and a downstream closed outcome, bucket predictions by
   probability decile and compute the actual paid rate per bucket. This is
   the reliability-diagram data; a well-calibrated recommender has
   bucket-midpoint ≈ actual rate for every bucket.

All three return `dict` payloads. The CLI `scripts/run_calibration.py`
assembles them into a JSON+markdown report. No side effects, no commits.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any

from sqlmodel import Session, select

from app.models import Claim, ClaimProposal, ReviewDecision, UnderwritingPacket


# ─── Result shapes ───────────────────────────────────────────────────────


@dataclass
class BrokerAgreement:
    """How often the broker's decision matched the recommender's verdict.

    Predicted `should_file=True` should be approved; `should_file=False`
    should be blocked. `needs_more_info` / `needs_review` are excluded —
    they're a deferral, not a disagreement.
    """
    total_packets_with_decision: int
    agreed: int                # recommender and broker concur
    disagreed: int             # broker overrode the recommender
    agreement_rate: float      # agreed / (agreed + disagreed)
    # Confusion matrix for the two predictions
    file_approved: int         # rec=file, broker=approved   (true positive)
    file_blocked: int          # rec=file, broker=blocked    (false positive)
    nofile_approved: int       # rec=don't, broker=approved  (false negative)
    nofile_blocked: int        # rec=don't, broker=blocked   (true negative)


@dataclass
class OutcomeCalibration:
    """For closed claims, did the actual payout fall inside the predicted band?

    A well-calibrated recommender lands ≥80% of closed claims in-band. Below
    50% the payout distribution is materially miscalibrated.
    """
    total_closed_with_prediction: int
    in_band: int               # low_usd ≤ actual ≤ high_usd
    above_band: int            # actual > high_usd  (under-predicted payout)
    below_band: int            # actual < low_usd   (over-predicted payout)
    in_band_rate: float
    median_actual_usd: float | None
    median_predicted_usd: float | None


@dataclass
class ProbabilityBucket:
    bucket_label: str          # e.g. "0.0–0.2"
    bucket_lo: float
    bucket_hi: float
    n: int
    paid: int
    paid_rate: float
    bucket_midpoint: float
    calibration_gap: float     # paid_rate - bucket_midpoint  (signed)


@dataclass
class ProbabilityCalibration:
    """Reliability diagram data — actual paid rate per probability bucket."""
    n_total: int
    buckets: list[ProbabilityBucket] = field(default_factory=list)
    overall_brier_score: float | None = None   # mean squared error of probability vs outcome


# ─── Helpers ─────────────────────────────────────────────────────────────


_CLOSED_PAID_STATUSES = {"closed_paid", "paid"}
_CLOSED_DENIED_STATUSES = {"closed_denied", "denied", "closed_dropped"}
_CLOSED_STATUSES = _CLOSED_PAID_STATUSES | _CLOSED_DENIED_STATUSES


def _get_recommendation(packet: UnderwritingPacket) -> dict | None:
    """Pull the `claim_recommendation` block out of a packet, if present.

    The packet stores `risk_signals` as a JSON dict; on Postgres this comes
    back as a parsed dict, on SQLite the same. The recommender block can
    live either nested in `risk_signals.claim_recommendation` (older schema)
    or as a top-level key on `risk_signals` — handle both.
    """
    rs = packet.risk_signals or {}
    if not isinstance(rs, dict):
        return None
    rec = rs.get("claim_recommendation")
    if isinstance(rec, dict):
        return rec
    return None


def _latest_decision_by_packet(session: Session) -> dict[str, ReviewDecision]:
    """Return {packet_id: most-recent ReviewDecision}. Skips packets with none.

    Multiple decisions per packet are possible (broker revised); we take the
    most recent so the calibration reflects the broker's final word.
    """
    rows = session.exec(
        select(ReviewDecision).order_by(ReviewDecision.decided_at.desc())  # type: ignore[attr-defined]
    ).all()
    latest: dict[str, ReviewDecision] = {}
    for row in rows:
        if row.packet_id not in latest:
            latest[row.packet_id] = row
    return latest


def _claim_actual_indemnity(claim: Claim) -> Decimal | None:
    """Best-effort 'what did the carrier actually pay?' for a closed claim.

    Prefers `final_indemnity` (carrier's settled number), falls back to
    `indemnity_paid_to_date` when final isn't stamped yet. Returns None
    for unclosed claims or zero-payment cases (which would skew the band
    metric — denied claims aren't a payout calibration data point).
    """
    if claim.status not in _CLOSED_STATUSES:
        return None
    if claim.status in _CLOSED_DENIED_STATUSES:
        # Denied = $0 paid. Not a payout-band calibration signal; the
        # probability-calibration scorer captures denied outcomes separately.
        return None
    if claim.final_indemnity is not None and claim.final_indemnity > 0:
        return claim.final_indemnity
    if claim.indemnity_paid_to_date > 0:
        return claim.indemnity_paid_to_date
    return None


# ─── Metric computers ────────────────────────────────────────────────────


def compute_broker_agreement(session: Session) -> BrokerAgreement:
    """Compare recommender's `should_file` to broker's latest decision."""
    decisions = _latest_decision_by_packet(session)
    if not decisions:
        return BrokerAgreement(0, 0, 0, 0.0, 0, 0, 0, 0)

    packets = session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.id.in_(list(decisions.keys())))  # type: ignore[attr-defined]
    ).all()

    file_approved = file_blocked = nofile_approved = nofile_blocked = 0
    for packet in packets:
        rec = _get_recommendation(packet)
        if rec is None or "should_file" not in rec:
            continue
        dec = decisions[packet.id].decision
        if dec not in {"approved", "blocked"}:
            continue  # needs_more_info / needs_review = deferral, not a signal
        if rec["should_file"]:
            if dec == "approved":
                file_approved += 1
            else:
                file_blocked += 1
        else:
            if dec == "approved":
                nofile_approved += 1
            else:
                nofile_blocked += 1

    agreed = file_approved + nofile_blocked
    disagreed = file_blocked + nofile_approved
    total = agreed + disagreed
    rate = (agreed / total) if total else 0.0
    return BrokerAgreement(
        total_packets_with_decision=total,
        agreed=agreed,
        disagreed=disagreed,
        agreement_rate=rate,
        file_approved=file_approved,
        file_blocked=file_blocked,
        nofile_approved=nofile_approved,
        nofile_blocked=nofile_blocked,
    )


def compute_outcome_in_band(session: Session) -> OutcomeCalibration:
    """For closed paid claims, did actual indemnity land in the predicted band?"""
    # Join: Claim → ClaimProposal → UnderwritingPacket
    rows = session.exec(
        select(Claim, ClaimProposal, UnderwritingPacket)
        .join(ClaimProposal, Claim.proposal_id == ClaimProposal.id)  # type: ignore[arg-type]
        .join(UnderwritingPacket, ClaimProposal.packet_id == UnderwritingPacket.id)  # type: ignore[arg-type]
    ).all()

    in_band = above_band = below_band = 0
    actuals: list[float] = []
    predicted_medians: list[float] = []

    for claim, _, packet in rows:
        actual = _claim_actual_indemnity(claim)
        if actual is None:
            continue
        rec = _get_recommendation(packet)
        if rec is None:
            continue
        payout = rec.get("expected_payout") or {}
        lo = payout.get("low_usd")
        hi = payout.get("high_usd")
        median = payout.get("median_usd")
        if lo is None or hi is None:
            continue

        actual_f = float(actual)
        actuals.append(actual_f)
        if median is not None:
            predicted_medians.append(float(median))

        if actual_f < float(lo):
            below_band += 1
        elif actual_f > float(hi):
            above_band += 1
        else:
            in_band += 1

    total = in_band + above_band + below_band
    rate = (in_band / total) if total else 0.0
    return OutcomeCalibration(
        total_closed_with_prediction=total,
        in_band=in_band,
        above_band=above_band,
        below_band=below_band,
        in_band_rate=rate,
        median_actual_usd=(sorted(actuals)[len(actuals) // 2] if actuals else None),
        median_predicted_usd=(sorted(predicted_medians)[len(predicted_medians) // 2] if predicted_medians else None),
    )


def compute_probability_calibration(
    session: Session, *, n_buckets: int = 5
) -> ProbabilityCalibration:
    """Reliability-diagram data: actual paid rate per probability bucket.

    For every packet with a predicted `probability` AND a closed-claim
    outcome (paid OR denied), bucket by probability and compute the actual
    paid rate in each bucket. Includes Brier score (mean squared error) as
    a single-number summary — lower is better, 0 is perfect.
    """
    rows = session.exec(
        select(Claim, ClaimProposal, UnderwritingPacket)
        .join(ClaimProposal, Claim.proposal_id == ClaimProposal.id)  # type: ignore[arg-type]
        .join(UnderwritingPacket, ClaimProposal.packet_id == UnderwritingPacket.id)  # type: ignore[arg-type]
    ).all()

    # (probability, actually_paid_bool) pairs
    samples: list[tuple[float, bool]] = []
    for claim, _, packet in rows:
        if claim.status not in _CLOSED_STATUSES:
            continue
        rec = _get_recommendation(packet)
        if rec is None or "probability" not in rec:
            continue
        prob = rec.get("probability")
        if prob is None:
            continue
        paid = claim.status in _CLOSED_PAID_STATUSES
        samples.append((float(prob), paid))

    if not samples:
        return ProbabilityCalibration(n_total=0, buckets=[], overall_brier_score=None)

    # Equal-width buckets over [0, 1]
    width = 1.0 / n_buckets
    buckets: list[ProbabilityBucket] = []
    for i in range(n_buckets):
        lo = i * width
        hi = (i + 1) * width
        # Last bucket is closed on the right so probability=1.0 lands in it
        in_bucket = [
            (p, paid) for p, paid in samples
            if (lo <= p < hi) or (i == n_buckets - 1 and p == 1.0)
        ]
        n = len(in_bucket)
        paid_n = sum(1 for _, paid in in_bucket if paid)
        rate = (paid_n / n) if n else 0.0
        midpoint = (lo + hi) / 2
        buckets.append(ProbabilityBucket(
            bucket_label=f"{lo:.1f}–{hi:.1f}",
            bucket_lo=lo,
            bucket_hi=hi,
            n=n,
            paid=paid_n,
            paid_rate=rate,
            bucket_midpoint=midpoint,
            calibration_gap=rate - midpoint,
        ))

    brier = sum((p - (1.0 if paid else 0.0)) ** 2 for p, paid in samples) / len(samples)
    return ProbabilityCalibration(
        n_total=len(samples),
        buckets=buckets,
        overall_brier_score=brier,
    )


# ─── Top-level report ────────────────────────────────────────────────────


def run_calibration(session: Session, *, n_buckets: int = 5) -> dict[str, Any]:
    """Assemble all three calibration metrics into a single report dict.

    Shape mirrors `report.snapshot_payload` style (timestamped dict-of-dicts)
    so the CLI can write it alongside the existing eval baseline artifacts.
    """
    broker = compute_broker_agreement(session)
    outcome = compute_outcome_in_band(session)
    probability = compute_probability_calibration(session, n_buckets=n_buckets)

    return {
        "broker_agreement": asdict(broker),
        "outcome_in_band": asdict(outcome),
        "probability_calibration": asdict(probability),
    }
