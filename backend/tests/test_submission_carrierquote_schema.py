"""Schema-shape tests for Submission + CarrierQuote.

These are intentionally narrow: they pin the table shapes (defaults,
nullability, JSON column round-trips) BEFORE any service or API code
exists. Catches schema drift cheaply.

The lifecycle behavior is tested separately (test_lifecycles.py); the
end-to-end submission workflow is tested in test_submissions_service.py
once that service exists.
"""

from datetime import date

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import CarrierQuote, Submission, Venue
from app.seed_carriers import seed_broker_platform_data


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seeded_session() -> Session:
    s = _fresh_session()
    s.add(Venue(id="elsewhere-brooklyn", name="Elsewhere"))
    seed_broker_platform_data(s)
    s.commit()
    return s


# ─── Submission defaults ────────────────────────────────────────────────

def test_submission_defaults_to_open_status():
    with _seeded_session() as s:
        sub = Submission(
            id="sub-1",
            venue_id="elsewhere-brooklyn",
            effective_date=date(2026, 11, 1),
        )
        s.add(sub)
        s.commit()

        reread = s.get(Submission, "sub-1")
        assert reread is not None
        assert reread.status == "open"
        assert reread.coverage_lines == []
        assert reread.requested_limits == {}
        assert reread.notes == ""
        assert reread.submitted_at is None
        assert reread.bound_at is None
        assert reread.created_at is not None
        assert reread.updated_at is not None


def test_submission_assigned_producer_id_optional():
    """assigned_producer_id is nullable for now — initial Phase 1 doesn't
    require producer assignment until the 'producer' RBAC role lands.
    Catches a regression if someone makes the column NOT NULL."""
    with _seeded_session() as s:
        sub = Submission(
            id="sub-2",
            venue_id="elsewhere-brooklyn",
            effective_date=date(2026, 11, 1),
        )
        s.add(sub)
        s.commit()
        assert sub.assigned_producer_id is None


def test_submission_coverage_lines_json_roundtrip():
    """The JSON column stores list-of-strings (CoverageLine.id values).
    Round-trip through SQLite TEXT must preserve order + identity."""
    with _seeded_session() as s:
        sub = Submission(
            id="sub-3",
            venue_id="elsewhere-brooklyn",
            effective_date=date(2026, 11, 1),
            coverage_lines=["gl", "liquor", "epli"],
        )
        s.add(sub)
        s.commit()
        s.expire_all()
        reread = s.get(Submission, "sub-3")
        assert reread is not None
        assert reread.coverage_lines == ["gl", "liquor", "epli"]


def test_submission_requested_limits_json_roundtrip():
    """Per-line limits stored as nested dict with money values AS STRINGS
    (per the plan's JSON serialization decision). Round-trip exactly."""
    limits = {
        "gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "5000"},
        "liquor": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
    }
    with _seeded_session() as s:
        sub = Submission(
            id="sub-4",
            venue_id="elsewhere-brooklyn",
            effective_date=date(2026, 11, 1),
            requested_limits=limits,
        )
        s.add(sub)
        s.commit()
        s.expire_all()
        reread = s.get(Submission, "sub-4")
        assert reread is not None
        assert reread.requested_limits == limits
        # Critically: the money values stayed as strings, not silently
        # converted to floats by the JSON round-trip.
        assert isinstance(reread.requested_limits["gl"]["per_occurrence"], str)


def test_submission_venue_fk_enforced_at_orm_level():
    """The FK is at SQLAlchemy level (Field(foreign_key=...)). SQLite
    doesn't enforce FK constraints by default unless PRAGMA foreign_keys=ON,
    so this test just confirms the relationship is queryable, not that
    the constraint hard-fails. Production Postgres will enforce it."""
    with _seeded_session() as s:
        sub = Submission(
            id="sub-5",
            venue_id="elsewhere-brooklyn",
            effective_date=date(2026, 11, 1),
        )
        s.add(sub)
        s.commit()
        # Reverse query: submissions for this venue.
        results = s.exec(select(Submission).where(Submission.venue_id == "elsewhere-brooklyn")).all()
        assert len(results) >= 1


