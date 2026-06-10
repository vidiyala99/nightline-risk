"""Renewals service - experience-rated re-placement of expiring policies.

A renewal is a new Submission (status='open') that points at the expiring
policy via prior_policy_id and carries forward its coverage terms. The
prior term's actual claims are aggregated into a loss ratio (see
compute_loss_experience) which, via pricing.loss_adjustment_from_loss_ratio,
re-prices the renewal's carrier quotes.

Conventions match the broker-platform services: keyword-only args, no
commit inside the service (caller owns the transaction), audit event on
state creation, typed RenewalsError mapped to HTTP 400 by the router."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from app.defense_package import _as_list
from app.lifecycles import SUBMISSION_TERMINAL_STATES
from app.models import Claim, Policy, Submission
from app.money import usd
from app.packet_core import _add_audit_event
from app.services.submissions import create_submission

# A renewal submission that fell through frees the policy to be re-renewed.
# "Lost / declined / withdrawn" are the dead-end terminal states; "bound" is
# terminal too but means the renewal *succeeded*, so it still counts as live
# (the policy has already been renewed — don't let it be renewed again).
_DEAD_RENEWAL_STATES: frozenset[str] = SUBMISSION_TERMINAL_STATES - {"bound"}


class RenewalsError(Exception):
    """Base error for the renewals service (router maps -> HTTP 400)."""


def find_live_renewal(session: Session, policy_id: str) -> Submission | None:
    """The in-flight-or-bound renewal submission for a policy, if any.

    A policy may carry at most one live renewal. A prior renewal that was
    lost / declined / withdrawn is dead and does not count — the policy can
    be renewed afresh."""
    rows = session.exec(
        select(Submission).where(Submission.prior_policy_id == policy_id)
    )
    for sub in rows:
        if sub.status not in _DEAD_RENEWAL_STATES:
            return sub
    return None


@dataclass(frozen=True)
class LossExperience:
    incurred: Decimal
    earned_premium: Decimal
    loss_ratio: Decimal
    claim_count: int


def compute_loss_experience(session: Session, policy_id: str) -> LossExperience:
    """Aggregate the prior term's realized losses for one policy.

    incurred per claim = total_incurred (if set) else
    current_reserve + indemnity_paid + expense_paid - recoveries.
    loss_ratio = incurred / annual_premium; 0 when premium is 0 (no crash)."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise RenewalsError(f"Policy {policy_id} not found")

    claims = list(session.exec(select(Claim).where(Claim.policy_id == policy_id)))
    incurred = Decimal("0.00")
    for c in claims:
        if c.total_incurred is not None:
            incurred += c.total_incurred
        else:
            incurred += (
                c.current_reserve
                + c.indemnity_paid_to_date
                + c.expense_paid_to_date
                - c.recoveries_to_date
            )

    earned = policy.annual_premium
    loss_ratio = (incurred / earned) if earned and earned > 0 else Decimal("0")
    return LossExperience(
        incurred=usd(incurred),
        earned_premium=earned,
        loss_ratio=loss_ratio,
        claim_count=len(claims),
    )


def create_renewal(
    session: Session,
    policy_id: str,
    *,
    effective_date: date,
    actor_id: str = "system",
) -> Submission:
    """Create a renewal Submission (status='open') from an active policy.

    Carries forward coverage_lines + requested_limits from the prior
    submission, links prior_policy_id, emits an audit event. Does NOT
    auto-submit and does NOT change the prior policy's status (that is a
    separate explicit broker action - a renewal term may overlap the old
    one). Caller owns commit/rollback."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise RenewalsError(f"Policy {policy_id} not found")
    if policy.status != "active":
        raise RenewalsError(
            f"Can only renew an active policy; {policy_id} is {policy.status!r}"
        )
    existing = find_live_renewal(session, policy_id)
    if existing is not None:
        raise RenewalsError(
            f"Policy {policy_id} already has a renewal in flight "
            f"({existing.id}, status {existing.status!r}); resolve it first"
        )
    # Carry forward from the originating submission when it still exists (richest
    # data: requested limits + producer). Otherwise fall back to the in-force
    # policy itself — a policy may be imported/migrated or have its originating
    # submission purged, and the policy is the source of truth for what's covered.
    prior_sub = (
        session.get(Submission, policy.submission_id)
        if policy.submission_id else None
    )
    if prior_sub is not None:
        coverage_lines = prior_sub.coverage_lines
        requested_limits = prior_sub.requested_limits
        producer_id = prior_sub.assigned_producer_id
    else:
        coverage_lines = _as_list(policy.coverage_lines)
        requested_limits = {}
        producer_id = None

    sub = create_submission(
        session,
        venue_id=policy.venue_id,
        effective_date=effective_date,
        coverage_lines=coverage_lines,
        requested_limits=requested_limits,
        producer_id=producer_id,
        notes=f"Renewal of {policy_id}",
        actor_id=actor_id,
    )
    sub.prior_policy_id = policy_id
    session.add(sub)
    session.flush()
    _add_audit_event(
        session=session,
        actor_id=actor_id,
        actor_type="user",
        entity_type="submission",
        entity_id=sub.id,
        event_type="submission.renewal_created",
        event_metadata={"prior_policy_id": policy_id, "venue_id": policy.venue_id},
    )
    return sub
