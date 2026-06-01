"""Book financials — the broker's money rollup across the in-force book.

The dashboard/portfolio surface is risk-only (tier, score, open incidents).
This service answers the *money* questions a real brokerage lives in:

  - Written premium     — annual premium summed over the in-force book.
  - Earned premium      — each policy's premium pro-rated by the elapsed
                          fraction of its term (clamped to [0, 1]).
  - Commission revenue  — the broker's cut, summed over the in-force book.
  - Incurred losses     — paid (indemnity + expense) − recoveries + reserve,
                          summed over claims on in-force policies.
  - Loss ratio          — incurred ÷ earned (null when no premium is earned).

Plus per-coverage-line and per-carrier breakdowns. All money is Decimal
internally and serialized as strings; loss ratios are 4-dp strings or None.

"The book" = policies in ACTIVE_POLICY_STATUSES (active + bound_pending_number),
matching the default /api/policies list and the FNOL eligibility check.
"""
from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from app.models import Carrier, Claim, Policy
from app.money import usd, usd_to_json
from app.services.fnol import ACTIVE_POLICY_STATUSES

# Claim statuses that no longer need attention (mirrors services/claims.py).
_CLOSED_CLAIM_STATUSES = {"closed_paid", "closed_denied", "closed_dropped"}

_RATIO_QUANT = Decimal("0.0001")


def _as_dict(value: object) -> dict:
    """Coerce a Column(JSON) value to a dict. Postgres/Neon returns JSON
    columns as strings (SQLite returns parsed dicts) — see the Neon
    JSON-string regression class. Tolerates malformed values."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _earned_fraction(policy: Policy, as_of: date) -> Decimal:
    """Fraction of the policy term elapsed as of `as_of`, clamped to [0, 1]."""
    term_days = (policy.expiration_date - policy.effective_date).days
    if term_days <= 0:
        return Decimal("1")
    elapsed = (as_of - policy.effective_date).days
    if elapsed <= 0:
        return Decimal("0")
    if elapsed >= term_days:
        return Decimal("1")
    return Decimal(elapsed) / Decimal(term_days)


def _incurred(claim: Claim) -> Decimal:
    """Total incurred for a claim: paid out, net of recoveries, plus the
    held reserve — computed from the denormalized running totals."""
    return (
        claim.indemnity_paid_to_date
        + claim.expense_paid_to_date
        - claim.recoveries_to_date
        + claim.current_reserve
    )


def _line_premiums(policy: Policy) -> dict[str, Decimal]:
    """Per-coverage-line premium from the frozen terms snapshot."""
    snapshot = _as_dict(policy.terms_snapshot)
    breakdown = _as_dict(snapshot.get("premium_breakdown"))
    lines = _as_dict(breakdown.get("lines"))
    out: dict[str, Decimal] = {}
    for line, body in lines.items():
        prem = _as_dict(body).get("premium")
        if prem is not None:
            out[line] = usd(prem)
    return out


def _ratio(incurred: Decimal, earned: Decimal) -> str | None:
    """Loss ratio as a 4-dp string, or None when no premium is earned."""
    if earned <= 0:
        return None
    return str((incurred / earned).quantize(_RATIO_QUANT))


def book_financials(session: Session) -> dict:
    """Money rollup across the in-force book (broker-facing)."""
    as_of = date.today()

    policies = list(
        session.exec(select(Policy).where(Policy.status.in_(ACTIVE_POLICY_STATUSES)))  # type: ignore[attr-defined]
    )
    inforce_ids = {p.id for p in policies}

    claims = (
        list(session.exec(select(Claim).where(Claim.policy_id.in_(inforce_ids))))  # type: ignore[attr-defined]
        if inforce_ids
        else []
    )
    carrier_names = {c.id: c.name for c in session.exec(select(Carrier))}
    policy_carrier = {p.id: p.carrier_id for p in policies}

    written = Decimal("0")
    earned = Decimal("0")
    commission = Decimal("0")

    # Per-line and per-carrier accumulators.
    line_written: dict[str, Decimal] = {}
    line_earned: dict[str, Decimal] = {}
    carrier_written: dict[str, Decimal] = {}
    carrier_earned: dict[str, Decimal] = {}
    carrier_commission: dict[str, Decimal] = {}
    carrier_count: dict[str, int] = {}

    for p in policies:
        frac = _earned_fraction(p, as_of)
        written += p.annual_premium
        earned += p.annual_premium * frac
        commission += p.commission_amount

        for line, prem in _line_premiums(p).items():
            line_written[line] = line_written.get(line, Decimal("0")) + prem
            line_earned[line] = line_earned.get(line, Decimal("0")) + prem * frac

        cid = p.carrier_id
        carrier_written[cid] = carrier_written.get(cid, Decimal("0")) + p.annual_premium
        carrier_earned[cid] = carrier_earned.get(cid, Decimal("0")) + p.annual_premium * frac
        carrier_commission[cid] = carrier_commission.get(cid, Decimal("0")) + p.commission_amount
        carrier_count[cid] = carrier_count.get(cid, 0) + 1

    incurred = Decimal("0")
    line_incurred: dict[str, Decimal] = {}
    carrier_incurred: dict[str, Decimal] = {}
    open_claims = 0
    for c in claims:
        loss = _incurred(c)
        incurred += loss
        line_incurred[c.coverage_line] = line_incurred.get(c.coverage_line, Decimal("0")) + loss
        cid = policy_carrier.get(c.policy_id, "")
        carrier_incurred[cid] = carrier_incurred.get(cid, Decimal("0")) + loss
        if c.status not in _CLOSED_CLAIM_STATUSES:
            open_claims += 1

    by_coverage_line = [
        {
            "coverage_line": line,
            "written_premium": usd_to_json(line_written.get(line, Decimal("0"))),
            "earned_premium": usd_to_json(line_earned.get(line, Decimal("0"))),
            "incurred_losses": usd_to_json(line_incurred.get(line, Decimal("0"))),
            "loss_ratio": _ratio(line_incurred.get(line, Decimal("0")), line_earned.get(line, Decimal("0"))),
        }
        for line in sorted(set(line_written) | set(line_incurred))
    ]

    by_carrier = [
        {
            "carrier_id": cid,
            "carrier_name": carrier_names.get(cid, cid),
            "policy_count": carrier_count.get(cid, 0),
            "written_premium": usd_to_json(carrier_written.get(cid, Decimal("0"))),
            "commission": usd_to_json(carrier_commission.get(cid, Decimal("0"))),
            "incurred_losses": usd_to_json(carrier_incurred.get(cid, Decimal("0"))),
            "loss_ratio": _ratio(carrier_incurred.get(cid, Decimal("0")), carrier_earned.get(cid, Decimal("0"))),
        }
        for cid in sorted(carrier_written)
    ]

    return {
        "written_premium": usd_to_json(written),
        "earned_premium": usd_to_json(earned),
        "commission_revenue": usd_to_json(commission),
        "incurred_losses": usd_to_json(incurred),
        "loss_ratio": _ratio(incurred, earned),
        "policy_count": len(policies),
        "open_claim_count": open_claims,
        "by_coverage_line": by_coverage_line,
        "by_carrier": by_carrier,
    }
