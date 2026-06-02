"""Carrier underwriter desk — Phase 1 of the carrier persona.

Nightline's own underwriting desk: it receives broker submissions (CarrierQuotes
in 'requested'/'pending') and renders the carrier's decision — quote-with-terms
or decline. A thin, role-gated wrapper over `record_carrier_response`, so the
lifecycle, submission escalation, and audit stay single-sourced. This is how the
implicit carrier becomes an in-app persona (vertically-integrated insurer).

Service does not commit — the API layer / test owns commit (broker-platform
convention).
"""
from __future__ import annotations

from sqlmodel import Session, select

from app.models import CarrierQuote, Submission
from app.services.submissions import SubmissionsError, record_carrier_response

# Quotes still awaiting the carrier's decision (no response yet).
AWAITING_QUOTE_STATES: tuple[str, ...] = ("requested", "pending")


def underwrite_quote(
    session: Session,
    quote_id: str,
    *,
    decision: str,
    underwriter_id: str,
    premium_breakdown: dict | None = None,
    coverage_terms: dict | None = None,
    decline_reason: str | None = None,
) -> CarrierQuote:
    """Render the carrier's underwriting decision on a requested quote.

    decision='quote'   → bind terms (premium_breakdown [+ coverage_terms]).
    decision='decline' → decline with a reason.

    Delegates to record_carrier_response so the quote/submission lifecycle and
    audit trail stay single-sourced; attributes the underwriter.
    """
    if decision == "quote":
        return record_carrier_response(
            session, quote_id, status="quoted",
            premium_breakdown=premium_breakdown,
            coverage_terms=coverage_terms,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
        )
    if decision == "decline":
        return record_carrier_response(
            session, quote_id, status="declined",
            decline_reason=decline_reason,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
        )
    raise SubmissionsError(
        f"Unknown underwriting decision {decision!r} (expected 'quote' or 'decline')"
    )


def underwriting_queue(session: Session) -> list[dict]:
    """Every quote awaiting the carrier's decision — one row per pending quote,
    with submission + venue context for the desk. Carrier sees the whole queue
    (it's Nightline's own underwriting desk)."""
    all_quotes = session.exec(select(CarrierQuote)).all()
    rows: list[dict] = []
    for q in all_quotes:
        if q.status not in AWAITING_QUOTE_STATES:
            continue
        sub = session.get(Submission, q.submission_id)
        rows.append({
            "quote_id": q.id,
            "submission_id": q.submission_id,
            "carrier_id": q.carrier_id,
            "venue_id": sub.venue_id if sub else None,
            "coverage_lines": sub.coverage_lines if sub else [],
            "effective_date": sub.effective_date.isoformat() if sub and sub.effective_date else None,
            "status": q.status,
        })
    rows.sort(key=lambda r: r["quote_id"])
    return rows
