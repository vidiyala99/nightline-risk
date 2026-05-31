"""Phase B — claim-proposal (operator-side recommendation) routes + the
override-stats aggregates that live with them conceptually.

URLs preserved:
  POST /api/packets/{packet_id}/claim-proposal
  POST /api/claim-proposals/{proposal_id}/broker-decision
  GET  /api/claim-proposals
  GET  /api/claim-proposals/by-packet/{packet_id}
  GET  /api/override-stats
  GET  /api/venues/{venue_id}/override-stats

Distinct from /api/claims/* (carrier-side claims, see api/v1/claims.py)
— see ADR-0004 for the vocabulary split.
"""
from __future__ import annotations

# Pydantic body models (ClaimProposalCreate / BrokerDecisionCreate) and
# the response-shape helper (_claim_proposal_to_dict) currently live in
# main.py at module load time. To avoid a circular import we mirror the
# Pydantic shapes locally and lazy-import the response helper. When the
# services/claim_proposals.py module lands (later Phase B slice), both
# will move into that module and the lazy imports go away.

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import accessible_venue_ids, current_user_optional, require_venue_access
from app.claim_proposals import (
    ClaimProposalValidationError,
    compute_override_stats,
    create_proposal as create_claim_proposal,
    record_broker_decision as record_claim_broker_decision,
    record_operator_info_response as record_claim_operator_info_response,
    stats_to_dict as override_stats_to_dict,
)
from app.database import get_session
from app.models import ClaimProposal, UnderwritingPacket


# Mirror the Pydantic shapes that currently live in main.py. Keeping a
# local copy here avoids the circular import at module load. The shapes
# match exactly — if main.py's models drift, these must too. A future
# `services/claim_proposals.py` slice will make this the single home.
class _ClaimProposalCreate(BaseModel):
    operator_id: str
    override_recommendation: bool = False
    override_reason: str | None = None
    override_freetext: str | None = None


class _BrokerDecisionCreate(BaseModel):
    broker_id: str
    decision: str
    notes: str | None = None


class _OperatorInfoResponseCreate(BaseModel):
    operator_id: str
    response_note: str


def _proposal_to_dict(proposal) -> dict[str, Any]:
    """Lazy import to avoid the circular at module load: main.py defines
    _claim_proposal_to_dict but also imports this router."""
    from app.main import _claim_proposal_to_dict as _to_dict
    return _to_dict(proposal)

router = APIRouter()


# ─── Create + decision ──────────────────────────────────────────────────


@router.post("/packets/{packet_id}/claim-proposal", status_code=201)
def create_claim_proposal_route(
    packet_id: str,
    payload: _ClaimProposalCreate,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Operator proposes a claim against a packet.

    Actor ID rides in the body for attribution; the token is the access gate.
    The venue is resolved from the packet — an unknown packet falls through to
    the service's legacy 404 (entity-404 precedes auth).
    """
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is not None:
        require_venue_access(packet.venue_id, authorization, session)
    try:
        proposal = create_claim_proposal(
            session=session,
            packet_id=packet_id,
            operator_id=payload.operator_id,
            override_recommendation=payload.override_recommendation,
            override_reason=payload.override_reason,
            override_freetext=payload.override_freetext,
        )
    except ClaimProposalValidationError as e:
        message = str(e)
        status = 404 if "Packet not found" in message else 400
        # Legacy contract: string `detail` body. Tests assert on
        # `response.json()["detail"]` substrings, so don't migrate this
        # to the new envelope shape until the test contract is also
        # updated (Phase A migration policy: one release of overlap).
        from fastapi import HTTPException
        raise HTTPException(status_code=status, detail=message) from e
    return _proposal_to_dict(proposal)


@router.post("/claim-proposals/{proposal_id}/broker-decision")
def broker_decision_on_proposal(
    proposal_id: str,
    payload: _BrokerDecisionCreate,
    session: Session = Depends(get_session),
) -> dict:
    try:
        proposal = record_claim_broker_decision(
            session=session,
            proposal_id=proposal_id,
            broker_id=payload.broker_id,
            decision=payload.decision,
            notes=payload.notes,
        )
    except ClaimProposalValidationError as e:
        message = str(e)
        status = 404 if "Proposal not found" in message else 400
        # Same legacy-contract caveat as the create endpoint above.
        from fastapi import HTTPException
        raise HTTPException(status_code=status, detail=message) from e
    return _proposal_to_dict(proposal)


@router.post("/claim-proposals/{proposal_id}/operator-response")
def operator_info_response_on_proposal(
    proposal_id: str,
    payload: _OperatorInfoResponseCreate,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Operator answers a broker's 'request more info', re-queueing the proposal
    for broker review. Gated on the proposal's venue; an unknown proposal falls
    through to the service's legacy 404 (entity-404 precedes auth)."""
    proposal = session.get(ClaimProposal, proposal_id)
    if proposal is not None:
        require_venue_access(proposal.venue_id, authorization, session)
    try:
        proposal = record_claim_operator_info_response(
            session=session,
            proposal_id=proposal_id,
            operator_id=payload.operator_id,
            response_note=payload.response_note,
        )
    except ClaimProposalValidationError as e:
        message = str(e)
        status = 404 if "Proposal not found" in message else 400
        from fastapi import HTTPException
        raise HTTPException(status_code=status, detail=message) from e
    return _proposal_to_dict(proposal)


# ─── Reads ──────────────────────────────────────────────────────────────


@router.get("/claim-proposals")
def list_claim_proposals(
    venue_id: str | None = None,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Cross-venue claim-proposal list. Authentication required; operators
    are scoped server-side to their own venue(s), brokers/admins see all.
    The frontend still filters as defense-in-depth. Optional `venue_id`
    query param narrows further."""
    user = current_user_optional(authorization)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    statement = select(ClaimProposal).order_by(ClaimProposal.proposed_at.desc())
    if venue_id:
        statement = statement.where(ClaimProposal.venue_id == venue_id)
    proposals = session.exec(statement).all()
    allowed = accessible_venue_ids(user, session)
    if allowed is not None:
        proposals = [p for p in proposals if p.venue_id in allowed]
    return [_proposal_to_dict(p) for p in proposals]


@router.get("/claim-proposals/by-packet/{packet_id}")
def get_claim_for_packet(
    packet_id: str,
    session: Session = Depends(get_session),
) -> dict:
    """Latest claim proposal for a packet, or 404."""
    proposal = session.exec(
        select(ClaimProposal)
        .where(ClaimProposal.packet_id == packet_id)
        .order_by(ClaimProposal.proposed_at.desc())
    ).first()
    if proposal is None:
        # Legacy contract — string detail. See note above.
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="No claim proposal for this packet")
    return _proposal_to_dict(proposal)


# ─── Override stats aggregates ──────────────────────────────────────────


@router.get("/override-stats")
def get_cross_venue_override_stats(session: Session = Depends(get_session)) -> dict:
    """Cross-venue override-accuracy aggregates. Empty DB returns the
    same shape with zeros and None rates — contract stable so the
    frontend can render unconditionally."""
    stats = compute_override_stats(session=session)
    return override_stats_to_dict(stats)


@router.get("/venues/{venue_id}/override-stats")
def get_venue_override_stats(
    venue_id: str,
    session: Session = Depends(get_session),
) -> dict:
    """Per-venue override-accuracy aggregates. Unknown venue is a hard 404."""
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    stats = compute_override_stats(session=session, venue_id=venue_id)
    return override_stats_to_dict(stats)
