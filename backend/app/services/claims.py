"""Claims service — Phase 3 (carrier-side claim lifecycle).

A `Claim` row is what's been reported to the carrier. Distinct from
`ClaimProposal`, which is the internal recommendation produced by the
agents. The two are linked by `Claim.proposal_id` when a proposal is
later filed as a real FNOL.

Critical design decisions encoded here:

  1. file_fnol SNAPSHOTS the defense packet. The Phase 3 plan calls for
     the FNOL to set `defense_package_id` so the defense story is
     frozen at the moment of report. The packet has ON DELETE RESTRICT,
     so once a claim references it, the packet is immutable for the
     life of the claim.

  2. Broker RECORDS carrier reserves — never sets them. The function
     is `record_carrier_reserve`, not `set_reserve`. ReserveChange rows
     capture from/to/reason for actuarial reserve-trajectory analysis.

  3. Money is Decimal throughout. ClaimPayment.amount is signed by
     convention: indemnity & expense are positive, recoveries are
     positive but tracked separately and SUBTRACTED at close
     (recoveries_to_date is a positive running total).

  4. close_claim computes total_incurred =
        indemnity_paid_to_date + expense_paid_to_date - recoveries_to_date
     The disposition determines the terminal status: 'paid' → closed_paid,
     'denied' → closed_denied, 'dropped' → closed_dropped. None of those
     are TRULY terminal: a closed claim can transition to 'reopened'.

  5. snapshot_hash captures the claim's financial state at any moment;
     re-hashed on every money/status mutation. Defense packages reference
     a claim's hash to anchor their narrative.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from uuid import uuid4

from sqlmodel import Session, select

from app.lifecycles import (
    CLAIM_STATUS_PRIORITY,
    CLAIM_TRANSITIONS,
    assert_valid_transition,
    status_priority_case,
)
from app.models import (
    Claim,
    ClaimPayment,
    Policy,
    ReserveChange,
    UnderwritingPacket,
)
from app.packet_core import _add_audit_event
from app.time import now_utc


# ─── Errors ──────────────────────────────────────────────────────────────


class ClaimsError(Exception):
    """Base error for the claims service."""


# ─── Snapshot hashing ────────────────────────────────────────────────────


def _compute_claim_snapshot_hash(claim: Claim) -> str:
    """SHA-256 of the canonical JSON of the claim's financial + lifecycle
    state. Re-computed on every mutation (FNOL, reserve change, payment,
    close, reopen)."""
    body = {
        "id": claim.id,
        "policy_id": claim.policy_id,
        "coverage_line": claim.coverage_line,
        "status": claim.status,
        "date_of_loss": claim.date_of_loss.isoformat(),
        "carrier_claim_number": claim.carrier_claim_number,
        "current_reserve": str(claim.current_reserve),
        "indemnity_paid_to_date": str(claim.indemnity_paid_to_date),
        "expense_paid_to_date": str(claim.expense_paid_to_date),
        "recoveries_to_date": str(claim.recoveries_to_date),
        "final_indemnity": str(claim.final_indemnity) if claim.final_indemnity is not None else None,
        "total_incurred": str(claim.total_incurred) if claim.total_incurred is not None else None,
        "reopen_count": claim.reopen_count,
        "defense_package_id": claim.defense_package_id,
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ─── Lifecycle helper ────────────────────────────────────────────────────


def _transition_claim(
    session: Session,
    claim: Claim,
    *,
    to: str,
    actor_id: str,
    metadata: Optional[dict] = None,
) -> Claim:
    from_status = claim.status
    assert_valid_transition(
        CLAIM_TRANSITIONS, from_status, to, entity_name="Claim"
    )
    claim.status = to
    session.add(claim)
    _add_audit_event(
        session=session,
        actor_id=actor_id, actor_type="user",
        entity_type="claim", entity_id=claim.id,
        event_type=f"claim.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )
    return claim


# ─── file_fnol ───────────────────────────────────────────────────────────


def file_fnol(
    session: Session,
    *,
    policy_id: str,
    coverage_line: str,
    date_of_loss: date,
    filed_by: str,
    incident_id: Optional[str] = None,
    proposal_id: Optional[str] = None,
    defense_package_id: Optional[str] = None,
    carrier_claim_number: Optional[str] = None,
    adjuster_name: Optional[str] = None,
    adjuster_email: Optional[str] = None,
) -> Claim:
    """First Notice of Loss. Creates the Claim record (status='notified'),
    snapshots the defense packet at this moment (sets defense_package_id),
    emits claim.fnol audit event. ON DELETE RESTRICT on defense_package_id
    means the snapshot is permanent for as long as the claim exists."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise ClaimsError(f"Unknown Policy {policy_id!r}")
    if policy.status in {"cancelled", "expired", "non_renewed", "lapsed"}:
        raise ClaimsError(
            f"Policy {policy_id!r} is {policy.status!r}; cannot file FNOL on inactive policy"
        )
    if coverage_line not in (policy.coverage_lines or []):
        raise ClaimsError(
            f"coverage_line {coverage_line!r} is not on policy {policy_id!r} "
            f"(policy covers: {policy.coverage_lines})"
        )
    if date_of_loss < policy.effective_date or date_of_loss > policy.expiration_date:
        raise ClaimsError(
            f"date_of_loss {date_of_loss.isoformat()} outside policy term "
            f"({policy.effective_date.isoformat()} – {policy.expiration_date.isoformat()})"
        )
    if date_of_loss > now_utc().date():
        raise ClaimsError(
            f"date_of_loss {date_of_loss.isoformat()} is in the future; "
            "a loss cannot be reported before it occurs"
        )
    if defense_package_id is not None:
        if session.get(UnderwritingPacket, defense_package_id) is None:
            raise ClaimsError(f"Unknown UnderwritingPacket {defense_package_id!r}")

    claim = Claim(
        id=f"clm-{uuid4().hex[:12]}",
        policy_id=policy.id,
        incident_id=incident_id,
        proposal_id=proposal_id,
        carrier_claim_number=carrier_claim_number,
        coverage_line=coverage_line,
        status="notified",
        date_of_loss=date_of_loss,
        fnol_submitted_at=now_utc(),
        adjuster_name=adjuster_name,
        adjuster_email=adjuster_email,
        defense_package_id=defense_package_id,
        snapshot_hash="",
    )
    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session,
        actor_id=filed_by, actor_type="user",
        entity_type="claim", entity_id=claim.id,
        event_type="claim.fnol",
        event_metadata={
            "policy_id": policy.id,
            "coverage_line": coverage_line,
            "date_of_loss": date_of_loss.isoformat(),
            "incident_id": incident_id,
            "proposal_id": proposal_id,
            "defense_package_id": defense_package_id,
            "snapshot_hash": claim.snapshot_hash,
        },
    )
    return claim


