"""The carrier quote dossier surfaces an advisory underwriting recommendation,
and underwrite_quote snapshots recommendation-vs-decision to the audit trail.

Fixtures mirror tests/test_underwriting_desk.py (inline-seed a venue +
submission + a CarrierQuote awaiting the desk's decision).
"""
from datetime import date

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, CarrierQuote, Submission, Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.submissions import create_submission, submit_to_market
from app.services.underwriting_desk import decision_dossier, underwrite_quote

VENUE_ID = "elsewhere-brooklyn"


def _well_formed_breakdown(total: str = "4000.00") -> dict:
    return {
        "lines": {
            "gl": {"base": "5500.00", "tier_multiplier": "0.7", "premium": "3850.00"},
        },
        "fees": {"policy_fee": "150.00"},
        "subtotal": "3850.00",
        "total": total,
        "commission_rate": "0.15",
    }


@pytest.fixture
def session_with_quote():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
    seed_broker_platform_data(s)
    s.commit()
    sub = create_submission(
        s, venue_id=VENUE_ID, effective_date=date(2026, 11, 1),
        coverage_lines=["gl", "liquor"],
        requested_limits={"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
        actor_id="u-broker",
    )
    s.commit()
    result = submit_to_market(s, sub.id, target_carriers=["markel-specialty"], submitted_by="u-broker")
    s.commit()
    quote_id = result.quotes_created[0].id
    yield s, quote_id
    s.close()


def test_dossier_includes_underwriting_recommendation(session_with_quote):
    session, quote_id = session_with_quote
    d = decision_dossier(session, quote_id)
    assert "underwriting_recommendation" in d
    rec = d["underwriting_recommendation"]
    # Either a dict with a posture, or None — but the key must exist.
    assert rec is None or rec["posture"] in {"quote", "quote_with_conditions", "decline"}


def test_underwrite_quote_emits_recommendation_snapshot(session_with_quote):
    session, quote_id = session_with_quote
    underwrite_quote(
        session, quote_id, decision="quote", underwriter_id="user_003",
        premium_breakdown=_well_formed_breakdown(), coverage_terms=None,
    )
    session.commit()
    rows = session.exec(select(AuditEvent).where(AuditEvent.entity_id == quote_id)).all()
    snap = [r for r in rows if r.event_type == "quote.underwriting_recommendation"]
    assert snap, "expected a recommendation-snapshot audit event"
    md = snap[0].event_metadata
    assert "recommended_posture" in md and "decision" in md and "followed" in md
