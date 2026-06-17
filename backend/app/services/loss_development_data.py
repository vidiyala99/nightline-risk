"""
DB adapter: extract chain-ladder triangle cells from the claims ledger.

Reconstructs incurred-at-age for each (accident_year, dev_age) cell by
querying ClaimPayment and ReserveChange rows at past year-end valuation dates,
then falling back to the Claim's current running-total columns for the latest
diagonal. Groups cells by coverage_line so the pure chain-ladder module can
operate on one line at a time.

Advisory only — never modifies any row. The caller wraps in record_agent_run
for reproducibility; this module is pure read.
"""
from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal

from sqlmodel import Session, select

from app.models import Claim, ClaimPayment, Policy, ReserveChange
from app.underwriting.loss_development import TriangleCell

_ZERO = Decimal("0")


def _paid_at_date(
    session: Session,
    claim_id: str,
    as_of: date,
    *,
    include_types: tuple[str, ...],
) -> Decimal:
    """Sum ClaimPayment amounts of the given types with paid_on ≤ as_of."""
    rows = session.exec(
        select(ClaimPayment).where(
            ClaimPayment.claim_id == claim_id,
            ClaimPayment.payment_type.in_(list(include_types)),
            ClaimPayment.paid_on <= as_of,
        )
    ).all()
    return sum((r.amount for r in rows), _ZERO)


def _reserve_at_date(
    session: Session,
    claim_id: str,
    as_of_dt: datetime,
    *,
    current_reserve: Decimal,
    is_current: bool,
) -> Decimal:
    """Latest ReserveChange.to_amount with received_at ≤ as_of_dt.

    Falls back to the Claim's current_reserve for the latest diagonal when
    no change rows exist yet (the reserve was set directly on the claim).
    """
    rows = session.exec(
        select(ReserveChange)
        .where(
            ReserveChange.claim_id == claim_id,
            ReserveChange.received_at <= as_of_dt,
        )
        .order_by(ReserveChange.received_at.desc())
        .limit(1)
    ).all()
    if rows:
        return rows[0].to_amount
    # No reserve change before this valuation: use current_reserve for the
    # latest diagonal, 0 for past diagonals (reserve hadn't been set yet).
    return current_reserve if is_current else _ZERO


def _incurred_at_date(
    session: Session,
    claim: Claim,
    as_of: date,
    *,
    is_current: bool,
) -> Decimal:
    """Reconstruct incurred = paid(indemnity+expense) - recovery + reserve,
    all as of the given valuation date."""
    if is_current:
        # Use the pre-aggregated running-total columns for the current diagonal
        # to avoid double-counting in-flight payments not yet in ClaimPayment rows.
        return (
            claim.indemnity_paid_to_date
            + claim.expense_paid_to_date
            - claim.recoveries_to_date
            + claim.current_reserve
        )

    paid = _paid_at_date(session, claim.id, as_of,
                         include_types=("indemnity", "expense"))
    recovery = _paid_at_date(session, claim.id, as_of,
                              include_types=("recovery",))
    as_of_dt = datetime.combine(as_of, time.max)
    reserve = _reserve_at_date(
        session, claim.id, as_of_dt,
        current_reserve=claim.current_reserve, is_current=False,
    )
    return paid - recovery + reserve


def build_development_cells_for_venue(
    session: Session,
    venue_id: str,
    *,
    reference_year: int | None = None,
) -> tuple[dict[str, list[TriangleCell]], int]:
    """Return ({coverage_line: [TriangleCell]}, total_claim_count) for a venue.

    Development ages run from 0 (accident year end) to
    (reference_year - accident_year). The latest diagonal uses the claim's
    current running-total columns; past diagonals reconstruct from payment and
    reserve-change history.

    reference_year defaults to the current calendar year.
    """
    ref_year = reference_year or date.today().year
    # Claims are scoped to a venue through their Policy (no direct venue_id column).
    claims = session.exec(
        select(Claim).join(Policy, Claim.policy_id == Policy.id).where(
            Policy.venue_id == venue_id
        )
    ).all()

    if not claims:
        return {}, 0

    cells_by_line: dict[str, list[TriangleCell]] = {}

    for claim in claims:
        ay = claim.date_of_loss.year
        max_dev_age = ref_year - ay
        if max_dev_age < 0:
            # Future-dated loss — skip (shouldn't exist but guard defensively)
            continue

        line = claim.coverage_line
        if line not in cells_by_line:
            cells_by_line[line] = []

        for dev_age in range(max_dev_age + 1):
            is_current = dev_age == max_dev_age
            val_date = date(ay + dev_age, 12, 31)
            incurred = _incurred_at_date(session, claim, val_date, is_current=is_current)

            # Skip zero-incurred cells — they add noise to the triangle without
            # contributing to link-ratio numerators or denominators.
            if incurred <= _ZERO:
                continue

            cells_by_line[line].append(
                TriangleCell(
                    accident_year=ay,
                    dev_age=dev_age,
                    incurred=incurred,
                )
            )

    return cells_by_line, len(claims)
