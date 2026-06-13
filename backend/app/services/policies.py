"""Policies service — bind, endorse, cancel, certify.

Builds on the Phase 1 submissions/quotes workflow. The placement loop
ends when the broker calls `bind_quote()`; everything in this module is
the post-bind lifecycle.

Critical design decisions encoded here:

  1. bind_quote is ATOMIC at the caller's transaction boundary. The plan
     calls out 6 sub-effects that must succeed together or all fail. The
     function does NOT open its own savepoint or commit — per the project
     convention the API layer (or test fixture) owns commit/rollback, so a
     mid-bind failure unwinds the whole bind only when the caller rolls
     back. See bind_quote's own docstring for the caller contract.

  2. Policy.snapshot_hash is ONLY re-computed by issue_endorsement.
     Status changes (cancel, expire, lapse) intentionally leave it alone
     so archived defense packages keep their referent. The hash anchors
     a tamper-evident view of contract terms; the operational status is
     mutable metadata.

  3. Endorsement.terms_diff goes through the Pydantic validator. Direct
     writes are an anti-pattern. The service raises if the payload
     shape doesn't match the declared endorsement_type.

  4. Cancellation refunds support two methods. pro_rata is the friendly
     calculation; short_rate is what carriers actually use. Both are
     deterministic given (annual_premium, term_dates, cancellation_date,
     short_rate_penalty).

  5. Certificate of Insurance issuance supersedes prior active COIs to
     the same holder — audit-preserving, never deleting.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
from uuid import uuid4

from sqlmodel import Session, select

from app.defense_package import _as_list
from app.lifecycles import (
    POLICY_TRANSITIONS,
    assert_valid_transition,
)
from app.models import (
    Carrier,
    CarrierQuote,
    CertificateOfInsurance,
    Endorsement,
    Policy,
    Submission,
)
from app.packet_core import _add_audit_event
from app.schemas.policy import (
    EndorsementValidationError,
    validate_endorsement_diff,
)
from app.time import now_utc


# ─── Errors ──────────────────────────────────────────────────────────────


class PoliciesError(Exception):
    """Base error for the policies service."""


class QuoteNotBindableError(PoliciesError):
    """Quote isn't in a state that allows binding (not 'quoted',
    or expired, or not the selected one)."""


# ─── Constants ───────────────────────────────────────────────────────────


# Default short-rate penalty when the cancellation method is short_rate
# and no per-carrier override exists. 10% is the most common nightlife
# convention; the schedule actually varies by carrier and elapsed term
# fraction in production, but a flat penalty is fine for Phase 2.
DEFAULT_SHORT_RATE_PENALTY: Decimal = Decimal("0.10")


# ─── Snapshot hashing ────────────────────────────────────────────────────


def _compute_policy_snapshot_hash(policy: Policy) -> str:
    """SHA-256 of the canonical JSON of the policy's contract terms.

    Re-computed by:
      - bind_quote (on creation)
      - issue_endorsement (after terms_snapshot mutation)
      - assign_policy_number (so the number is part of the anchored snapshot)

    NOT re-computed by status changes (cancel, expire, lapse). The hash
    captures what the venue/carrier agreed to; operational status is
    metadata that lives outside the contract."""
    # Sort list contents so the hash is deterministic from the data alone,
    # not from JSON-storage layer ordering quirks. json.dumps(sort_keys=True)
    # sorts dict keys but NOT list contents — without this, a future
    # SQLAlchemy/Postgres version that ordered list-typed JSON differently
    # could produce hash drift on rows where no actual content changed.
    body = {
        "id": policy.id,
        "policy_number": policy.policy_number,
        "venue_id": policy.venue_id,
        "carrier_id": policy.carrier_id,
        "effective_date": policy.effective_date.isoformat(),
        "expiration_date": policy.expiration_date.isoformat(),
        "annual_premium": str(policy.annual_premium),
        "commission_amount": str(policy.commission_amount),
        "commission_rate": str(policy.commission_rate),
        "coverage_lines": sorted(policy.coverage_lines),
        "terms_snapshot": policy.terms_snapshot,
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ─── Refund math ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CancellationRefund:
    """Result of refund computation."""
    refund_amount: Decimal
    days_in_force: int
    days_remaining: int
    method: str                                       # "pro_rata" | "short_rate"
    short_rate_penalty: Optional[Decimal]             # None for pro_rata


def compute_refund(
    *,
    annual_premium: Decimal,
    effective_date: date,
    expiration_date: date,
    cancellation_date: date,
    method: str,
    short_rate_penalty: Decimal = DEFAULT_SHORT_RATE_PENALTY,
) -> CancellationRefund:
    """Pure function: given dates + premium + method, return the refund.

    pro_rata refund = annual_premium * days_remaining / days_total
    short_rate refund = pro_rata_refund * (1 - short_rate_penalty)

    Raises ValueError on invalid inputs (cancellation before effective,
    expiration before effective, etc.) — the service catches and re-
    raises as PoliciesError."""
    if cancellation_date < effective_date:
        raise ValueError("cancellation_date precedes effective_date")
    if expiration_date <= effective_date:
        raise ValueError("expiration_date must be after effective_date")

    total_days = (expiration_date - effective_date).days
    days_in_force = max(0, (cancellation_date - effective_date).days)
    days_remaining = max(0, total_days - days_in_force)

    if total_days == 0 or days_remaining == 0:
        return CancellationRefund(
            refund_amount=Decimal("0.00"),
            days_in_force=days_in_force,
            days_remaining=0,
            method=method,
            short_rate_penalty=short_rate_penalty if method == "short_rate" else None,
        )

    pro_rata = annual_premium * Decimal(days_remaining) / Decimal(total_days)
    if method == "pro_rata":
        refund = pro_rata
        penalty = None
    elif method == "short_rate":
        refund = pro_rata * (Decimal("1") - short_rate_penalty)
        penalty = short_rate_penalty
    else:
        raise ValueError(f"unknown cancellation method {method!r}")

    # Quantize to cents.
    refund_quantized = refund.quantize(Decimal("0.01"))
    return CancellationRefund(
        refund_amount=refund_quantized,
        days_in_force=days_in_force,
        days_remaining=days_remaining,
        method=method,
        short_rate_penalty=penalty,
    )


# ─── Lifecycle helpers ──────────────────────────────────────────────────


def _transition_policy(
    session: Session,
    policy: Policy,
    *,
    to: str,
    actor_id: str,
    metadata: Optional[dict] = None,
) -> Policy:
    from_status = policy.status
    assert_valid_transition(
        POLICY_TRANSITIONS, from_status, to, entity_name="Policy"
    )
    policy.status = to
    session.add(policy)
    _add_audit_event(
        session=session,
        actor_id=actor_id, actor_type="user",
        entity_type="policy", entity_id=policy.id,
        event_type=f"policy.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )
    # Coverage drift: if this status change flips the venue's coverage on/off,
    # hold or restore its open claim proposals (a proposal routed while covered
    # that loses its policy becomes unfileable — the "Approved · ready to file"
    # vs "Cannot file: no_active_policy" contradiction). Lazy import avoids a
    # claim_proposals ⇄ policies circular at module load.
    from app.claim_proposals import reconcile_proposals_on_coverage_change
    reconcile_proposals_on_coverage_change(
        session, venue_id=policy.venue_id, policy_id=policy.id,
        to_status=to, actor_id=actor_id,
    )
    return policy


# ─── bind_quote ─────────────────────────────────────────────────────────


def bind_quote(
    session: Session,
    quote_id: str,
    *,
    policy_number: Optional[str] = None,
    effective_date: Optional[date] = None,
    term_length_days: int = 365,
    bound_by: str,
) -> Policy:
    """Convert a selected CarrierQuote into a Policy. ATOMIC.

    Six effects, all in one transaction:
      1. Validate quote.is_selected, quote.status in {'quoted', 'pending'},
         and quote.expires_at > now() (else raise QuoteNotBindableError).
      2. Transition the chosen quote to 'bound'.
      3. Transition every OTHER non-terminal quote on the same submission
         to 'withdrawn'.
      4. Transition the submission to 'bound'.
      5. Insert a Policy row (status='bound_pending_number' unless a
         policy_number was provided, in which case 'active'). Compute
         snapshot_hash from the assembled contract terms.
      6. Emit policy.bound audit event with the snapshot_hash.

    Caller wraps in `with session.begin():` or relies on FastAPI's
    session.commit/rollback pattern. The flow does not commit itself —
    any caller-level rollback unwinds the whole bind.
    """
    quote = session.get(CarrierQuote, quote_id)
    if quote is None:
        raise PoliciesError(f"Unknown CarrierQuote {quote_id!r}")
    if not quote.is_selected:
        raise QuoteNotBindableError(
            f"Quote {quote_id!r} is not selected; mark it via select_quote first"
        )
    if quote.status not in {"quoted", "pending"}:
        raise QuoteNotBindableError(
            f"Quote {quote_id!r} status is {quote.status!r}, must be 'quoted' or 'pending' to bind"
        )
    # Expired quotes can't bind. Check expires_at if set.
    if quote.expires_at is not None:
        from app.time import as_utc
        expires = as_utc(quote.expires_at)
        if expires is not None and expires < now_utc():
            raise QuoteNotBindableError(
                f"Quote {quote_id!r} expired at {quote.expires_at}; rebroker or extend"
            )

    sub = session.get(Submission, quote.submission_id)
    if sub is None:
        raise PoliciesError(f"Submission {quote.submission_id!r} missing")
    # The submission must be in 'quoting' state to bind.
    if sub.status != "quoting":
        raise PoliciesError(
            f"Submission {sub.id!r} is in {sub.status!r}; must be 'quoting' to bind"
        )

    from app.services.submissions import _transition_carrier_quote, _transition_submission

    # Step 2: transition the chosen quote.
    _transition_carrier_quote(
        session, quote, to="bound", actor_id=bound_by,
        metadata={"submission_id": sub.id, "bound_carrier": quote.carrier_id},
    )

    # Step 3: withdraw siblings.
    siblings = session.exec(
        select(CarrierQuote).where(
            CarrierQuote.submission_id == sub.id,
            CarrierQuote.id != quote.id,
        )
    ).all()
    for sib in siblings:
        if sib.status in {"requested", "pending", "quoted"}:
            _transition_carrier_quote(
                session, sib, to="withdrawn", actor_id=bound_by,
                metadata={"reason": "submission_bound", "bound_quote_id": quote.id},
            )

    # Step 4: transition submission.
    _transition_submission(
        session, sub, to="bound", actor_id=bound_by,
        metadata={"bound_quote_id": quote.id},
    )
    sub.bound_at = now_utc()
    session.add(sub)

    # Step 5: assemble the Policy. Pull premium + commission from the
    # bound quote's premium_breakdown; the broker may have entered
    # something slightly different from build_quote_for_carrier's
    # indicative number, which is fine — we trust the persisted breakdown.
    breakdown = quote.premium_breakdown or {}
    annual_premium = Decimal(breakdown.get("total", "0.00"))
    commission_amount = Decimal(breakdown.get("commission_amount", "0.00"))
    commission_rate = Decimal(breakdown.get("commission_rate", "0.12"))
    coverage_lines = list((breakdown.get("lines") or {}).keys()) or list(sub.coverage_lines)

    eff = effective_date or sub.effective_date
    expiration = eff + timedelta(days=term_length_days)
    initial_status = "active" if policy_number else "bound_pending_number"

    policy = Policy(
        id=f"pol-{uuid4().hex[:12]}",
        policy_number=policy_number,
        submission_id=sub.id,
        bound_quote_id=quote.id,
        venue_id=sub.venue_id,
        carrier_id=quote.carrier_id,
        status=initial_status,
        effective_date=eff,
        expiration_date=expiration,
        annual_premium=annual_premium,
        commission_amount=commission_amount,
        commission_rate=commission_rate,
        coverage_lines=coverage_lines,
        terms_snapshot={
            "premium_breakdown": breakdown,
            "coverage_terms": quote.coverage_terms or {},
        },
        snapshot_hash="",  # computed below
        bound_at=now_utc(),
    )
    policy.snapshot_hash = _compute_policy_snapshot_hash(policy)
    session.add(policy)
    session.flush()

    # Step 5b: NY E&S placements require a surplus-lines filing. Created
    # atomically with the bind (no separate commit). Admitted carriers exempt.
    carrier = session.get(Carrier, quote.carrier_id)
    if carrier is not None and carrier.market_type == "e&s":
        from app.services.surplus_lines import create_filing_for_policy
        create_filing_for_policy(session, policy, actor_id=bound_by)

    # Step 6: emit the audit event.
    _add_audit_event(
        session=session,
        actor_id=bound_by, actor_type="user",
        entity_type="policy", entity_id=policy.id,
        event_type="policy.bound",
        event_metadata={
            "submission_id": sub.id,
            "carrier_id": quote.carrier_id,
            "snapshot_hash": policy.snapshot_hash,
            "policy_number": policy_number,
            "initial_status": initial_status,
        },
    )
    return policy


# ─── assign_policy_number ───────────────────────────────────────────────


def assign_policy_number(
    session: Session,
    policy_id: str,
    *,
    policy_number: str,
    assigned_by: str,
) -> Policy:
    """Carrier finally sent the policy number. Transitions
    'bound_pending_number' → 'active' and re-hashes the policy (the
    number is part of the anchored snapshot)."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    if policy.status != "bound_pending_number":
        raise PoliciesError(
            f"Policy {policy_id!r} status is {policy.status!r}; "
            f"can only assign policy_number when 'bound_pending_number'"
        )
    if not policy_number.strip():
        raise PoliciesError("policy_number cannot be empty")

    policy.policy_number = policy_number.strip()
    policy.snapshot_hash = _compute_policy_snapshot_hash(policy)
    _transition_policy(
        session, policy, to="active", actor_id=assigned_by,
        metadata={"policy_number": policy.policy_number},
    )
    return policy


