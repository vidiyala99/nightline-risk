"""Carrier underwriter desk — Phase 1 of the carrier persona.

The desk is the in-app owner of the carrier's underwriting decision: it receives
broker submissions (CarrierQuotes in 'requested') and renders a real decision —
quote-with-terms or decline. It's a thin, role-gated wrapper over
`record_carrier_response` (the engine already existed; we're surfacing the
implicit carrier as Nightline's own underwriting desk).

Logic-level tests; route/role tests live in test_underwriting_desk_api.py.
"""
from datetime import date

import pytest
from sqlmodel import Session, SQLModel, create_engine

from sqlmodel import select

from app.models import AuditEvent, CarrierQuote, Submission, Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.submissions import (
    SubmissionsError,
    create_submission,
    record_carrier_response,
    submit_to_market,
)
from app.services.underwriting_desk import underwrite_quote, underwriting_queue, request_info, respond_to_info_request

VENUE_ID = "elsewhere-brooklyn"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
    seed_broker_platform_data(s)
    s.commit()
    return s


def _well_formed_breakdown(total: str = "5894.84") -> dict:
    return {
        "lines": {
            "gl": {"base": "5500.00", "tier_multiplier": "0.7", "premium": "3850.00"},
            "liquor": {"base": "2500.00", "tier_multiplier": "0.7", "premium": "1750.00"},
        },
        "fees": {"policy_fee": "150.00", "surplus_lines_tax": "144.84"},
        "subtotal": "5600.00",
        "total": total,
        "commission_rate": "0.15",
    }