# ─── CarrierQuote defaults ──────────────────────────────────────────────

def test_carrier_quote_defaults():
    with _seeded_session() as s:
        sub = Submission(id="sub-6", venue_id="elsewhere-brooklyn",
                         effective_date=date(2026, 11, 1))
        s.add(sub)
        s.commit()

        q = CarrierQuote(
            id="q-1",
            submission_id="sub-6",
            carrier_id="markel-specialty",
        )
        s.add(q)
        s.commit()

        reread = s.get(CarrierQuote, "q-1")
        assert reread is not None
        assert reread.status == "requested"
        assert reread.is_selected is False
        assert reread.premium_breakdown == {}
        assert reread.coverage_terms == {}
        assert reread.inputs_snapshot == {}
        assert reread.expires_at is None
        assert reread.responded_at is None
        assert reread.decline_reason is None
        assert reread.requested_at is not None


def test_carrier_quote_inputs_snapshot_roundtrip():
    """inputs_snapshot is the bag of risk_score + loss_run id + venue
    features captured at quote time. JSON round-trip must preserve the
    structure so Phase 7 can re-derive the premium."""
    snapshot = {
        "risk_score": {"total_score": 85, "tier": "A"},
        "loss_run_id": "lr-abc123",
        "venue_features": {"incident_count": 2, "compliance_items": 1},
    }
    with _seeded_session() as s:
        sub = Submission(id="sub-7", venue_id="elsewhere-brooklyn",
                         effective_date=date(2026, 11, 1))
        s.add(sub); s.commit()
        q = CarrierQuote(
            id="q-2",
            submission_id="sub-7",
            carrier_id="markel-specialty",
            inputs_snapshot=snapshot,
        )
        s.add(q); s.commit()
        s.expire_all()
        reread = s.get(CarrierQuote, "q-2")
        assert reread is not None
        assert reread.inputs_snapshot == snapshot


def test_carrier_quote_premium_breakdown_keeps_money_as_strings():
    """The contract from the plan: money inside JSON columns is stored as
    strings via app.money.usd_to_json. JSON round-trip must not convert
    them to floats."""
    breakdown = {
        "lines": {"gl": {"base": "5500.00", "premium": "3850.00"}},
        "fees": {"policy_fee": "150.00"},
        "subtotal": "5500.00",
        "total": "5894.84",
        "commission_rate": "0.15",
    }
    with _seeded_session() as s:
        sub = Submission(id="sub-8", venue_id="elsewhere-brooklyn",
                         effective_date=date(2026, 11, 1))
        s.add(sub); s.commit()
        q = CarrierQuote(
            id="q-3",
            submission_id="sub-8",
            carrier_id="markel-specialty",
            premium_breakdown=breakdown,
        )
        s.add(q); s.commit()
        s.expire_all()
        reread = s.get(CarrierQuote, "q-3")
        assert reread is not None
        assert isinstance(reread.premium_breakdown["total"], str)
        assert reread.premium_breakdown["total"] == "5894.84"


# ─── Multi-quote-per-submission cardinality ─────────────────────────────

def test_one_submission_many_carrier_quotes():
    """The core relationship: one submission goes to multiple carriers,
    each producing its own CarrierQuote row. Query must return all of them."""
    with _seeded_session() as s:
        sub = Submission(id="sub-9", venue_id="elsewhere-brooklyn",
                         effective_date=date(2026, 11, 1))
        s.add(sub); s.commit()
        for cid in ["markel-specialty", "brit-syndicate", "atrium-syndicate"]:
            s.add(CarrierQuote(
                id=f"q-{cid[:5]}-multi",
                submission_id="sub-9",
                carrier_id=cid,
            ))
        s.commit()
        quotes = s.exec(
            select(CarrierQuote).where(CarrierQuote.submission_id == "sub-9")
        ).all()
        assert len(quotes) == 3
        assert {q.carrier_id for q in quotes} == {
            "markel-specialty", "brit-syndicate", "atrium-syndicate"
        }