# ─── issue_endorsement ───────────────────────────────────────────────────


def issue_endorsement(
    session: Session,
    policy_id: str,
    *,
    endorsement_type: str,
    effective_date: date,
    terms_diff: dict,
    premium_change: Decimal = Decimal("0.00"),
    tax_change: Decimal = Decimal("0.00"),
    description: str = "",
    issued_by: str,
) -> Endorsement:
    """Issue a mid-term endorsement.

    Validates terms_diff against the Pydantic shape for endorsement_type
    (raises PoliciesError on mismatch). Re-hashes the policy because
    terms_snapshot is mutated. policy.annual_premium is adjusted by
    premium_change (signed; refunds are negative)."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    if policy.status not in {"active", "bound_pending_number"}:
        raise PoliciesError(
            f"Policy {policy_id!r} is {policy.status!r}; cannot endorse "
            "(active or bound_pending_number required)"
        )

    try:
        validated = validate_endorsement_diff(endorsement_type, terms_diff)
    except EndorsementValidationError as e:
        raise PoliciesError(f"terms_diff validation failed: {e}")

    # Mutate the policy: append the endorsement to terms_snapshot history
    # and adjust the annual_premium. Re-hash.
    history = policy.terms_snapshot.get("endorsement_history") or []
    history.append({
        "endorsement_type": endorsement_type,
        "effective_date": effective_date.isoformat(),
        "premium_change": str(premium_change),
        "tax_change": str(tax_change),
        "terms_diff": validated,
        "description": description,
    })
    policy.terms_snapshot = {**policy.terms_snapshot, "endorsement_history": history}
    policy.annual_premium = (policy.annual_premium + premium_change).quantize(Decimal("0.01"))

    # Coverage-line endorsements must actually mutate policy.coverage_lines so
    # downstream consumers (the coverage_gap_eo finding, COI generation) see the
    # real set — not just the endorsement history. _as_list coerces the Postgres
    # JSON-string form; reassign a NEW list so SQLAlchemy marks the column dirty.
    # Both add/remove are idempotent so a repeated endorsement can't desync the hash.
    if endorsement_type == "add_coverage":
        line = validated["coverage_line"]
        lines = _as_list(policy.coverage_lines)
        if line not in lines:
            policy.coverage_lines = [*lines, line]
    elif endorsement_type == "remove_coverage":
        line = validated["coverage_line"]
        lines = _as_list(policy.coverage_lines)
        if line in lines:
            policy.coverage_lines = [x for x in lines if x != line]

    policy.snapshot_hash = _compute_policy_snapshot_hash(policy)
    session.add(policy)

    end = Endorsement(
        id=f"end-{uuid4().hex[:12]}",
        policy_id=policy.id,
        endorsement_type=endorsement_type,
        effective_date=effective_date,
        description=description or f"{endorsement_type} endorsement",
        premium_change=premium_change,
        tax_change=tax_change,
        terms_diff=validated,
        issued_at=now_utc(),
        created_by=issued_by,
    )
    session.add(end)
    session.flush()
    _add_audit_event(
        session=session,
        actor_id=issued_by, actor_type="user",
        entity_type="policy", entity_id=policy.id,
        event_type="policy.endorsed",
        event_metadata={
            "endorsement_id": end.id,
            "endorsement_type": endorsement_type,
            "premium_change": str(premium_change),
            "snapshot_hash": policy.snapshot_hash,
        },
    )
    return end


# ─── cancel_policy ───────────────────────────────────────────────────────


def cancel_policy(
    session: Session,
    policy_id: str,
    *,
    reason: str,
    method: str,
    cancellation_date: date,
    cancelled_by: str,
    short_rate_penalty: Decimal = DEFAULT_SHORT_RATE_PENALTY,
) -> Policy:
    """Cancel a policy mid-term and compute the refund.

    method='pro_rata' or 'short_rate'. Returns the policy with
    cancellation_method, cancelled_at, refund_amount populated."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")

    try:
        refund = compute_refund(
            annual_premium=policy.annual_premium,
            effective_date=policy.effective_date,
            expiration_date=policy.expiration_date,
            cancellation_date=cancellation_date,
            method=method,
            short_rate_penalty=short_rate_penalty,
        )
    except ValueError as e:
        raise PoliciesError(str(e))

    policy.cancelled_at = now_utc()
    policy.cancellation_reason = reason
    policy.cancellation_method = method
    policy.refund_amount = refund.refund_amount
    _transition_policy(
        session, policy, to="cancelled", actor_id=cancelled_by,
        metadata={
            "reason": reason,
            "method": method,
            "refund_amount": str(refund.refund_amount),
            "days_in_force": refund.days_in_force,
            "days_remaining": refund.days_remaining,
        },
    )
    return policy