# ─── record_carrier_reserve ─────────────────────────────────────────────


def record_carrier_reserve(
    session: Session,
    claim_id: str,
    *,
    new_reserve: Decimal,
    change_reason: str,
    received_from: str,
    received_at: datetime,
    recorded_by: str,
    decision_source: str = "broker_relay",
) -> Claim:
    """Broker records a reserve set/change communicated BY the carrier.
    Brokers don't set reserves; carriers do. Inserts a ReserveChange row
    capturing from/to/reason, updates Claim.current_reserve, re-hashes
    the Claim. Auto-transitions notified/acknowledged → reserved when
    the first reserve is posted."""
    if new_reserve < 0:
        raise ClaimsError("new_reserve cannot be negative")
    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if claim.status in {"closed_paid", "closed_denied", "closed_dropped"}:
        raise ClaimsError(
            f"Claim {claim_id!r} is {claim.status!r}; reopen before adjusting reserves"
        )

    prior = claim.current_reserve
    rc = ReserveChange(
        id=f"rchg-{uuid4().hex[:12]}",
        claim_id=claim.id,
        from_amount=prior,
        to_amount=new_reserve,
        change_reason=change_reason,
        received_from=received_from,
        received_at=received_at,
        recorded_by=recorded_by,
        recorded_at=now_utc(),
    )
    session.add(rc)
    claim.current_reserve = Decimal(new_reserve).quantize(Decimal("0.01"))

    # Auto-advance state when first reserve is posted. A carrier setting a
    # reserve implicitly acknowledges the claim, so notified hops through
    # 'acknowledged' on the way to 'reserved'.
    if claim.status == "notified":
        _transition_claim(
            session, claim, to="acknowledged", actor_id=recorded_by,
            metadata={"implicit": "carrier_set_reserve"},
        )
    if claim.status == "acknowledged":
        _transition_claim(
            session, claim, to="reserved", actor_id=recorded_by,
            metadata={"first_reserve": str(claim.current_reserve)},
        )
    # Coverage-decided-first path: the carrier desk decides coverage (→
    # under_investigation) BEFORE posting a reserve. Posting the reserve from
    # under_investigation must also advance to 'reserved', otherwise the claim
    # is stranded in under_investigation and can never reach settling/closed_paid.
    if claim.status == "under_investigation":
        _transition_claim(
            session, claim, to="reserved", actor_id=recorded_by,
            metadata={"first_reserve": str(claim.current_reserve)},
        )

    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session,
        actor_id=recorded_by, actor_type="user",
        entity_type="claim", entity_id=claim.id,
        event_type="claim.reserve_recorded",
        event_metadata={
            "from_amount": str(prior),
            "to_amount": str(claim.current_reserve),
            "change_reason": change_reason,
            "received_from": received_from,
            "snapshot_hash": claim.snapshot_hash,
            "decision_source": decision_source,
        },
    )
    return claim


