"""Surplus-lines filing service. Services raise typed errors and never commit;
the API/test owns the transaction."""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from uuid import uuid4

from sqlmodel import Session, select

from app.lifecycles import SL_FILING_TRANSITIONS, assert_valid_transition
from app.models import Carrier, Declination, Policy, SurplusLinesFiling, Venue
from app.money import usd
from app.packet_core import _add_audit_event
from app.storage import get_storage
from app.surplus_lines_docs import (
    render_diligent_search_affidavit,
    render_nonadmitted_disclosure,
    render_sl_tax_statement,
)
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
    declined_at: date, carrier_naic: str | None = None, recorded_by: str | None = None,
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
    if pol is None:
        raise SurplusLinesError(f"Filing {filing.id!r} references unknown policy {filing.policy_id!r}")
    declines = _declination_count(session, pol.submission_id)
    filing.diligent_search_complete = diligent_search_complete(
        declines, export_list_exempt=filing.export_list_exempt
    )
    filing.updated_at = now_utc()
    session.add(filing)
    session.flush()
    return filing


def _get_filing(session: Session, filing_id: str) -> SurplusLinesFiling:
    row = session.get(SurplusLinesFiling, filing_id)
    if row is None:
        raise SurplusLinesError(f"Unknown filing {filing_id!r}")
    return row


def _transition_filing(
    session: Session, filing: SurplusLinesFiling, *, to: str, actor_id: str, metadata: dict,
) -> None:
    from_status = filing.status
    assert_valid_transition(
        SL_FILING_TRANSITIONS, from_status, to, entity_name="surplus_lines_filing"
    )
    filing.status = to
    filing.updated_at = now_utc()
    session.add(filing)
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="surplus_lines_filing", entity_id=filing.id,
        event_type=f"surplus_lines_filing.{to}",
        event_metadata={"from": from_status, "to": to, **metadata},
    )


def _generate_documents(session: Session, filing: SurplusLinesFiling) -> dict:
    """Render the 3 NY E&S statutory PDFs and persist them via get_storage().

    Returns {kind: storage_ref} where the ref is whatever the storage backend
    stored in place of the bytes (an absolute path for LocalStorage, an object
    key for S3) — retrievable later via get_storage().read(ref)."""
    policy = session.get(Policy, filing.policy_id)
    venue = session.get(Venue, filing.venue_id)
    carrier = session.get(Carrier, policy.carrier_id) if policy else None
    declines = session.exec(
        select(Declination).where(Declination.submission_id == policy.submission_id)
    ).all() if policy else []

    storage = get_storage()
    docs = {
        "affidavit": render_diligent_search_affidavit(filing, declines, venue),
        "tax_statement": render_sl_tax_statement(filing, policy, venue),
        "disclosure": render_nonadmitted_disclosure(filing, policy, venue, carrier),
    }
    paths: dict[str, str] = {}
    for kind, pdf in docs.items():
        key = f"surplus_lines/{filing.id}/{kind}.pdf"
        paths[kind] = storage.save(key, pdf)
    return paths


def file_filing(session: Session, filing_id: str, *, actor_id: str) -> SurplusLinesFiling:
    filing = _get_filing(session, filing_id)
    if not filing.diligent_search_complete:
        raise SurplusLinesError(
            "Cannot file: diligent search incomplete "
            "(need 3 admitted-carrier declinations or an Export-List exemption)"
        )
    filing.documents = _generate_documents(session, filing)
    filing.filed_at = now_utc()
    _transition_filing(session, filing, to="filed", actor_id=actor_id,
                       metadata={"total_charges": str(filing.total_charges)})
    session.flush()
    return filing


def confirm_filing(
    session: Session, filing_id: str, *, transaction_id: str, actor_id: str,
) -> SurplusLinesFiling:
    filing = _get_filing(session, filing_id)
    filing.transaction_id = transaction_id
    filing.confirmed_at = now_utc()
    _transition_filing(session, filing, to="confirmed", actor_id=actor_id,
                       metadata={"transaction_id": transaction_id})
    session.flush()
    return filing


def void_filing(session: Session, filing_id: str, *, reason: str, actor_id: str) -> SurplusLinesFiling:
    filing = _get_filing(session, filing_id)
    _transition_filing(session, filing, to="void", actor_id=actor_id,
                       metadata={"reason": reason})
    session.flush()
    return filing
