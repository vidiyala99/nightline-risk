"""Tests for app/services/claims.py — Phase 3 carrier-side claim lifecycle.

Coverage:
  - file_fnol: policy validation, coverage_line check, date_of_loss bounds,
    defense package snapshot, audit event, snapshot_hash
  - record_carrier_reserve: ReserveChange row creation, running total,
    auto-transition notified → reserved
  - record_payment: indemnity/expense/recovery accumulation,
    auto-transition reserved → settling on first indemnity
  - close_claim: disposition mapping, total_incurred formula,
    final_indemnity required for 'paid'
  - reopen_claim: closed states only, increments reopen_count
  - snapshot_hash determinism + drift on mutation
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.lifecycles import InvalidTransitionError
from app.models import (
    Claim,
    ClaimPayment,
    Policy,
    ReserveChange,
    UserRecord,
    Venue,
)
from app.services.claims import (
    ClaimsError,
    _compute_claim_snapshot_hash,
    attach_defense_package_to_claim,
    claims_for_policy,
    close_claim,
    file_fnol,
    list_claims,
    payments_for_claim,
    record_carrier_reserve,
    record_payment,
    reopen_claim,
    reserve_history_for_claim,
)


VENUE_ID = "elsewhere-brooklyn"
USER_ID = "user-broker-test"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(UserRecord(
        id=USER_ID, email="b@x.com", password_hash="x", name="Broker", role="broker",
    ))
    s.commit()
    return s


def _active_policy(s: Session, *, lines: list[str] | None = None) -> Policy:
    """Insert a minimal active policy. Skips the bind workflow so claims
    tests stay focused on claim mechanics."""
    p = Policy(
        id="pol-test-1",
        policy_number="POL-2026-0001",
        submission_id="sub-test-1",
        bound_quote_id="q-test-1",
        venue_id=VENUE_ID,
        carrier_id="markel-specialty",
        status="active",
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("5000.00"),
        commission_amount=Decimal("750.00"),
        commission_rate=Decimal("0.15"),
        coverage_lines=lines or ["gl", "liquor"],
        terms_snapshot={},
        snapshot_hash="hash-test",
    )
    s.add(p); s.commit()
    return p


# ─── file_fnol ──────────────────────────────────────────────────────────


def test_file_fnol_creates_claim_in_notified_state():
    s = _session()
    pol = _active_policy(s)
    claim = file_fnol(
        s, policy_id=pol.id, coverage_line="gl",
        date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
    )
    s.commit()
    assert claim.status == "notified"
    assert claim.policy_id == pol.id
    assert claim.coverage_line == "gl"
    assert claim.snapshot_hash != ""
    assert claim.id.startswith("clm-")


def test_file_fnol_rejects_unknown_policy():
    s = _session()
    with pytest.raises(ClaimsError, match="Unknown Policy"):
        file_fnol(
            s, policy_id="nope", coverage_line="gl",
            date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
        )


def test_file_fnol_rejects_coverage_line_not_on_policy():
    s = _session()
    pol = _active_policy(s, lines=["gl"])
    with pytest.raises(ClaimsError, match="not on policy"):
        file_fnol(
            s, policy_id=pol.id, coverage_line="liquor",
            date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
        )


def test_file_fnol_rejects_date_of_loss_outside_term():
    s = _session()
    pol = _active_policy(s)
    with pytest.raises(ClaimsError, match="outside policy term"):
        file_fnol(
            s, policy_id=pol.id, coverage_line="gl",
            date_of_loss=date(2025, 12, 31), filed_by=USER_ID,
        )


def test_file_fnol_rejects_inactive_policy():
    s = _session()
    pol = _active_policy(s)
    pol.status = "cancelled"
    s.add(pol); s.commit()
    with pytest.raises(ClaimsError, match="cannot file FNOL"):
        file_fnol(
            s, policy_id=pol.id, coverage_line="gl",
            date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
        )


def test_file_fnol_rejects_unknown_defense_package_id():
    s = _session()
    pol = _active_policy(s)
    with pytest.raises(ClaimsError, match="Unknown UnderwritingPacket"):
        file_fnol(
            s, policy_id=pol.id, coverage_line="gl",
            date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
            defense_package_id="pkt-nope",
        )


# ─── record_carrier_reserve ─────────────────────────────────────────────


def _filed_claim(s: Session) -> Claim:
    pol = _active_policy(s)
    return file_fnol(
        s, policy_id=pol.id, coverage_line="gl",
        date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
    )


def test_record_carrier_reserve_creates_reserve_change_row():
    s = _session()
    claim = _filed_claim(s)
    s.commit()

    updated = record_carrier_reserve(
        s, claim.id,
        new_reserve=Decimal("25000.00"),
        change_reason="initial reserve",
        received_from="adjuster Smith",
        received_at=datetime(2026, 3, 16, tzinfo=timezone.utc),
        recorded_by=USER_ID,
    )
    s.commit()
    rows = reserve_history_for_claim(s, claim.id)
    assert len(rows) == 1
    assert rows[0].from_amount == Decimal("0.00")
    assert rows[0].to_amount == Decimal("25000.00")
    assert updated.current_reserve == Decimal("25000.00")


def test_first_reserve_auto_transitions_to_reserved():
    s = _session()
    claim = _filed_claim(s)
    s.commit()
    updated = record_carrier_reserve(
        s, claim.id,
        new_reserve=Decimal("10000.00"),
        change_reason="initial",
        received_from="adj",
        received_at=datetime(2026, 3, 16, tzinfo=timezone.utc),
        recorded_by=USER_ID,
    )
    assert updated.status == "reserved"


def test_record_reserve_rejects_negative():
    s = _session()
    claim = _filed_claim(s)
    s.commit()
    with pytest.raises(ClaimsError, match="cannot be negative"):
        record_carrier_reserve(
            s, claim.id, new_reserve=Decimal("-1"),
            change_reason="x", received_from="x",
            received_at=datetime(2026, 3, 16, tzinfo=timezone.utc),
            recorded_by=USER_ID,
        )


def test_record_reserve_rejects_closed_claim():
    s = _session()
    claim = _filed_claim(s)
    claim.status = "closed_paid"
    s.add(claim); s.commit()
    with pytest.raises(ClaimsError, match="reopen before adjusting"):
        record_carrier_reserve(
            s, claim.id, new_reserve=Decimal("1"),
            change_reason="x", received_from="x",
            received_at=datetime(2026, 3, 16, tzinfo=timezone.utc),
            recorded_by=USER_ID,
        )


# ─── record_payment ─────────────────────────────────────────────────────


def _reserved_claim(s: Session) -> Claim:
    claim = _filed_claim(s)
    s.commit()
    return record_carrier_reserve(
        s, claim.id,
        new_reserve=Decimal("25000.00"),
        change_reason="initial",
        received_from="adj",
        received_at=datetime(2026, 3, 16, tzinfo=timezone.utc),
        recorded_by=USER_ID,
    )


def test_record_indemnity_payment_accumulates():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    record_payment(
        s, claim.id, amount=Decimal("5000.00"),
        payment_type="indemnity", paid_on=date(2026, 4, 1),
        description="partial settlement", recorded_by=USER_ID,
    )
    s.commit()
    record_payment(
        s, claim.id, amount=Decimal("3000.00"),
        payment_type="indemnity", paid_on=date(2026, 4, 15),
        description="second tranche", recorded_by=USER_ID,
    )
    s.commit()
    refreshed = s.get(Claim, claim.id)
    assert refreshed.indemnity_paid_to_date == Decimal("8000.00")
    assert refreshed.expense_paid_to_date == Decimal("0.00")
    assert refreshed.status == "settling"  # first indemnity advances state


def test_record_expense_payment_does_not_transition():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    record_payment(
        s, claim.id, amount=Decimal("500.00"),
        payment_type="expense", paid_on=date(2026, 4, 1),
        description="defense counsel", recorded_by=USER_ID,
    )
    s.commit()
    refreshed = s.get(Claim, claim.id)
    assert refreshed.expense_paid_to_date == Decimal("500.00")
    assert refreshed.status == "reserved"


def test_record_recovery_accumulates_separately():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    record_payment(
        s, claim.id, amount=Decimal("750.00"),
        payment_type="recovery", paid_on=date(2026, 5, 1),
        description="salvage proceeds", recorded_by=USER_ID,
    )
    s.commit()
    refreshed = s.get(Claim, claim.id)
    assert refreshed.recoveries_to_date == Decimal("750.00")


def test_record_payment_rejects_invalid_type():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    with pytest.raises(ClaimsError, match="payment_type"):
        record_payment(
            s, claim.id, amount=Decimal("1"),
            payment_type="bogus", paid_on=date(2026, 4, 1),
            description="x", recorded_by=USER_ID,
        )


def test_record_payment_rejects_nonpositive_amount():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    with pytest.raises(ClaimsError, match="amount must be > 0"):
        record_payment(
            s, claim.id, amount=Decimal("0"),
            payment_type="indemnity", paid_on=date(2026, 4, 1),
            description="x", recorded_by=USER_ID,
        )


def test_record_payment_rejects_notified_state():
    s = _session()
    claim = _filed_claim(s); s.commit()  # status='notified', no reserve yet
    with pytest.raises(ClaimsError, match="cannot record payments"):
        record_payment(
            s, claim.id, amount=Decimal("100"),
            payment_type="indemnity", paid_on=date(2026, 4, 1),
            description="x", recorded_by=USER_ID,
        )


# ─── close_claim ────────────────────────────────────────────────────────


def test_close_claim_paid_computes_total_incurred():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    record_payment(
        s, claim.id, amount=Decimal("10000.00"),
        payment_type="indemnity", paid_on=date(2026, 4, 1),
        description="settlement", recorded_by=USER_ID,
    )
    record_payment(
        s, claim.id, amount=Decimal("1500.00"),
        payment_type="expense", paid_on=date(2026, 4, 5),
        description="defense", recorded_by=USER_ID,
    )
    record_payment(
        s, claim.id, amount=Decimal("500.00"),
        payment_type="recovery", paid_on=date(2026, 4, 20),
        description="salvage", recorded_by=USER_ID,
    )
    s.commit()
    closed = close_claim(
        s, claim.id, disposition="paid",
        final_indemnity=Decimal("10000.00"), closed_by=USER_ID,
    )
    s.commit()
    assert closed.status == "closed_paid"
    # 10000 + 1500 - 500 = 11000
    assert closed.total_incurred == Decimal("11000.00")
    assert closed.final_indemnity == Decimal("10000.00")
    assert closed.closed_at is not None


def test_close_claim_denied_allows_no_final_indemnity():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    closed = close_claim(
        s, claim.id, disposition="denied", closed_by=USER_ID,
    )
    s.commit()
    assert closed.status == "closed_denied"
    assert closed.final_indemnity is None
    assert closed.total_incurred == Decimal("0.00")


def test_close_claim_paid_requires_final_indemnity():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    with pytest.raises(ClaimsError, match="final_indemnity is required"):
        close_claim(s, claim.id, disposition="paid", closed_by=USER_ID)


def test_close_claim_rejects_unknown_disposition():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    with pytest.raises(ClaimsError, match="disposition"):
        close_claim(s, claim.id, disposition="bogus", closed_by=USER_ID)


# ─── reopen_claim ───────────────────────────────────────────────────────


def test_reopen_claim_increments_reopen_count():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    close_claim(s, claim.id, disposition="denied", closed_by=USER_ID); s.commit()
    reopened = reopen_claim(
        s, claim.id, reason="late-discovered subrogation", reopened_by=USER_ID,
    )
    s.commit()
    assert reopened.status == "reopened"
    assert reopened.reopen_count == 1
    assert reopened.reopened_at is not None


def test_reopen_claim_rejects_active_claim():
    s = _session()
    claim = _reserved_claim(s); s.commit()
    with pytest.raises(ClaimsError, match="only closed claims"):
        reopen_claim(s, claim.id, reason="x", reopened_by=USER_ID)


# ─── snapshot_hash ──────────────────────────────────────────────────────


def test_snapshot_hash_changes_on_mutation():
    s = _session()
    claim = _filed_claim(s); s.commit()
    initial = claim.snapshot_hash
    updated = record_carrier_reserve(
        s, claim.id, new_reserve=Decimal("1000.00"),
        change_reason="x", received_from="x",
        received_at=datetime(2026, 3, 16, tzinfo=timezone.utc),
        recorded_by=USER_ID,
    )
    assert updated.snapshot_hash != initial


def test_snapshot_hash_is_deterministic_from_state():
    s = _session()
    claim = _filed_claim(s); s.commit()
    recomputed = _compute_claim_snapshot_hash(claim)
    assert recomputed == claim.snapshot_hash


# ─── claims_for_policy ──────────────────────────────────────────────────


def test_claims_for_policy_filters_by_status():
    s = _session()
    pol = _active_policy(s)
    c1 = file_fnol(s, policy_id=pol.id, coverage_line="gl",
                   date_of_loss=date(2026, 2, 1), filed_by=USER_ID)
    c2 = file_fnol(s, policy_id=pol.id, coverage_line="liquor",
                   date_of_loss=date(2026, 2, 2), filed_by=USER_ID)
    s.commit()
    # Close one.
    record_carrier_reserve(
        s, c2.id, new_reserve=Decimal("100"), change_reason="x",
        received_from="x", received_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        recorded_by=USER_ID,
    )
    close_claim(s, c2.id, disposition="denied", closed_by=USER_ID)
    s.commit()
    notified = claims_for_policy(s, pol.id, status_in=["notified"])
    assert len(notified) == 1
    assert notified[0].id == c1.id
    all_claims = claims_for_policy(s, pol.id)
    assert len(all_claims) == 2


# ─── list_claims (cross-policy) ─────────────────────────────────────────


def _second_policy(s: Session) -> Policy:
    p = Policy(
        id="pol-test-2",
        policy_number="POL-2026-0002",
        submission_id="sub-test-2",
        bound_quote_id="q-test-2",
        venue_id="house-of-yes",
        carrier_id="brit-syndicate",
        status="active",
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("8000.00"),
        commission_amount=Decimal("1200.00"),
        commission_rate=Decimal("0.15"),
        coverage_lines=["gl"],
        terms_snapshot={},
        snapshot_hash="hash-test-2",
    )
    s.add(Venue(id="house-of-yes", name="House of Yes"))
    s.add(p); s.commit()
    return p


def test_list_claims_across_policies():
    s = _session()
    p1 = _active_policy(s)
    p2 = _second_policy(s)
    a = file_fnol(s, policy_id=p1.id, coverage_line="gl",
                  date_of_loss=date(2026, 3, 1), filed_by=USER_ID)
    b = file_fnol(s, policy_id=p2.id, coverage_line="gl",
                  date_of_loss=date(2026, 3, 2), filed_by=USER_ID)
    s.commit()

    all_rows = list_claims(s)
    assert {r.id for r in all_rows} == {a.id, b.id}


def test_list_claims_filters_by_venue():
    s = _session()
    p1 = _active_policy(s)
    p2 = _second_policy(s)
    a = file_fnol(s, policy_id=p1.id, coverage_line="gl",
                  date_of_loss=date(2026, 3, 1), filed_by=USER_ID)
    file_fnol(s, policy_id=p2.id, coverage_line="gl",
              date_of_loss=date(2026, 3, 2), filed_by=USER_ID)
    s.commit()

    rows = list_claims(s, venue_id=VENUE_ID)
    assert [r.id for r in rows] == [a.id]


def test_list_claims_open_only_excludes_closed():
    s = _session()
    p1 = _active_policy(s)
    open_claim = file_fnol(s, policy_id=p1.id, coverage_line="gl",
                           date_of_loss=date(2026, 3, 1), filed_by=USER_ID)
    closing = file_fnol(s, policy_id=p1.id, coverage_line="liquor",
                        date_of_loss=date(2026, 3, 2), filed_by=USER_ID)
    record_carrier_reserve(
        s, closing.id, new_reserve=Decimal("100"),
        change_reason="initial", received_from="adj",
        received_at=datetime(2026, 3, 3, tzinfo=timezone.utc),
        recorded_by=USER_ID,
    )
    close_claim(s, closing.id, disposition="denied", closed_by=USER_ID)
    s.commit()

    open_rows = list_claims(s, open_only=True)
    assert [r.id for r in open_rows] == [open_claim.id]
    all_rows = list_claims(s)
    assert len(all_rows) == 2


def test_list_claims_open_only_and_status_mutually_exclusive():
    s = _session()
    _active_policy(s)
    with pytest.raises(ClaimsError, match="mutually exclusive"):
        list_claims(s, open_only=True, status_in=["notified"])


# ─── decision_source provenance ─────────────────────────────────────────


from app.models import AuditEvent  # noqa: E402


def _last_event(s, claim_id, event_type):
    return s.exec(
        select(AuditEvent).where(AuditEvent.entity_type == "claim")
        .where(AuditEvent.entity_id == claim_id)
        .where(AuditEvent.event_type == event_type)
    ).all()[-1]


def test_reserve_defaults_to_broker_relay():
    s = _session()
    claim = _filed_claim(s)
    s.commit()
    record_carrier_reserve(
        s, claim.id, new_reserve=Decimal("1000"), change_reason="init",
        received_from="adjuster", received_at=datetime(2026, 6, 1), recorded_by="u-brk",
    )
    s.commit()
    assert _last_event(s, claim.id, "claim.reserve_recorded").event_metadata["decision_source"] == "broker_relay"


def test_reserve_can_be_carrier_desk():
    s = _session()
    claim = _filed_claim(s)
    s.commit()
    record_carrier_reserve(
        s, claim.id, new_reserve=Decimal("1000"), change_reason="init",
        received_from="adjuster", received_at=datetime(2026, 6, 1),
        recorded_by="u-carrier", decision_source="carrier_desk",
    )
    s.commit()
    assert _last_event(s, claim.id, "claim.reserve_recorded").event_metadata["decision_source"] == "carrier_desk"
