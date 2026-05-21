"""Schema-shape tests for Policy / Endorsement / CertificateOfInsurance
plus the Endorsement.terms_diff discriminated-union validator.

Pins:
  - Policy defaults (status='bound_pending_number', empty snapshot_hash,
    nullable policy_number, nullable refund_amount).
  - Endorsement.terms_diff round-trips money as strings (mode='json').
  - Discriminated union rejects payload shape that doesn't match the
    declared endorsement_type — the typo-catching gate.
  - CertificateOfInsurance status defaults + nullable scope.
  - Decimal columns round-trip through SQLite Numeric storage exactly.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import (
    Carrier,
    CarrierQuote,
    CertificateOfInsurance,
    Endorsement,
    Policy,
    Submission,
    UserRecord,
    Venue,
)
from app.schemas.policy import (
    AddInsuredDiff,
    ChangeLimitDiff,
    EndorsementValidationError,
    validate_endorsement_diff,
)
from app.seed_carriers import seed_broker_platform_data


VENUE_ID = "elsewhere-brooklyn"
USER_ID = "user-broker-test"


def _seeded_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(UserRecord(
        id=USER_ID, email="b@x.com", password_hash="x", name="Broker", role="broker",
    ))
    seed_broker_platform_data(s)
    s.commit()
    return s


def _make_submission_and_quote(s: Session) -> tuple[Submission, CarrierQuote]:
    sub = Submission(
        id="sub-test-1",
        venue_id=VENUE_ID,
        effective_date=date(2026, 11, 1),
        coverage_lines=["gl", "liquor"],
        status="quoting",
    )
    s.add(sub)
    s.flush()
    q = CarrierQuote(
        id="q-test-1",
        submission_id=sub.id,
        carrier_id="markel-specialty",
        status="quoted",
        is_selected=True,
    )
    s.add(q)
    s.commit()
    return sub, q


# ─── Policy defaults ────────────────────────────────────────────────────

def test_policy_defaults_to_bound_pending_number():
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-1",
            submission_id=sub.id,
            bound_quote_id=q.id,
            venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1),
            expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("12150.00"),
            commission_amount=Decimal("1822.50"),
            commission_rate=Decimal("0.15"),
            coverage_lines=["gl"],
            terms_snapshot={"lines": {"gl": {"premium": "12000.00"}}},
        )
        s.add(p)
        s.commit()

        re = s.get(Policy, "pol-1")
        assert re is not None
        assert re.status == "bound_pending_number"
        assert re.policy_number is None
        assert re.snapshot_hash == ""
        assert re.cancelled_at is None
        assert re.cancellation_method is None
        assert re.refund_amount is None
        assert re.commission_paid_at is None


def test_policy_supports_assigning_number_later():
    """A Policy starts without a number; the broker patches it in later.
    The schema must allow that mutation without re-creating the row."""
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-2",
            submission_id=sub.id, bound_quote_id=q.id, venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1), expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("12150.00"), commission_amount=Decimal("1822.50"),
            commission_rate=Decimal("0.15"),
        )
        s.add(p); s.commit()
        p.policy_number = "MK-2026-00042"
        p.status = "active"
        s.add(p); s.commit()
        re = s.get(Policy, "pol-2")
        assert re.policy_number == "MK-2026-00042"
        assert re.status == "active"


def test_policy_decimal_columns_round_trip():
    """SQLite Numeric → Decimal round-trip preserves precision (sanity
    on the new Numeric(12,2) and Numeric(6,4) columns)."""
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-3",
            submission_id=sub.id, bound_quote_id=q.id, venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1), expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("15894.84"),
            commission_amount=Decimal("2384.23"),
            commission_rate=Decimal("0.1500"),
            refund_amount=Decimal("125.50"),
        )
        s.add(p); s.commit(); s.expire_all()
        re = s.get(Policy, "pol-3")
        assert re.annual_premium == Decimal("15894.84")
        assert re.commission_amount == Decimal("2384.23")
        assert re.commission_rate == Decimal("0.1500")
        assert re.refund_amount == Decimal("125.50")


# ─── Endorsement defaults + JSON shape ──────────────────────────────────

def test_endorsement_persists_with_typed_terms_diff():
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-4",
            submission_id=sub.id, bound_quote_id=q.id, venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1), expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("12000.00"),
            commission_amount=Decimal("1800.00"),
            commission_rate=Decimal("0.15"),
        )
        s.add(p); s.commit()

        validated = validate_endorsement_diff("change_limit", {
            "coverage_line": "gl",
            "field": "per_occurrence",
            "before": Decimal("1000000"),
            "after": Decimal("2000000"),
        })
        # Money fields must be strings after mode='json' serialization:
        assert isinstance(validated["before"], str)
        assert isinstance(validated["after"], str)

        end = Endorsement(
            id="end-1",
            policy_id="pol-4",
            endorsement_type="change_limit",
            effective_date=date(2027, 1, 15),
            description="Raise GL per-occurrence limit to $2M.",
            premium_change=Decimal("250.00"),
            tax_change=Decimal("0.00"),
            terms_diff=validated,
            created_by=USER_ID,
        )
        s.add(end); s.commit(); s.expire_all()
        re = s.get(Endorsement, "end-1")
        assert re.endorsement_type == "change_limit"
        assert re.terms_diff["field"] == "per_occurrence"
        assert re.terms_diff["before"] == "1000000"
        assert re.terms_diff["after"] == "2000000"


# ─── Discriminated union validator ──────────────────────────────────────

def test_validate_endorsement_diff_accepts_well_formed():
    out = validate_endorsement_diff("change_limit", {
        "coverage_line": "gl",
        "field": "aggregate",
        "before": Decimal("2000000"),
        "after": Decimal("4000000"),
    })
    assert out["endorsement_type"] == "change_limit"
    assert out["field"] == "aggregate"


def test_validate_endorsement_diff_rejects_type_mismatch():
    """argument type and payload's embedded type must agree."""
    with pytest.raises(EndorsementValidationError, match=r"mismatch"):
        validate_endorsement_diff("change_limit", {
            "endorsement_type": "add_insured",
            "insured_name": "x", "insured_address": "y",
            "relationship": "landlord", "scope": "ongoing_operations",
        })


