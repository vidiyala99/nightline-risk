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
from datetime import date as _date

from sqlmodel import Session, select

from app.models import Carrier, CarrierQuote, ComplianceSignal, IncidentRecord, Submission, Venue
from app.services.submissions import (
    SubmissionsError,
    _transition_carrier_quote,
    record_carrier_response,
)
from app.time import now_utc

logger = logging.getLogger(__name__)

# Quotes still awaiting the carrier's decision (no response yet).
# Quotes the carrier desk shows: awaiting a decision (requested/pending) PLUS
# info_requested ("waiting on broker") so the carrier keeps visibility of what
# they've asked for — surfaced with a distinct status chip in the UI.
AWAITING_QUOTE_STATES: tuple[str, ...] = ("requested", "pending", "info_requested")

_SUBJ_STATUSES = {"open", "met", "waived"}
_MOD_KINDS = {"credit", "debit"}


def _is_money(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def validate_coverage_terms(terms: dict, *, coverage_lines: list[str]) -> None:
    """Validate the structured-terms object stored in CarrierQuote.coverage_terms.
    Raises SubmissionsError on any malformed field. Empty/missing keys are allowed."""
    if not terms:
        return
    lines = terms.get("lines") or {}
    for line_id, spec in lines.items():
        if line_id not in coverage_lines:
            raise SubmissionsError(
                f"terms.lines has '{line_id}' not in the submission's coverage lines"
            )
        for k in ("limit", "deductible"):
            if k in spec and spec[k] is not None and not _is_money(spec[k]):
                raise SubmissionsError(f"terms.lines.{line_id}.{k} must be a money string")
    for subj in terms.get("subjectivities") or []:
        if not (subj.get("text") or "").strip():
            raise SubmissionsError("each subjectivity needs non-empty text")
        if subj.get("status") not in _SUBJ_STATUSES:
            raise SubmissionsError(
                f"subjectivity status must be one of {sorted(_SUBJ_STATUSES)}"
            )
    for key in ("exclusions", "endorsements"):
        if any(not str(x).strip() for x in (terms.get(key) or [])):
            raise SubmissionsError(f"terms.{key} entries must be non-empty strings")
    for mod in terms.get("schedule_mods") or []:
        if mod.get("kind") not in _MOD_KINDS:
            raise SubmissionsError(
                f"schedule_mod kind must be one of {sorted(_MOD_KINDS)}"
            )
        try:
            if float(mod.get("pct")) < 0:
                raise ValueError
        except (TypeError, ValueError):
            raise SubmissionsError("schedule_mod pct must be a number >= 0")
    vu = terms.get("valid_until")
    if vu is not None:
        try:
            parsed = _date.fromisoformat(vu)
        except (TypeError, ValueError):
            raise SubmissionsError("valid_until must be an ISO date (YYYY-MM-DD)")
        if parsed < now_utc().date():
            raise SubmissionsError("valid_until cannot be in the past")


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
        if coverage_terms:
            q = session.get(CarrierQuote, quote_id)
            sub = session.get(Submission, q.submission_id) if q else None
            validate_coverage_terms(coverage_terms, coverage_lines=(sub.coverage_lines if sub else []))
        q = record_carrier_response(
            session, quote_id, status="quoted",
            premium_breakdown=premium_breakdown,
            coverage_terms=coverage_terms,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
            decision_source="carrier_desk",
        )
    elif decision == "decline":
        q = record_carrier_response(
            session, quote_id, status="declined",
            decline_reason=decline_reason,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
            decision_source="carrier_desk",
        )
    else:
        raise SubmissionsError(
            f"Unknown underwriting decision {decision!r} (expected 'quote' or 'decline')"
        )

    # Snapshot what the advisory recommendation WAS vs what the carrier DID
    # (feeds calibration). Failure-isolated — never block the decision.
    try:
        from app.packet_core import _add_audit_event
        dossier = decision_dossier(session, quote_id)
        rec = (dossier or {}).get("underwriting_recommendation")
        if rec is not None:
            followed = (
                (decision == "quote" and rec["posture"] in {"quote", "quote_with_conditions"})
                or (decision == "decline" and rec["posture"] == "decline")
            )
            _add_audit_event(
                session=session,
                actor_id=underwriter_id, actor_type="user",
                entity_type="quote", entity_id=quote_id,
                event_type="quote.underwriting_recommendation",
                event_metadata={
                    "recommended_posture": rec["posture"],
                    "recommended_rate_adequacy": rec["rate_adequacy"],
                    "decision": decision,
                    "followed": followed,
                    "decision_source": "carrier_desk",
                },
            )
    except Exception:  # noqa: BLE001 — advisory telemetry, never block underwriting
        pass

    return q


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
    # Oldest-in-queue first: a decision desk should drain the quote that has
    # been waiting longest, not an arbitrary UUID order. requested_at is the
    # queue-entry time.
    all_quotes = session.exec(
        select(CarrierQuote).order_by(CarrierQuote.requested_at.asc())
    ).all()
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
    # rows already in oldest-first order from the query above.
    return rows


def request_info(session: Session, quote_id: str, *, note: str, underwriter_id: str) -> CarrierQuote:
    """Carrier pauses a quote and asks the broker for missing info."""
    note = (note or "").strip()
    if not note:
        raise SubmissionsError("A request-info note is required.")
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        raise SubmissionsError(f"Quote {quote_id} not found")
    _transition_carrier_quote(
        session, q, to="info_requested", actor_id=underwriter_id,
        metadata={"decision_source": "carrier_desk", "note": note},
    )
    q.info_request_note = note
    q.info_requested_by = underwriter_id
    q.info_requested_at = now_utc().isoformat()
    session.add(q)
    return q


def respond_to_info_request(session: Session, quote_id: str, *, note: str, responder_id: str) -> CarrierQuote:
    """Broker answers the carrier's info request; the quote re-queues to 'pending'."""
    note = (note or "").strip()
    if not note:
        raise SubmissionsError("A response note is required.")
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        raise SubmissionsError(f"Quote {quote_id} not found")
    _transition_carrier_quote(
        session, q, to="pending", actor_id=responder_id,
        metadata={"note": note, "re_queued_from": "info_requested"},
    )
    q.info_response_note = note
    session.add(q)
    return q


# ---------------------------------------------------------------------------
# Decision-dossier composer
# ---------------------------------------------------------------------------

AWAITING_QUOTE_STATES_DECIDABLE = ("requested", "pending", "info_requested")


def decision_dossier(session: Session, quote_id: str) -> dict | None:
    """Full decision context for one quote, composed server-side. Returns None if
    the quote doesn't exist. Every section is failure-isolated (degrades to
    null/empty, never raises out of this function)."""
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        return None
    sub = session.get(Submission, q.submission_id)
    venue_id = sub.venue_id if sub else None
    venue_name, _risk = _venue_read(session, venue_id)
    risk = _full_risk(session, venue_id)
    loss_run = _loss_run_section(session, venue_id)
    suggested_premium_breakdown = _suggested_breakdown(session, sub, q.carrier_id) if sub else None

    # Chain-ladder projected ultimate — advisory, failure-isolated.
    # Only passed to the recommender when the result is credible (≥10 claims).
    _cl_ultimate = None
    try:
        from app.services.loss_development_data import build_development_cells_for_venue
        from app.underwriting.loss_development import compute_chain_ladder
        if venue_id:
            _cells_by_line, _cl_count = build_development_cells_for_venue(session, venue_id)
            if _cells_by_line:
                _all_cells = [c for cells in _cells_by_line.values() for c in cells]
                _cl = compute_chain_ladder(_all_cells, claim_count=_cl_count)
                if _cl.is_credible:
                    _cl_ultimate = _cl.ultimate_total
    except Exception:  # noqa: BLE001
        pass

    from app.services.underwriting_memo import recommendation_from_dossier_parts
    _rec = recommendation_from_dossier_parts(
        risk=risk,
        loss_run=loss_run,
        coverage_lines=(sub.coverage_lines if sub else []),
        suggested_premium_breakdown=suggested_premium_breakdown,
        in_appetite=None,  # appetite wiring is a fast-follow; recommender handles None
        chain_ladder_ultimate=_cl_ultimate,
    )

    return {
        "quote": {
            "id": q.id, "status": q.status,
            "premium_breakdown": q.premium_breakdown, "coverage_terms": q.coverage_terms,
            "decline_reason": q.decline_reason, "underwriter_name": q.underwriter_name,
            "info_request_note": q.info_request_note, "info_response_note": q.info_response_note,
        },
        "submission": {
            "id": sub.id if sub else None, "venue_id": venue_id,
            "effective_date": sub.effective_date.isoformat() if sub and sub.effective_date else None,
            "coverage_lines": sub.coverage_lines if sub else [],
            "requested_limits": sub.requested_limits if sub else {},
            "status": sub.status if sub else None,
        },
        "venue": {"id": venue_id, "name": venue_name, "venue_type": _venue_type(venue_id)},
        "risk": risk,
        "loss_run": loss_run,
        "incidents": _incidents_section(session, venue_id),
        "compliance": _compliance_section(session, venue_id),
        "suggested_premium_breakdown": suggested_premium_breakdown,
        "underwriting_recommendation": _rec.model_dump() if _rec else None,
        "decidable": q.status in AWAITING_QUOTE_STATES_DECIDABLE,
    }


def _venue_type(venue_id):
    from app.seed_data import VENUES
    return VENUES.get(venue_id, {}).get("venue_type", "") if venue_id else ""


def _full_risk(session, venue_id) -> dict:
    try:
        from app.seed_data import VENUES
        from app.underwriting.scoring import get_risk_score
        if venue_id not in VENUES:
            return {"tier": "B", "total_score": 0, "factors": {}}
        r = get_risk_score(venue_id, VENUES, session=session)
        return {"tier": r.get("tier", "B"), "total_score": r.get("total_score", 0), "factors": r.get("factors", {})}
    except Exception:  # noqa: BLE001
        return {"tier": "B", "total_score": 0, "factors": {}}


def _loss_run_section(session, venue_id) -> dict | None:
    try:
        from app.services.loss_run import venue_loss_run
        lr = venue_loss_run(session, venue_id)
        return {"summary": lr["summary"], "by_coverage_line": lr["by_coverage_line"]}
    except Exception:  # noqa: BLE001
        return None


def _incidents_section(session, venue_id) -> dict:
    try:
        rows = session.exec(
            select(IncidentRecord).where(IncidentRecord.venue_id == venue_id)
            .where(IncidentRecord.status == "open")
        ).all()
        recent = sorted(rows, key=lambda i: i.created_at, reverse=True)[:5]
        return {"open_count": len(rows),
                "recent": [{"id": i.id, "summary": i.summary, "occurred_at": i.occurred_at} for i in recent]}
    except Exception:  # noqa: BLE001
        return {"open_count": 0, "recent": []}


def _compliance_section(session, venue_id) -> dict:
    try:
        from app.services.compliance_signals import open_signals_for
        rows = open_signals_for(venue_id, session)
        return {"status": "clear" if not rows else "open_items",
                "open_items": [{"title": r.title, "severity": r.severity} for r in rows]}
    except Exception:  # noqa: BLE001
        return {"status": "unknown", "open_items": []}
