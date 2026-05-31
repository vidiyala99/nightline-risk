"""The routing gate: should a logged incident reach the broker, and how.

Single source of truth for the recommendation-gated routing thresholds so the
web UI never re-derives them — it reads the server-computed `route_status`.
"""
import os

from sqlmodel import Session, select

from app.claim_recommendation import ClaimRecommendation
from app.models import Claim, Policy


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
