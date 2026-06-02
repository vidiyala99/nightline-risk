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

import logging

from sqlmodel import Session, select

from app.models import Carrier, CarrierQuote, Submission, Venue
from app.services.submissions import SubmissionsError, record_carrier_response

logger = logging.getLogger(__name__)

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
    audit trail stay single-sourced; attributes the underwriter and stamps the
    audit event with decision_source='carrier_desk' — the trail proving this was
    the carrier exercising delegated authority in-app, not a broker relaying an
    outside quote.
    """
    if decision == "quote":
        return record_carrier_response(
            session, quote_id, status="quoted",
            premium_breakdown=premium_breakdown,
            coverage_terms=coverage_terms,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
            decision_source="carrier_desk",
        )
    if decision == "decline":
        return record_carrier_response(
            session, quote_id, status="declined",
            decline_reason=decline_reason,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
            decision_source="carrier_desk",
        )
    raise SubmissionsError(
        f"Unknown underwriting decision {decision!r} (expected 'quote' or 'decline')"
    )


def _suggested_breakdown(
    session: Session,
    submission: Submission,
    carrier_id: str,
) -> dict | None:
    """Pre-compute the quote the pricing engine *would* produce for this
    submission/carrier so the underwriter can accept-as-suggested in one tap.

    Failure-isolated: an unknown venue, a missing carrier, or any pricing error
    degrades to None (the row still lists) rather than 500-ing the whole queue.
    The engine here is the same `build_quote_for_carrier` the broker's
    build-indicative path uses — single source of truth for rate tables."""
    try:
        from app.seed_data import VENUES
        from app.underwriting.pricing import build_quote_for_carrier
        from app.underwriting.scoring import get_risk_score

        if submission.venue_id not in VENUES:
            return None
        carrier = session.get(Carrier, carrier_id)
        if carrier is None:
            return None
        venue = {**VENUES[submission.venue_id], "id": submission.venue_id}
        risk = get_risk_score(submission.venue_id, VENUES, session=session)
        full_quote = build_quote_for_carrier(
            venue=venue,
            coverage_lines=submission.coverage_lines,
            carrier_id=carrier.id,
            market_type=carrier.market_type,
            risk_score=risk,
            requested_limits=submission.requested_limits,
        )
        return full_quote.to_json_dict()
    except Exception:  # noqa: BLE001 — advisory pre-fill, never block the queue
        logger.warning(
            "Suggested-premium pre-fill failed for quote on submission %s; "
            "row degrades to suggested=None.",
            getattr(submission, "id", "?"),
            exc_info=True,
        )
        return None


def _venue_read(session: Session, venue_id: str | None) -> tuple[str, dict]:
    """Resolve (display_name, risk) for a submission's venue, robust to a
    venue absent from the seed data. risk falls back to neutral Tier B."""
    from app.seed_data import VENUES
    from app.underwriting.scoring import get_risk_score

    name = venue_id or ""
    row = session.get(Venue, venue_id) if venue_id else None
    if row and row.name:
        name = row.name
    elif venue_id in VENUES:
        name = VENUES[venue_id].get("name", venue_id)

    risk = {"tier": "B", "total_score": 0}
    try:
        if venue_id in VENUES:
            r = get_risk_score(venue_id, VENUES, session=session)
            risk = {"tier": r.get("tier", "B"), "total_score": r.get("total_score", 0)}
    except Exception:  # noqa: BLE001
        pass
    return name, risk


def underwriting_queue(session: Session) -> list[dict]:
    """Every quote awaiting the carrier's decision — one row per pending quote,
    with submission + venue context, the calibrated risk read, and the pricing
    engine's suggested premium so the decision form prefills. Carrier sees the
    whole queue (it's Nightline's own underwriting desk)."""
    all_quotes = session.exec(select(CarrierQuote)).all()
    rows: list[dict] = []
    for q in all_quotes:
        if q.status not in AWAITING_QUOTE_STATES:
            continue
        sub = session.get(Submission, q.submission_id)
        venue_id = sub.venue_id if sub else None
        venue_name, risk = _venue_read(session, venue_id)
        suggested = _suggested_breakdown(session, sub, q.carrier_id) if sub else None
        rows.append({
            "quote_id": q.id,
            "submission_id": q.submission_id,
            "carrier_id": q.carrier_id,
            "venue_id": venue_id,
            "venue_name": venue_name,
            "risk": risk,
            "coverage_lines": sub.coverage_lines if sub else [],
            "requested_limits": sub.requested_limits if sub else {},
            "effective_date": sub.effective_date.isoformat() if sub and sub.effective_date else None,
            "status": q.status,
            "suggested_premium_breakdown": suggested,
        })
    rows.sort(key=lambda r: r["quote_id"])
    return rows