# ─── record_payment ─────────────────────────────────────────────────────


_PAYMENT_TYPES = {"indemnity", "expense", "recovery"}


def record_payment(
    session: Session,
    claim_id: str,
    *,
    amount: Decimal,
    payment_type: str,
    paid_on: date,
    description: str,
    recorded_by: str,
    decision_source: str = "broker_relay",
) -> ClaimPayment:
    """Insert a ClaimPayment row and update the matching running total.
    Recoveries are stored as POSITIVE amounts on Claim.recoveries_to_date
    and SUBTRACTED at close.

    Allowed claim statuses: under_investigation, reserved, settling,
    reopened. Closed states reject without an explicit reopen."""
    if payment_type not in _PAYMENT_TYPES:
        raise ClaimsError(
            f"payment_type {payment_type!r} invalid; must be one of {sorted(_PAYMENT_TYPES)}"
        )
    amount = Decimal(amount).quantize(Decimal("0.01"))
    if amount <= 0:
        raise ClaimsError("amount must be > 0 (use payment_type='recovery' for recoveries)")

    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if claim.status in {"notified", "acknowledged", "closed_paid", "closed_denied", "closed_dropped"}:
        raise ClaimsError(
            f"Claim {claim_id!r} is {claim.status!r}; cannot record payments "
            "(needs reserve posted and not closed)"
        )

    payment = ClaimPayment(
        id=f"cpay-{uuid4().hex[:12]}",
        claim_id=claim.id,
        payment_type=payment_type,
        amount=amount,
        paid_on=paid_on,
        description=description,
        recorded_by=recorded_by,
        recorded_at=now_utc(),
    )
    session.add(payment)

    if payment_type == "indemnity":
        claim.indemnity_paid_to_date = (claim.indemnity_paid_to_date + amount).quantize(Decimal("0.01"))
    elif payment_type == "expense":
        claim.expense_paid_to_date = (claim.expense_paid_to_date + amount).quantize(Decimal("0.01"))
    else:  # recovery
        claim.recoveries_to_date = (claim.recoveries_to_date + amount).quantize(Decimal("0.01"))

    # First indemnity payment moves the claim into 'settling'. Reachable from
    # 'reserved' (reserve-first) or 'under_investigation' (coverage-first desk
    # flow where indemnity is paid before a reserve is posted).
    if payment_type == "indemnity" and claim.status in {"reserved", "under_investigation"}:
        _transition_claim(
            session, claim, to="settling", actor_id=recorded_by,
            metadata={"first_indemnity_payment": str(amount)},
        )

    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session,
        actor_id=recorded_by, actor_type="user",
        entity_type="claim", entity_id=claim.id,
        event_type="claim.payment_recorded",
        event_metadata={
            "payment_id": payment.id,
            "payment_type": payment_type,
            "amount": str(amount),
            "paid_on": paid_on.isoformat(),
            "snapshot_hash": claim.snapshot_hash,
            "decision_source": decision_source,
        },
    )
    return payment