def _requested_quote(s: Session) -> CarrierQuote:
    """Seed a submission in market with one CarrierQuote in 'requested'."""
    sub = create_submission(
        s, venue_id=VENUE_ID, effective_date=date(2026, 11, 1),
        coverage_lines=["gl", "liquor"],
        requested_limits={"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
        actor_id="u-broker",
    )
    s.commit()
    result = submit_to_market(s, sub.id, target_carriers=["markel-specialty"], submitted_by="u-broker")
    s.commit()
    return result.quotes_created[0]


# ─── underwrite_quote ───────────────────────────────────────────────────────

def test_underwrite_accept_quotes_and_escalates_submission():
    with _session() as s:
        q = _requested_quote(s)
        out = underwrite_quote(
            s, q.id, decision="quote",
            premium_breakdown=_well_formed_breakdown(),
            coverage_terms={"gl": {"per_occurrence": "1000000"}},
            underwriter_id="u-carrier",
        )
        s.commit()
        assert out.status == "quoted"
        assert s.get(Submission, q.submission_id).status == "quoting"


def test_underwrite_decline_sets_declined_with_reason():
    with _session() as s:
        q = _requested_quote(s)
        out = underwrite_quote(
            s, q.id, decision="decline",
            decline_reason="Capacity exhausted for late-night liquor exposure.",
            underwriter_id="u-carrier",
        )
        s.commit()
        assert out.status == "declined"
        assert "Capacity" in (out.decline_reason or "")


def test_underwrite_decline_requires_reason():
    with _session() as s:
        q = _requested_quote(s)
        with pytest.raises(SubmissionsError):
            underwrite_quote(s, q.id, decision="decline", underwriter_id="u-carrier")


def test_underwrite_rejects_unknown_decision():
    with _session() as s:
        q = _requested_quote(s)
        with pytest.raises(SubmissionsError):
            underwrite_quote(s, q.id, decision="ponder", underwriter_id="u-carrier")


# ─── decision provenance (delegated-authority audit trail) ──────────────────

def _decision_audit(s: Session, quote_id: str, event_type: str) -> AuditEvent:
    """The audit event emitted for a carrier_quote decision."""
    return s.exec(
        select(AuditEvent)
        .where(AuditEvent.entity_type == "carrier_quote")
        .where(AuditEvent.entity_id == quote_id)
        .where(AuditEvent.event_type == event_type)
    ).one()


def test_carrier_desk_decision_audited_as_carrier_desk():
    """A decision made on the in-app underwriter desk is provably the carrier
    exercising delegated authority — not a broker relaying an outside quote."""
    with _session() as s:
        q = _requested_quote(s)
        underwrite_quote(
            s, q.id, decision="quote",
            premium_breakdown=_well_formed_breakdown(),
            underwriter_id="u-carrier",
        )
        s.commit()
        evt = _decision_audit(s, q.id, "carrier_quote.quoted")
        assert evt.event_metadata["decision_source"] == "carrier_desk"


def test_broker_relay_decision_audited_as_broker_relay():
    """The legacy path — broker keying in what an external carrier said — stays
    distinguishable from an in-app carrier decision in the audit trail."""
    with _session() as s:
        q = _requested_quote(s)
        record_carrier_response(
            s, q.id, status="quoted",
            premium_breakdown=_well_formed_breakdown(),
            recorded_by="u-broker",
        )
        s.commit()
        evt = _decision_audit(s, q.id, "carrier_quote.quoted")
        assert evt.event_metadata["decision_source"] == "broker_relay"


# ─── underwriting_queue ─────────────────────────────────────────────────────

def test_queue_lists_awaiting_quotes():
    with _session() as s:
        q = _requested_quote(s)
        rows = underwriting_queue(s)
        assert any(r["quote_id"] == q.id for r in rows)
        # carries submission + venue context for the desk
        row = next(r for r in rows if r["quote_id"] == q.id)
        assert row["venue_id"] == VENUE_ID
        assert row["submission_id"] == q.submission_id


def test_queue_excludes_decided_quotes():
    with _session() as s:
        q = _requested_quote(s)
        underwrite_quote(
            s, q.id, decision="quote",
            premium_breakdown=_well_formed_breakdown(),
            underwriter_id="u-carrier",
        )
        s.commit()
        rows = underwriting_queue(s)
        assert all(r["quote_id"] != q.id for r in rows)


# ─── queue enrichment (risk + suggested premium for the decision form) ───────

def test_queue_row_carries_venue_name_and_risk():
    """The desk needs venue context + the calibrated risk read (tier + score)
    so the underwriter sees what they're pricing without a second fetch."""
    with _session() as s:
        q = _requested_quote(s)
        row = next(r for r in underwriting_queue(s) if r["quote_id"] == q.id)
        assert row["venue_name"]  # human-readable, not just the id
        assert row["risk"]["tier"] in ("A", "B", "C", "D")
        assert isinstance(row["risk"]["total_score"], (int, float))


def test_queue_row_carries_suggested_premium_breakdown():
    """The eval-gated pricing engine pre-computes a suggested quote so the
    underwriter can accept-as-suggested in one tap — the differentiator."""
    with _session() as s:
        q = _requested_quote(s)
        row = next(r for r in underwriting_queue(s) if r["quote_id"] == q.id)
        suggested = row["suggested_premium_breakdown"]
        assert suggested is not None
        # money stored as strings (broker-platform JSON convention)
        assert isinstance(suggested["total"], str)
        assert suggested["lines"]  # per-line breakdown present


def test_queue_suggested_premium_failure_isolated_for_unknown_venue():
    """An unknown venue degrades the row to suggested=None rather than 500-ing
    the whole queue (Neon-class read-boundary discipline)."""
    with _session() as s:
        q = _requested_quote(s)
        sub = s.get(Submission, q.submission_id)
        sub.venue_id = "venue-not-in-seed-data"
        s.add(sub)
        s.commit()
        row = next(r for r in underwriting_queue(s) if r["quote_id"] == q.id)
        assert row["suggested_premium_breakdown"] is None
        assert row["venue_id"] == "venue-not-in-seed-data"


# ─── request_info + respond_to_info_request ─────────────────────────────────

def test_request_info_pauses_quote_with_note_and_audit():
    with _session() as s:
        q = _requested_quote(s)
        out = request_info(s, q.id, note="Need a current security-staffing roster.", underwriter_id="u-carrier")
        s.commit()
        assert out.status == "info_requested"
        assert "security-staffing" in (out.info_request_note or "")
        evt = _decision_audit(s, q.id, "carrier_quote.info_requested")
        assert evt.event_metadata["decision_source"] == "carrier_desk"


def test_request_info_requires_a_note():
    with _session() as s:
        q = _requested_quote(s)
        with pytest.raises(SubmissionsError):
            request_info(s, q.id, note="  ", underwriter_id="u-carrier")


def test_broker_response_requeues_to_pending():
    with _session() as s:
        q = _requested_quote(s)
        request_info(s, q.id, note="roster?", underwriter_id="u-carrier")
        s.commit()
        out = respond_to_info_request(s, q.id, note="Roster attached: 6 SIA guards.", responder_id="u-broker")
        s.commit()
        assert out.status == "pending"
        assert "6 SIA guards" in (out.info_response_note or "")


# ─── coverage_terms validation in the underwrite path ───────────────────────

def test_underwrite_rejects_malformed_terms():
    with _session() as s:
        q = _requested_quote(s)
        with pytest.raises(SubmissionsError):
            underwrite_quote(
                s, q.id, decision="quote",
                premium_breakdown=_well_formed_breakdown(),
                coverage_terms={"subjectivities": [{"text": "x", "status": "bogus"}]},
                underwriter_id="u-carrier",
            )


def test_underwrite_persists_valid_terms():
    with _session() as s:
        q = _requested_quote(s)
        out = underwrite_quote(
            s, q.id, decision="quote",
            premium_breakdown=_well_formed_breakdown(),
            coverage_terms={"subjectivities": [{"text": "Inspection", "status": "open"}]},
            underwriter_id="u-carrier",
        )
        s.commit()
        assert out.coverage_terms["subjectivities"][0]["status"] == "open"


def test_queue_includes_info_requested_so_carrier_keeps_visibility():
    """A quote the carrier asked info on stays on the desk (waiting on broker),
    surfaced with its info_requested status rather than vanishing."""
    with _session() as s:
        q = _requested_quote(s)
        request_info(s, q.id, note="roster?", underwriter_id="u-carrier")
        s.commit()
        row = next((r for r in underwriting_queue(s) if r["quote_id"] == q.id), None)
        assert row is not None
        assert row["status"] == "info_requested"
