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
from decimal import Decimal

from sqlmodel import Session, select

from app.models import Claim, Policy
from app.money import usd


class RenewalsError(Exception):
    """Base error for the renewals service (router maps -> HTTP 400)."""


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
