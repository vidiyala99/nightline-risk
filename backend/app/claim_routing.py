"""The routing gate: should a logged incident reach the broker, and how.

Single source of truth for the recommendation-gated routing thresholds so the
web UI never re-derives them — it reads the server-computed `route_status`.
"""
import os
from datetime import date
from typing import TYPE_CHECKING

from sqlmodel import Session, select

if TYPE_CHECKING:
    from app.agents.fraud_agent import FraudSignal

from app.claim_recommendation import ClaimRecommendation, recommend_claim_filing, recommendation_to_dict
from app.models import Claim, ClaimProposal, EvidenceFile, IncidentRecord, Policy, UnderwritingPacket
from app.packet_core import _add_audit_event
from app.time import now_utc


def _auto_confidence() -> float:
    return float(os.getenv("CLAIM_ROUTE_AUTO_CONFIDENCE", "0.70"))


def _borderline_floor() -> float:
    return float(os.getenv("CLAIM_ROUTE_BORDERLINE_FLOOR", "0.40"))


def route_status(rec: ClaimRecommendation) -> str:
    """auto_routed | borderline | not_routed — the gate decision for a rec."""
    if rec.confidence >= _auto_confidence():
        return "auto_routed" if rec.should_file else "not_routed"
    if rec.confidence >= _borderline_floor():
        return "borderline"
    return "not_routed"


def should_auto_route(rec: ClaimRecommendation) -> bool:
    return route_status(rec) == "auto_routed"


def recommendation_for_packet(session: Session, packet: UnderwritingPacket) -> ClaimRecommendation:
    """Build the ClaimRecommendation for a packet using REAL venue claim history.

    Single source for the recommendation so main.py, the auto-router, and the
    manual propose path agree on the number.
    """
    from app.services.fnol import RISK_TYPE_TO_COVERAGE, venue_line_deductible

    incident = session.get(IncidentRecord, packet.incident_id)
    incident_payload = {
        "injury_observed": bool(incident.injury_observed) if incident else False,
        "police_called": bool(incident.police_called) if incident else False,
        "ems_called": bool(incident.ems_called) if incident else False,
    }
    risk_type = (packet.risk_signals or {}).get("type", "")
    line_id = RISK_TYPE_TO_COVERAGE.get(risk_type, "gl")
    deductible = venue_line_deductible(session, packet.venue_id, line_id)
    return recommend_claim_filing(
        risk_signal=packet.risk_signals or {},
        incident=incident_payload,
        venue_prior_claim_count=count_prior_claims(session, packet.venue_id),
        deductible=deductible,
    )


def count_prior_claims(session: Session, venue_id: str) -> int:
    """Count a venue's carrier-side claims, excluding dropped ones.

    Claim has no venue_id; it joins to Policy (which does). A dropped claim
    never paid out, so it should not weigh on the venue's filing math.
    """
    rows = session.exec(
        select(Claim.status)
        .join(Policy, Claim.policy_id == Policy.id)
        .where(Policy.venue_id == venue_id)
    ).all()
    return sum(1 for status in rows if status != "closed_dropped")


def _latest_active_policy(session: Session, venue_id: str) -> "Policy | None":
    from app.services.fnol import ACTIVE_POLICY_STATUSES
    policies = session.exec(select(Policy).where(Policy.venue_id == venue_id)).all()
    active = [p for p in policies if p.status in ACTIVE_POLICY_STATUSES]
    if not active:
        return None
    active.sort(key=lambda p: p.effective_date or date.min, reverse=True)
    return active[0]


def fraud_signal_for_packet(session: Session, packet: UnderwritingPacket, **kwargs) -> "FraudSignal":
    """Assemble inputs and score fraud for a packet. kwargs forwards
    corroboration_status / corroboration_flags for the v2 re-score."""
    from app.agents.fraud_agent import assess_fraud

    incident = session.get(IncidentRecord, packet.incident_id)
    incident_payload = {
        "occurred_at": incident.occurred_at if incident else None,
        "injury_observed": bool(incident.injury_observed) if incident else False,
        "police_called": bool(incident.police_called) if incident else False,
        "ems_called": bool(incident.ems_called) if incident else False,
    }
    evidence_file_count = len(
        session.exec(select(EvidenceFile).where(EvidenceFile.incident_id == packet.incident_id)).all()
    )
    return assess_fraud(
        risk_signal=packet.risk_signals or {},
        incident=incident_payload,
        reported_at=now_utc(),
        policy=_latest_active_policy(session, packet.venue_id),
        prior_claim_count=count_prior_claims(session, packet.venue_id),
        evidence_file_count=evidence_file_count,
        **kwargs,
    )


def maybe_auto_route_incident(
    session: Session,
    *,
    packet: UnderwritingPacket,
    operator_id: str,
) -> ClaimRecommendation:
    """Compute the recommendation for a freshly-created packet and, when the gate
    says auto-route, create a pending_broker_review proposal with the snapshot.

    Idempotent: never creates a second proposal for the same packet. Returns the
    ClaimRecommendation (so callers can log/inspect), proposal created or not.
    """
    from app.claim_proposals import create_proposal  # local import avoids circular dependency

    rec = recommendation_for_packet(session, packet)
    # Fraud screening is advisory — a scorer/query fault must never drop the
    # operator's incident. On failure, log and fall through to normal routing.
    try:
        fraud = fraud_signal_for_packet(session, packet)
        packet.fraud_signal = fraud.to_dict()
        session.add(packet)
        if fraud.tier == "high":
            _add_audit_event(
                session=session, actor_id="auto-router", actor_type="system",
                entity_type="incident", entity_id=packet.incident_id,
                event_type="fraud.hold",
                event_metadata={"packet_id": packet.id, "score": fraud.score,
                                "flags": [f.code for f in fraud.red_flags]},
            )
            return rec
    except Exception as exc:  # noqa: BLE001 - advisory screening, never block routing
        print(f"[FRAUD] scoring failed for packet {packet.id}: {exc}")

    if not should_auto_route(rec):
        return rec
    existing = session.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == packet.id)
    ).first()
    if existing is not None:
        return rec
    create_proposal(
        session=session,
        packet_id=packet.id,
        operator_id="auto-router",
        override_recommendation=False,
        override_reason=None,
        override_freetext=None,
        recommendation_snapshot=recommendation_to_dict(rec),
    )
    return rec