# ─── close_claim ────────────────────────────────────────────────────────


_DISPOSITION_TO_STATUS = {
    "paid": "closed_paid",
    "denied": "closed_denied",
    "dropped": "closed_dropped",
}


def close_claim(
    session: Session,
    claim_id: str,
    *,
    disposition: str,
    final_indemnity: Optional[Decimal] = None,
    closed_by: str,
    decision_source: str = "broker_relay",
) -> Claim:
    """disposition: 'paid' | 'denied' | 'dropped'. Computes total_incurred
    = indemnity_paid_to_date + expense_paid_to_date - recoveries_to_date.
    For 'paid' disposition, final_indemnity is REQUIRED. For denied /
    dropped it can be None (no settlement was paid)."""
    if disposition not in _DISPOSITION_TO_STATUS:
        raise ClaimsError(
            f"disposition {disposition!r} invalid; must be one of "
            f"{sorted(_DISPOSITION_TO_STATUS)}"
        )

    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")

    target_status = _DISPOSITION_TO_STATUS[disposition]

    if disposition == "paid" and final_indemnity is None:
        raise ClaimsError("final_indemnity is required when disposition='paid'")
    if final_indemnity is not None:
        final_indemnity = Decimal(final_indemnity).quantize(Decimal("0.01"))
        if final_indemnity < 0:
            raise ClaimsError("final_indemnity cannot be negative")

    total_incurred = (
        claim.indemnity_paid_to_date
        + claim.expense_paid_to_date
        - claim.recoveries_to_date
    ).quantize(Decimal("0.01"))

    claim.final_indemnity = final_indemnity
    claim.total_incurred = total_incurred
    claim.closed_at = now_utc()

    _transition_claim(
        session, claim, to=target_status, actor_id=closed_by,
        metadata={
            "disposition": disposition,
            "final_indemnity": str(final_indemnity) if final_indemnity is not None else None,
            "total_incurred": str(total_incurred),
            "decision_source": decision_source,
        },
    )

    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    # Feed the linked proposal's terminal state (paid|denied) so the operator's
    # status spine reflects the real outcome. Runs in this transaction.
    if claim.proposal_id:
        from app.claim_proposals import settle_proposal_from_claim
        from app.models import ClaimProposal
        prop = session.get(ClaimProposal, claim.proposal_id)
        if prop is not None:
            settle_proposal_from_claim(session=session, proposal=prop, disposition=disposition)

    return claim


# ─── reopen_claim ───────────────────────────────────────────────────────


def reopen_claim(
    session: Session,
    claim_id: str,
    *,
    reason: str,
    reopened_by: str,
) -> Claim:
    """Re-activate a closed claim (subrogation, late discovery, fraud
    investigation). Sets reopened_at to now, increments reopen_count,
    transitions to 'reopened'. Does NOT clear final_indemnity /
    total_incurred — those are historical record. They'll be recomputed
    on the next close."""
    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if claim.status not in {"closed_paid", "closed_denied", "closed_dropped"}:
        raise ClaimsError(
            f"Claim {claim_id!r} is {claim.status!r}; only closed claims can be reopened"
        )

    claim.reopened_at = now_utc()
    claim.reopen_count += 1
    _transition_claim(
        session, claim, to="reopened", actor_id=reopened_by,
        metadata={"reason": reason, "reopen_count": claim.reopen_count},
    )
    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()
    return claim