# ─── end-of-life transitions (expire / non-renew / lapse / reinstate) ─────
#
# Status-only mutations: per the snapshot-hash rule they do NOT re-hash the
# policy (the bound terms are unchanged — only its lifecycle state moves).
# The lifecycle matrix enforces legal from-states; an illegal call raises
# InvalidTransitionError (router → 422), distinct from PoliciesError (→ 400).


def expire_policy(
    session: Session,
    policy_id: str,
    *,
    actor_id: str,
    reason: str = "",
) -> Policy:
    """Mark a policy naturally expired at end of term ('active' → 'expired').
    The reachable path that stops expired policies reading 'Active' forever."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    return _transition_policy(
        session, policy, to="expired", actor_id=actor_id,
        metadata={"reason": reason} if reason else None,
    )


def non_renew_policy(
    session: Session,
    policy_id: str,
    *,
    reason: str,
    actor_id: str,
) -> Policy:
    """Carrier/broker chose not to renew ('active' → 'non_renewed'). Reason
    is recorded for renewal analytics (loss ratio, appetite exit)."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    return _transition_policy(
        session, policy, to="non_renewed", actor_id=actor_id,
        metadata={"reason": reason},
    )


def lapse_policy(
    session: Session,
    policy_id: str,
    *,
    reason: str,
    actor_id: str,
) -> Policy:
    """Premium not paid ('active' → 'lapsed'). Unlike the other end states a
    lapse is reversible via reinstate_policy if the carrier accepts payment."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    return _transition_policy(
        session, policy, to="lapsed", actor_id=actor_id,
        metadata={"reason": reason},
    )


def reinstate_policy(
    session: Session,
    policy_id: str,
    *,
    actor_id: str,
    reason: str = "",
) -> Policy:
    """Bring a lapsed policy back in force ('lapsed' → 'active') after the
    carrier accepts late payment. The matrix's only non-terminal exit."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    return _transition_policy(
        session, policy, to="active", actor_id=actor_id,
        metadata={"reason": reason, "reinstated": True} if reason
        else {"reinstated": True},
    )