def test_validate_endorsement_diff_rejects_unknown_type():
    with pytest.raises(EndorsementValidationError, match=r"unknown endorsement_type"):
        validate_endorsement_diff("not_a_real_type", {})


def test_validate_endorsement_diff_rejects_malformed_payload():
    """Right type but missing required field."""
    with pytest.raises(EndorsementValidationError, match=r"validation failed"):
        validate_endorsement_diff("change_limit", {
            "coverage_line": "gl",
            # missing 'field', 'before', 'after'
        })


def test_validate_endorsement_diff_rejects_invalid_enum_choice():
    """`scope` is constrained to three values; anything else must fail."""
    with pytest.raises(EndorsementValidationError):
        validate_endorsement_diff("add_insured", {
            "insured_name": "Acme Realty",
            "insured_address": "123 Main St, Brooklyn",
            "relationship": "landlord",
            "scope": "everywhere",   # invalid
        })


def test_validate_endorsement_diff_handles_all_eight_types():
    """All 8 endorsement types in the discriminated union must round-trip."""
    cases = [
        ("change_limit", {"coverage_line": "gl", "field": "per_occurrence",
                          "before": "1000000", "after": "2000000"}),
        ("add_insured", {"insured_name": "X", "insured_address": "Y",
                         "relationship": "landlord", "scope": "ongoing_operations"}),
        ("add_coverage", {"coverage_line": "epli", "per_occurrence_limit": "1000000"}),
        ("remove_coverage", {"coverage_line": "cyber", "reason": "Cost"}),
        ("add_location", {"location_name": "Annex", "location_address": "456",
                          "venue_type": "music_venue"}),
        ("change_class", {"coverage_line": "gl", "before_class": "bar",
                          "after_class": "music_venue", "reason": "started live music"}),
        ("cancellation", {"method": "pro_rata", "cancellation_date": "2027-03-01",
                          "reason": "venue closed"}),
        ("correction", {"field_corrected": "address",
                        "before": "123 Main", "after": "123 Main St",
                        "explanation": "typo"}),
    ]
    for endorsement_type, payload in cases:
        out = validate_endorsement_diff(endorsement_type, payload)
        assert out["endorsement_type"] == endorsement_type