# ─── attach_defense_package_to_claim ────────────────────────────────────


def attach_defense_package_to_claim(
    session: Session,
    claim_id: str,
    *,
    defense_package_id: str,
    attached_by: str,
) -> Claim:
    """Attach (or replace) the defense package for an existing claim.
    Used when the FNOL was filed without one, or when a fresher packet
    is needed (e.g. mid-litigation). Re-hashes the claim because
    defense_package_id is part of the snapshot."""
    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if session.get(UnderwritingPacket, defense_package_id) is None:
        raise ClaimsError(f"Unknown UnderwritingPacket {defense_package_id!r}")

    prior = claim.defense_package_id
    claim.defense_package_id = defense_package_id
    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session,
        actor_id=attached_by, actor_type="user",
        entity_type="claim", entity_id=claim.id,
        event_type="claim.defense_package_attached",
        event_metadata={
            "prior_defense_package_id": prior,
            "defense_package_id": defense_package_id,
            "snapshot_hash": claim.snapshot_hash,
        },
    )
    return claim


# ─── Read helpers ────────────────────────────────────────────────────────


def claims_for_policy(
    session: Session,
    policy_id: str,
    *,
    status_in: Optional[list[str]] = None,
) -> list[Claim]:
    """List claims for a policy. By default, returns all (claims have no
    truly-terminal states — closed claims can reopen, so the broker
    cares about the whole history)."""
    stmt = select(Claim).where(Claim.policy_id == policy_id)
    if status_in is not None and status_in != ["all"]:
        stmt = stmt.where(Claim.status.in_(status_in))  # type: ignore[attr-defined]
    return list(session.exec(stmt).all())


def list_claims(
    session: Session,
    *,
    status_in: Optional[list[str]] = None,
    venue_id: Optional[str] = None,
    carrier_id: Optional[str] = None,
    open_only: bool = False,
) -> list[Claim]:
    """Cross-policy claim list — drives /api/claims and the broker's
    top-level portfolio + the mobile tab badge for open claims.

    Filters:
      status_in    Explicit status list. ``["all"]`` means no filter.
      venue_id     Join through Policy to filter by venue.
      carrier_id   Join through Policy to filter by carrier.
      open_only    Shorthand — claims whose status is not one of the
                   closed_* terminal-ish states. Lets the mobile tab
                   badge count "what needs attention" with one flag.
                   Mutually exclusive with status_in.
    """
    if open_only and status_in is not None:
        raise ClaimsError("open_only and status_in are mutually exclusive")

    stmt = select(Claim)

    if venue_id is not None or carrier_id is not None:
        stmt = stmt.join(Policy, Claim.policy_id == Policy.id)  # type: ignore[arg-type]
        if venue_id is not None:
            stmt = stmt.where(Policy.venue_id == venue_id)
        if carrier_id is not None:
            stmt = stmt.where(Policy.carrier_id == carrier_id)

    if open_only:
        stmt = stmt.where(Claim.status.notin_(  # type: ignore[attr-defined]
            ["closed_paid", "closed_denied", "closed_dropped"]
        ))
    elif status_in is not None and status_in != ["all"]:
        stmt = stmt.where(Claim.status.in_(status_in))  # type: ignore[attr-defined]

    # Actionable-first: open/reopened claims before closed ones, newest FNOL
    # breaks ties. Without this the carrier book rendered in DB insertion order.
    stmt = stmt.order_by(
        status_priority_case(Claim.status, CLAIM_STATUS_PRIORITY).desc(),
        Claim.fnol_submitted_at.desc(),
    )
    return list(session.exec(stmt).all())


def payments_for_claim(session: Session, claim_id: str) -> list[ClaimPayment]:
    return list(session.exec(
        select(ClaimPayment).where(ClaimPayment.claim_id == claim_id)
    ).all())


def reserve_history_for_claim(session: Session, claim_id: str) -> list[ReserveChange]:
    return list(session.exec(
        select(ReserveChange).where(ReserveChange.claim_id == claim_id)
    ).all())
