"""Carrier detail — identity, appetite tags, and the book placed with them.

Answers "what is this carrier doing in our book?": their appetite (the classes
/ capacity / lines they write) plus the money rollup for policies placed with
them (count, written/earned premium, commission, incurred losses, loss ratio)
and the policy list. Drill-down target for the Book Financials "By carrier"
rows.

Money is Decimal internally, serialized as strings; loss ratio is a 4-dp
string or None.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from app.models import Carrier, Claim, Policy
from app.money import usd_to_json
from app.services.fnol import ACTIVE_POLICY_STATUSES

_RATIO_QUANT = Decimal("0.0001")
# Shared loss math — same formula as services/book.py + services/loss_run.py
# (incurred = paid + reserve − recoveries; earned = premium × elapsed term).
# Replicated rather than cross-imported to keep services loosely coupled.


class CarrierError(Exception):
    """Carrier not found / invalid carrier operation."""


def _earned_fraction(policy: Policy, as_of: date) -> Decimal:
    term_days = (policy.expiration_date - policy.effective_date).days
    if term_days <= 0:
        return Decimal("1")
    elapsed = (as_of - policy.effective_date).days
    if elapsed <= 0:
        return Decimal("0")
    if elapsed >= term_days:
        return Decimal("1")
    return Decimal(elapsed) / Decimal(term_days)


def _incurred(c: Claim) -> Decimal:
    return (
        c.indemnity_paid_to_date
        + c.expense_paid_to_date
        - c.recoveries_to_date
        + c.current_reserve
    )


def carrier_detail(session: Session, carrier_id: str) -> dict:
    carrier = session.get(Carrier, carrier_id)
    if carrier is None:
        raise CarrierError(f"Carrier {carrier_id!r} not found")

    as_of = date.today()
    appetite = carrier.appetite or {}

    policies = list(
        session.exec(
            select(Policy)
            .where(Policy.carrier_id == carrier_id)
            .where(Policy.status.in_(ACTIVE_POLICY_STATUSES))  # type: ignore[attr-defined]
        )
    )
    inforce_ids = {p.id for p in policies}
    claims = (
        list(session.exec(select(Claim).where(Claim.policy_id.in_(inforce_ids))))  # type: ignore[attr-defined]
        if inforce_ids
        else []
    )

    written = sum((p.annual_premium for p in policies), Decimal("0"))
    earned = sum((p.annual_premium * _earned_fraction(p, as_of) for p in policies), Decimal("0"))
    commission = sum((p.commission_amount for p in policies), Decimal("0"))
    incurred = sum((_incurred(c) for c in claims), Decimal("0"))
    loss_ratio = str((incurred / earned).quantize(_RATIO_QUANT)) if earned > 0 else None

    policy_rows = [
        {
            "policy_id": p.id,
            "policy_number": p.policy_number,
            "venue_id": p.venue_id,
            "status": p.status,
            "annual_premium": usd_to_json(p.annual_premium),
            "effective_date": p.effective_date.isoformat(),
            "expiration_date": p.expiration_date.isoformat(),
        }
        for p in sorted(policies, key=lambda p: p.annual_premium, reverse=True)
    ]

    return {
        "carrier": {
            "id": carrier.id,
            "name": carrier.name,
            "market_type": carrier.market_type,
            "naic_code": carrier.naic_code,
            "am_best_rating": carrier.am_best_rating,
            "contact_email": carrier.contact_email,
        },
        "appetite": {
            "venue_types": appetite.get("venue_types", []),
            "max_capacity": appetite.get("max_capacity"),
            "coverage_lines": appetite.get("coverage_lines", []),
        },
        "book": {
            "policy_count": len(policies),
            "written_premium": usd_to_json(written),
            "earned_premium": usd_to_json(earned),
            "commission": usd_to_json(commission),
            "incurred_losses": usd_to_json(incurred),
            "loss_ratio": loss_ratio,
        },
        "policies": policy_rows,
    }
