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

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import accessible_venue_ids, current_user_optional, require_broker, require_venue_access
from app.claim_proposals import (
    ClaimProposalValidationError,
    compute_override_stats,
    create_proposal as create_claim_proposal,
    record_broker_cancel_info_request as record_claim_broker_cancel_info_request,
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
    # broker_id is accepted for backwards-compat but ignored — the actor is the
    # authenticated broker from the token, never self-reported body data.
    broker_id: str | None = None
    decision: str
    notes: str | None = None


class _OperatorInfoResponseCreate(BaseModel):
    operator_id: str
    response_note: str


def _coerce_snapshot(snap) -> dict:
    """`recommendation_snapshot` is a JSON column — a parsed dict on SQLite but a
    JSON **string** on Postgres. Coerce to a dict at the read boundary so callers
    can `.get()` safely on both backends (prod was 500ing on the priority sort
    because `.get()` was called on the raw string)."""
    if isinstance(snap, str):
        import json
        try:
            snap = json.loads(snap)
        except (ValueError, TypeError):
            return {}
    return snap if isinstance(snap, dict) else {}


def _proposal_to_dict(proposal) -> dict[str, Any]:
    """Lazy import to avoid the circular at module load: main.py defines
    _claim_proposal_to_dict but also imports this router.

    Augments the base dict with ``recommendation_snapshot`` so broker-inbox
    callers can sort and display confidence/payout data without a second fetch.
    """
    from app.main import _claim_proposal_to_dict as _to_dict
    result = _to_dict(proposal)
    result["recommendation_snapshot"] = _coerce_snapshot(proposal.recommendation_snapshot)
    return result


def _proposal_priority(p: ClaimProposal, now: "datetime | None" = None) -> float:
    """Value (confidence x median payout), boosted as the item ages past a 3-day
    grace so a high-value item ranks first immediately AND an aging item
    eventually surfaces. Missing snapshot sorts last (0). Constants are tunable.
    """
    snap = _coerce_snapshot(p.recommendation_snapshot)
    median = (snap.get("expected_payout") or {}).get("median_usd", 0)
    base_value = float(snap.get("confidence", 0.0)) * float(median)
    if base_value == 0.0:
        return 0.0
    if now is None:
        now = datetime.now(timezone.utc)
    proposed = p.proposed_at
    if proposed is not None and proposed.tzinfo is None:
        proposed = proposed.replace(tzinfo=timezone.utc)
    age_days = ((now - proposed).total_seconds() / 86400.0) if proposed else 0.0
    urgency_factor = 1.0 + 0.15 * max(0.0, age_days - 3.0)
    return base_value * urgency_factor

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
    snapshot = None
    if packet is not None:
        require_venue_access(packet.venue_id, authorization, session)
        # Defense in depth: a high fraud tier suppresses auto-routing
        # (claim_routing.maybe_auto_route_incident returns before creating a
        # proposal). The manual "send to broker" path must honour the same hold —
        # otherwise an operator could push an incident the system deliberately
        # flagged. Coerce the JSON column at the read boundary (Postgres returns
        # it as a string; see project_neon_json_string_regressions).
        fraud_sig = packet.fraud_signal
        if isinstance(fraud_sig, str):
            import json
            try:
                fraud_sig = json.loads(fraud_sig)
            except (ValueError, TypeError):
                fraud_sig = None
        if isinstance(fraud_sig, dict) and fraud_sig.get("tier") == "high":
            from fastapi import HTTPException
            raise HTTPException(
                status_code=409,
                detail="Held for fraud review — this incident can't be sent to the broker until it clears review.",
            )
        from app.claim_routing import recommendation_for_packet
        from app.claim_recommendation import recommendation_to_dict
        snapshot = recommendation_to_dict(recommendation_for_packet(session, packet))
    try:
        proposal = create_claim_proposal(
            session=session,
            packet_id=packet_id,
            operator_id=payload.operator_id,
            override_recommendation=payload.override_recommendation,
            override_reason=payload.override_reason,
            override_freetext=payload.override_freetext,
            recommendation_snapshot=snapshot,
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
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    # Deciding a claim proposal is a broker-only action. Gate on broker role and
    # record the *authenticated* broker as the actor — the body broker_id was
    # previously unverified, which let an operator (or anyone) approve a claim.
    broker = require_broker(authorization)
    try:
        proposal = record_claim_broker_decision(
            session=session,
            proposal_id=proposal_id,
            broker_id=broker["sub"],
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


@router.post("/claim-proposals/{proposal_id}/cancel-info-request")
def cancel_info_request_on_proposal(
    proposal_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Broker withdraws their own 'request more info', re-queueing the proposal
    for their own decision instead of waiting on the operator. Broker-only —
    this is the escape hatch from a needs_more_info proposal that's gone stale."""
    broker = require_broker(authorization)
    try:
        proposal = record_claim_broker_cancel_info_request(
            session=session,
            proposal_id=proposal_id,
            broker_id=broker["sub"],
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
    status: str | None = None,
    sort: str | None = None,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Cross-venue claim-proposal list. Authentication required; operators
    are scoped server-side to their own venue(s), brokers/admins see all.
    The frontend still filters as defense-in-depth.

    Optional query params:
    - ``venue_id``: narrows to a single venue.
    - ``status``: filters by ``ClaimProposal.state`` (e.g. ``pending_broker_review``).
    - ``sort``: ``priority`` sorts by confidence × median_payout descending
      (broker inbox view); default is newest-first.
    """
    user = current_user_optional(authorization)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    statement = select(ClaimProposal).order_by(ClaimProposal.proposed_at.desc())
    if venue_id:
        statement = statement.where(ClaimProposal.venue_id == venue_id)
    if status:
        statement = statement.where(ClaimProposal.state == status)
    proposals = session.exec(statement).all()
    allowed = accessible_venue_ids(user, session)
    if allowed is not None:
        proposals = [p for p in proposals if p.venue_id in allowed]
    if sort == "priority":
        proposals = sorted(proposals, key=_proposal_priority, reverse=True)
    return [_proposal_to_dict(p) for p in proposals]


@router.get("/claim-proposals/{proposal_id}/fnol-draft")
def fnol_draft(
    proposal_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Return the resolved FNOL defaults for an approved claim proposal.

    Surfaces the policy, coverage line, date-of-loss, and any blockers so
    the broker can confirm rather than type when filing with the carrier.
    """
    proposal = session.get(ClaimProposal, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    require_venue_access(proposal.venue_id, authorization, session)
    from app.services.fnol import resolve_fnol_defaults
    d = resolve_fnol_defaults(session, proposal)
    return {
        "policy_id": d["policy_id"],
        "coverage_line": d["coverage_line"],
        "date_of_loss": d["date_of_loss"].isoformat() if d["date_of_loss"] else None,
        "blockers": d["blockers"],
        "notes": d["notes"],
    }


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
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Per-venue override-accuracy aggregates. Unknown venue is a hard 404.

    Venue-scoped like its siblings (risk-score / quote / incident-counts):
    the owning operator + brokers may read it; anyone else is 403."""
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    require_venue_access(venue_id, authorization, session)
    stats = compute_override_stats(session=session, venue_id=venue_id)
    return override_stats_to_dict(stats)


# ─── FNOL bridge ────────────────────────────────────────────────────────


@router.post("/claim-proposals/{proposal_id}/file-fnol", status_code=201)
def file_fnol_for_proposal(
    proposal_id: str,
    payload: dict,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Create the carrier-side Claim from an approved ClaimProposal and
    advance the proposal to 'filed_with_carrier'.

    Body: { policy_id, coverage_line, date_of_loss (ISO), broker_id }
    Returns: { claim: <claim dict>, proposal_state: "filed_with_carrier" }
    """
    from datetime import date as _date

    proposal = session.get(ClaimProposal, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    require_venue_access(proposal.venue_id, authorization, session)
    if proposal.state != "approved":
        raise HTTPException(
            status_code=422,
            detail={
                "error": "not_approved",
                "message": (
                    f"Proposal must be 'approved' to file (state={proposal.state})"
                ),
            },
        )

    packet = session.get(UnderwritingPacket, proposal.packet_id)

    from app.services.claims import file_fnol
    from app.claim_proposals import mark_proposal_filed
    from app.api.v1.claims import _claim_to_dict

    try:
        claim = file_fnol(
            session,
            policy_id=payload["policy_id"],
            coverage_line=payload["coverage_line"],
            date_of_loss=_date.fromisoformat(payload["date_of_loss"]),
            filed_by=payload.get("broker_id", "broker"),
            incident_id=packet.incident_id if packet else None,
            proposal_id=proposal_id,
        )
    except Exception as e:
        raise HTTPException(
            status_code=422,
            detail={"error": "fnol_failed", "message": str(e)},
        ) from e

    # file_fnol uses session.flush() only — commit before mark_proposal_filed
    # so the Claim row is persisted before the proposal state advances.
    session.commit()
    session.refresh(claim)

    mark_proposal_filed(
        session=session,
        proposal_id=proposal_id,
        broker_id=payload.get("broker_id", "broker"),
    )

    return {"claim": _claim_to_dict(claim), "proposal_state": "filed_with_carrier"}
