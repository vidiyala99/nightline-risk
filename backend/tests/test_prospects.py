"""Tests for prospect generation (real NYC market venues → scored book entries).

A "prospect" is a real NYC nightlife venue (from frontend/public/nyc_market.json)
turned into a Venue with deterministically-generated scoring attributes, so it
flows through the SAME absolute risk engine as book venues. Generation must be
deterministic (seeded by venue id) so a demo is reproducible.
"""
import json

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.prospects import (
    SECURITY_LEVELS,
    convert_prospect_to_book,
    market_venue_to_venue_data,
)
from app.models import AuditEvent, Venue
from app.seed_data import VENUES
from app.underwriting.scoring import RiskScoringEngine


def _sample_market_venue(vid="silvana-001"):
    return {
        "id": vid,
        "name": "SILVANA",
        "address": "300 W 116th St",
        "borough": "Manhattan",
        "lat": 40.80,
        "lng": -73.95,
        "license_class": "OP",
        "venue_type": "nightclub and performance space",
        "market_premium": "12000.00",
        "ts_low": "8000.00",
        "ts_high": "10000.00",
        "savings_low": "2000.00",
        "savings_high": "4000.00",
        "savings_mid": "3000.00",
        "likely_carriers": [
            {"id": "markel-specialty", "name": "Markel Specialty", "market_type": "e&s"},
        ],
    }


def test_marks_source_prospect():
    vd = market_venue_to_venue_data(_sample_market_venue())
    assert vd["source"] == "prospect"


def test_generation_is_deterministic():
    mv = _sample_market_venue()
    a = market_venue_to_venue_data(mv)
    b = market_venue_to_venue_data(mv)
    assert a == b  # same id → byte-identical, reproducible demo


def test_different_ids_can_differ():
    a = market_venue_to_venue_data(_sample_market_venue("venue-a"))
    b = market_venue_to_venue_data(_sample_market_venue("venue-b"))
    # The generated risk attributes are id-seeded; at least one should differ
    # across two distinct ids (guards against a constant generator).
    assert (
        a["incident_count"],
        a["compliance_items"],
        a["security_level"],
        a["years_in_operation"],
        a["capacity"],
    ) != (
        b["incident_count"],
        b["compliance_items"],
        b["security_level"],
        b["years_in_operation"],
        b["capacity"],
    )


def test_scoring_attributes_are_sane():
    vd = market_venue_to_venue_data(_sample_market_venue())
    assert isinstance(vd["incident_count"], int) and 0 <= vd["incident_count"] <= 10
    assert isinstance(vd["compliance_items"], int) and 0 <= vd["compliance_items"] <= 4
    assert vd["security_level"] in SECURITY_LEVELS
    assert isinstance(vd["years_in_operation"], int) and vd["years_in_operation"] >= 1
    assert isinstance(vd["capacity"], int) and vd["capacity"] > 0


def test_carries_market_estimate_for_the_pitch():
    vd = market_venue_to_venue_data(_sample_market_venue())
    assert vd["market_premium"] == "12000.00"
    assert vd["savings_low"] == "2000.00"
    assert vd["savings_high"] == "4000.00"
    assert vd["likely_carriers"][0]["name"] == "Markel Specialty"
    # display fields preserved
    assert vd["name"] == "SILVANA"
    assert vd["address"] == "300 W 116th St"
    assert vd["borough"] == "Manhattan"


def test_prospect_scores_through_the_real_engine():
    """A prospect's generated attributes must produce a valid tier/score from
    the same absolute engine the book uses — no special-casing in scoring."""
    vid = "silvana-001"
    vd = market_venue_to_venue_data(_sample_market_venue(vid))
    engine = RiskScoringEngine({vid: vd})
    result = engine.calculate_score(vid)
    assert 0 <= result.total_score <= 100
    assert result.tier in {"A", "B", "C", "D"}


def test_prospect_does_not_distort_a_book_venue_score():
    """Absolute scoring: adding a prospect to the venues dict must not change a
    book venue's score (guards the 'no portfolio-relative ranking' invariant)."""
    book = {"incident_count": 0, "compliance_items": 0, "security_level": "high",
            "years_in_operation": 12, "prior_carrier": "Admitted A", "venue_type": "music_venue",
            "capacity": 800, "source": "book"}
    alone = RiskScoringEngine({"b1": book}).calculate_score("b1").total_score
    prospect = market_venue_to_venue_data(_sample_market_venue("p1"))
    withp = RiskScoringEngine({"b1": book, "p1": prospect}).calculate_score("b1").total_score
    assert alone == withp


@pytest.fixture()
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_convert_prospect_to_book_flips_source_and_audits(session):
    vid = "prospect-conv-test"
    vd = market_venue_to_venue_data(_sample_market_venue(vid))
    session.add(Venue(id=vid, name=vd["name"], venue_data=json.dumps(vd)))
    session.commit()
    VENUES[vid] = dict(vd)
    try:
        flipped = convert_prospect_to_book(session, vid)
        session.commit()
        assert flipped is True
        assert VENUES[vid]["source"] == "book"
        row = session.get(Venue, vid)
        assert json.loads(row.venue_data)["source"] == "book"
        events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == vid)
        ).all()
        assert any(e.event_type == "venue.converted_to_book" for e in events)
        # idempotent: second call is a no-op
        assert convert_prospect_to_book(session, vid) is False
    finally:
        VENUES.pop(vid, None)