# ─── issue_certificate ──────────────────────────────────────────────────


def issue_certificate(
    session: Session,
    policy_id: str,
    *,
    certificate_holder: str,
    certificate_holder_address: str,
    description_of_operations: str,
    expires_on: date,
    additional_insured: bool = False,
    additional_insured_scope: Optional[str] = None,
    issued_by: str,
) -> CertificateOfInsurance:
    """Issue a Certificate of Insurance. Supersedes any prior active COI
    to the same certificate_holder on the same policy — audit-preserving
    (sets the prior one's status to 'superseded', never deletes)."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PoliciesError(f"Unknown Policy {policy_id!r}")
    if policy.status not in {"active", "bound_pending_number"}:
        raise PoliciesError(
            f"Policy {policy_id!r} is {policy.status!r}; "
            "cannot issue COI on a cancelled/expired policy"
        )
    if additional_insured and not additional_insured_scope:
        raise PoliciesError(
            "additional_insured=True requires additional_insured_scope "
            "('ongoing_operations' | 'completed_operations' | 'single_event')"
        )
    if additional_insured_scope and additional_insured_scope not in {
        "ongoing_operations", "completed_operations", "single_event",
    }:
        raise PoliciesError(
            f"invalid additional_insured_scope {additional_insured_scope!r}"
        )

    # Supersede prior active COIs to the same holder.
    priors = session.exec(
        select(CertificateOfInsurance).where(
            CertificateOfInsurance.policy_id == policy_id,
            CertificateOfInsurance.certificate_holder == certificate_holder,
            CertificateOfInsurance.status == "active",
        )
    ).all()
    for prior in priors:
        prior.status = "superseded"
        session.add(prior)
        _add_audit_event(
            session=session,
            actor_id=issued_by, actor_type="user",
            entity_type="certificate_of_insurance", entity_id=prior.id,
            event_type="certificate.superseded",
            event_metadata={"reason": "new_coi_issued_to_same_holder"},
        )

    coi = CertificateOfInsurance(
        id=f"coi-{uuid4().hex[:12]}",
        policy_id=policy.id,
        certificate_holder=certificate_holder,
        certificate_holder_address=certificate_holder_address,
        additional_insured=additional_insured,
        additional_insured_scope=additional_insured_scope,
        description_of_operations=description_of_operations,
        status="active",
        issued_at=now_utc(),
        expires_on=expires_on,
        issued_by=issued_by,
    )
    session.add(coi)
    session.flush()
    _add_audit_event(
        session=session,
        actor_id=issued_by, actor_type="user",
        entity_type="certificate_of_insurance", entity_id=coi.id,
        event_type="certificate.issued",
        event_metadata={
            "policy_id": policy.id,
            "certificate_holder": certificate_holder,
            "additional_insured": additional_insured,
            "additional_insured_scope": additional_insured_scope,
            "superseded_count": len(priors),
        },
    )
    return coi


# ─── Read helpers ────────────────────────────────────────────────────────


def policy_for_venue(session: Session, venue_id: str) -> Optional[Policy]:
    """Return the currently-active policy on a venue, if any. Used by the
    /policies list page filtered to a single venue's active coverage."""
    return session.exec(
        select(Policy).where(
            Policy.venue_id == venue_id,
            Policy.status == "active",
        )
    ).first()


