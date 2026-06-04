"""Surplus-lines filing service. Services raise typed errors and never commit;
the API/test owns the transaction."""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

from sqlmodel import Session, select

from app.models import Declination, Policy, SurplusLinesFiling
from app.money import usd
from app.packet_core import _add_audit_event
from app.time import now_utc
from app.underwriting.surplus_lines import (
    compute_sl_charges,
    diligent_search_complete,
)

FILING_DEADLINE_DAYS = 45  # NY/ELANY: 45 days from binding


class SurplusLinesError(Exception):
    """Domain error for surplus-lines operations (maps to HTTP 400)."""


def _declination_count(session: Session, submission_id: str) -> int:
    return len(
        session.exec(
            select(Declination).where(Declination.submission_id == submission_id)
        ).all()
    )


def record_declination(
    session: Session, submission_id: str, *, carrier_name: str, reason: str,
    declined_at, carrier_naic: str | None = None, recorded_by: str | None = None,
) -> Declination:
    row = Declination(
        id=f"decl-{uuid4().hex[:12]}", submission_id=submission_id,
        carrier_name=carrier_name, carrier_naic=carrier_naic,
        declined_at=declined_at, reason=reason, recorded_by=recorded_by,
    )
    session.add(row)
    session.flush()
    return row


def create_filing_for_policy(
    session: Session, policy: Policy, *, actor_id: str,
) -> SurplusLinesFiling:
    """Idempotent: returns the existing filing if one exists for the policy."""
    existing = session.exec(
        select(SurplusLinesFiling).where(SurplusLinesFiling.policy_id == policy.id)
    ).first()
    if existing is not None:
        return existing

    bd = (policy.terms_snapshot or {}).get("premium_breakdown", {})
    subtotal = Decimal(bd.get("subtotal", "0.00"))
    policy_fee = Decimal((bd.get("fees", {}) or {}).get("policy_fee", "0.00"))
    base = usd(subtotal + policy_fee)
    charges = compute_sl_charges(base)

    bind_date = (policy.bound_at or now_utc()).date()
    declines = _declination_count(session, policy.submission_id)

    filing = SurplusLinesFiling(
        id=f"slf-{uuid4().hex[:12]}", policy_id=policy.id, venue_id=policy.venue_id,
        taxable_premium=base, surplus_lines_tax=charges.tax,
        stamping_fee=charges.stamping_fee, total_charges=charges.total_charges,
        filing_deadline=bind_date + timedelta(days=FILING_DEADLINE_DAYS),
        diligent_search_complete=diligent_search_complete(declines, export_list_exempt=False),
    )
    session.add(filing)
    session.flush()
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="surplus_lines_filing", entity_id=filing.id,
        event_type="surplus_lines_filing.pending",
        event_metadata={"policy_id": policy.id, "total_charges": str(filing.total_charges)},
    )
    return filing


def recompute_diligent_search(
    session: Session, filing: SurplusLinesFiling,
) -> SurplusLinesFiling:
    pol = session.get(Policy, filing.policy_id)
    declines = _declination_count(session, pol.submission_id) if pol else 0
    filing.diligent_search_complete = diligent_search_complete(
        declines, export_list_exempt=filing.export_list_exempt
    )
    filing.updated_at = now_utc()
    session.add(filing)
    session.flush()
    return filing