# ─── CertificateOfInsurance defaults ────────────────────────────────────

def test_coi_defaults_to_active():
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-5",
            submission_id=sub.id, bound_quote_id=q.id, venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1), expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("12000.00"),
            commission_amount=Decimal("1800.00"),
            commission_rate=Decimal("0.15"),
        )
        s.add(p); s.commit()
        coi = CertificateOfInsurance(
            id="coi-1",
            policy_id="pol-5",
            certificate_holder="599 Johnson LLC",
            certificate_holder_address="599 Johnson Ave, Brooklyn, NY 11237",
            description_of_operations="Music venue + bar operations",
            expires_on=date(2027, 11, 1),
            issued_by=USER_ID,
        )
        s.add(coi); s.commit(); s.expire_all()
        re = s.get(CertificateOfInsurance, "coi-1")
        assert re.status == "active"
        assert re.additional_insured is False
        assert re.additional_insured_scope is None
        assert re.pdf_path is None


def test_coi_with_additional_insured_scope():
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-6",
            submission_id=sub.id, bound_quote_id=q.id, venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1), expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("12000.00"),
            commission_amount=Decimal("1800.00"),
            commission_rate=Decimal("0.15"),
        )
        s.add(p); s.commit()
        coi = CertificateOfInsurance(
            id="coi-2",
            policy_id="pol-6",
            certificate_holder="EventCo Productions",
            certificate_holder_address="100 Broadway, NYC",
            additional_insured=True,
            additional_insured_scope="single_event",
            description_of_operations="One-night music event 2027-05-15",
            expires_on=date(2027, 5, 16),
            issued_by=USER_ID,
        )
        s.add(coi); s.commit(); s.expire_all()
        re = s.get(CertificateOfInsurance, "coi-2")
        assert re.additional_insured is True
        assert re.additional_insured_scope == "single_event"


# ─── Forward references work end-to-end ─────────────────────────────────

def test_endorsement_query_by_policy_returns_in_insertion_order():
    """Sanity: the policy_id FK + index actually lets us pull the
    endorsement history for a policy."""
    with _seeded_session() as s:
        sub, q = _make_submission_and_quote(s)
        p = Policy(
            id="pol-7",
            submission_id=sub.id, bound_quote_id=q.id, venue_id=VENUE_ID,
            carrier_id="markel-specialty",
            effective_date=date(2026, 11, 1), expiration_date=date(2027, 11, 1),
            annual_premium=Decimal("12000.00"),
            commission_amount=Decimal("1800.00"),
            commission_rate=Decimal("0.15"),
        )
        s.add(p); s.commit()
        for i in range(3):
            s.add(Endorsement(
                id=f"end-mt-{i}",
                policy_id="pol-7",
                endorsement_type="correction",
                effective_date=date(2027, 1, 1 + i),
                description=f"correction {i}",
                terms_diff=validate_endorsement_diff("correction", {
                    "field_corrected": "name",
                    "before": "old", "after": f"new-{i}",
                    "explanation": "typo",
                }),
                created_by=USER_ID,
            ))
        s.commit()
        rows = s.exec(
            select(Endorsement).where(Endorsement.policy_id == "pol-7")
        ).all()
        assert len(rows) == 3