def list_policies(
    session: Session,
    *,
    status_in: Optional[list[str]] = None,
    venue_id: Optional[str] = None,
    carrier_id: Optional[str] = None,
) -> list[Policy]:
    """List policies. Default (no status_in): the in-force working book —
    'active' AND 'bound_pending_number' (a just-bound policy whose carrier
    number hasn't landed yet is still real coverage, so it must not vanish
    from /policies). Pass status_in=['all'] explicitly to see full history."""
    # ACTIVE_POLICY_STATUSES is the canonical in-force set; lazy import keeps
    # the services-import-each-other graph acyclic.
    from app.services.fnol import ACTIVE_POLICY_STATUSES

    stmt = select(Policy)
    if status_in is None:
        stmt = stmt.where(Policy.status.in_(tuple(ACTIVE_POLICY_STATUSES)))  # type: ignore[attr-defined]
    elif status_in != ["all"]:
        stmt = stmt.where(Policy.status.in_(status_in))  # type: ignore[attr-defined]
    if venue_id is not None:
        stmt = stmt.where(Policy.venue_id == venue_id)
    if carrier_id is not None:
        stmt = stmt.where(Policy.carrier_id == carrier_id)
    # Actionable-first for an in-force book = soonest-to-lapse on top, so the
    # policy nearest renewal/expiry leads instead of arbitrary insertion order.
    stmt = stmt.order_by(Policy.expiration_date.asc())
    return list(session.exec(stmt).all())
