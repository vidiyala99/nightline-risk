"""Shared incident-status-feed builder.

Resolves each of a venue's incidents to its status chain
(incident -> latest packet -> latest proposal -> claim) in one pass, so the
operator home renders a report feed without an N+1 of /claim-status hits.

Extracted from the `venue_incident_status_feed` route so the copilot's
`list_incidents` tool and the HTTP route share a single implementation
(one source of truth for the feed shape).
"""
from __future__ import annotations

from sqlmodel import Session, select

from app.models import Claim, ClaimProposal, IncidentRecord, UnderwritingPacket


def incident_status_feed(session: Session, venue_id: str) -> list[dict]:
    """Per-incident status chain for a venue's incidents, newest first.

    Returns a list of dicts with keys:
    ``incident_id, summary, occurred_at, status, proposal_state, claim_status``.
    """
    incidents = session.exec(
        select(IncidentRecord)
        .where(IncidentRecord.venue_id == venue_id)
        .order_by(IncidentRecord.occurred_at.desc())
    ).all()

    feed: list[dict] = []
    for inc in incidents:
        packet = session.exec(
            select(UnderwritingPacket)
            .where(UnderwritingPacket.incident_id == inc.id)
            .order_by(UnderwritingPacket.generated_at.desc())
        ).first()

        proposal = None
        if packet is not None:
            proposal = session.exec(
                select(ClaimProposal)
                .where(ClaimProposal.packet_id == packet.id)
                .order_by(ClaimProposal.proposed_at.desc())
            ).first()

        claim = None
        if proposal is not None:
            claim = session.exec(
                select(Claim).where(Claim.proposal_id == proposal.id)
            ).first()
        if claim is None:
            claim = session.exec(
                select(Claim).where(Claim.incident_id == inc.id)
            ).first()

        feed.append({
            "incident_id": inc.id,
            "summary": inc.summary,
            "occurred_at": inc.occurred_at.isoformat() if hasattr(inc.occurred_at, "isoformat") else str(inc.occurred_at),
            "status": inc.status,
            "proposal_state": proposal.state if proposal else None,
            "claim_status": claim.status if claim else None,
        })
    return feed
