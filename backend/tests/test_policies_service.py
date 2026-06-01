"""Tests for app/services/policies.py — bind, endorse, cancel, certify.

Coverage:
  - bind_quote: atomicity, validation, sibling withdrawal, snapshot_hash
  - assign_policy_number: bound_pending_number → active, re-hash
  - issue_endorsement: terms_diff validation, premium adjustment, history
  - cancel_policy: pro_rata vs short_rate refund math
  - issue_certificate: scope validation, supersede prior to same holder
  - compute_refund: pure-function edge cases
"""
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.lifecycles import InvalidTransitionError
from app.models import (
    AuditEvent,
    CarrierQuote,
    CertificateOfInsurance,
    Endorsement,
    Policy,
    Submission,
    UserRecord,
    Venue,
)
from app.seed_carriers import seed_broker_platform_data
from app.lifecycles import InvalidTransitionError
from app.services.policies import (
    PoliciesError,
    QuoteNotBindableError,
    _compute_policy_snapshot_hash,
    assign_policy_number,
    bind_quote,
    cancel_policy,
    compute_refund,
    expire_policy,
    issue_certificate,
    issue_endorsement,
    lapse_policy,
    list_policies,
    non_renew_policy,
    policy_for_venue,
    reinstate_policy,
)


VENUE_ID = "elsewhere-brooklyn"
USER_ID = "user-broker-test"


# ─── Fixtures ────────────────────────────────────────────────────────────


def _session() -> Session:
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


def _well_formed_breakdown() -> dict:
    return {
        "lines": {
            "gl": {"base": "5500.00", "premium": "3850.00"},
            "liquor": {"base": "2500.00", "premium": "1750.00"},
        },
        "fees": {"policy_fee": "150.00", "surplus_lines_tax": "144.84"},
        "subtotal": "5600.00",
        "total": "5894.84",
        "commission_rate": "0.15",
        "commission_amount": "839.23",
    }


def _make_quoting_submission_with_selected_quote(s: Session) -> tuple[Submission, CarrierQuote]:
    """Setup helper: a Submission in 'quoting' state with one selected
    'quoted' CarrierQuote ready to bind."""
    sub = Submission(
        id="sub-bind-1",
        venue_id=VENUE_ID,
        effective_date=date(2026, 11, 1),
        coverage_lines=["gl", "liquor"],
        status="quoting",
    )
    s.add(sub); s.flush()
    q = CarrierQuote(
        id="q-bind-1",
        submission_id=sub.id,
        carrier_id="markel-specialty",
        status="quoted",
        is_selected=True,
        premium_breakdown=_well_formed_breakdown(),
        coverage_terms={"gl": {"per_occurrence": "1000000"}},
    )
    s.add(q); s.commit()
    return sub, q


# ─── compute_refund (pure function) ─────────────────────────────────────


def test_pro_rata_refund_half_term():
    """Cancel exactly halfway through a 365-day term → 50% refund."""
    refund = compute_refund(
        annual_premium=Decimal("10000.00"),
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),    # 365 days
        cancellation_date=date(2026, 7, 1),  # ~181 days in
        method="pro_rata",
    )
    # Quantize tolerance: pro-rata of 365 days isn't exact halves.
    # 184 days remaining / 365 total = 0.5041 * $10000 = $5041.10
    assert refund.refund_amount == Decimal("5041.10")
    assert refund.days_in_force == 181
    assert refund.days_remaining == 184
    assert refund.short_rate_penalty is None


def test_short_rate_refund_applies_penalty():
    """Same dates with short_rate method → 10% penalty on the pro-rata."""
    pro = compute_refund(
        annual_premium=Decimal("10000.00"),
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        cancellation_date=date(2026, 7, 1),
        method="pro_rata",
    )
    sr = compute_refund(
        annual_premium=Decimal("10000.00"),
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        cancellation_date=date(2026, 7, 1),
        method="short_rate",
    )
    assert sr.refund_amount < pro.refund_amount
    # 10% penalty on the pro-rata refund.
    expected = (pro.refund_amount * Decimal("0.90")).quantize(Decimal("0.01"))
    assert sr.refund_amount == expected
    assert sr.short_rate_penalty == Decimal("0.10")


def test_refund_at_expiration_is_zero():
    refund = compute_refund(
        annual_premium=Decimal("10000.00"),
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        cancellation_date=date(2027, 1, 1),
        method="pro_rata",
    )
    assert refund.refund_amount == Decimal("0.00")
    assert refund.days_remaining == 0


def test_refund_rejects_cancellation_before_effective():
    with pytest.raises(ValueError, match=r"precedes effective_date"):
        compute_refund(
            annual_premium=Decimal("10000.00"),
            effective_date=date(2026, 1, 1),
            expiration_date=date(2027, 1, 1),
            cancellation_date=date(2025, 12, 1),
            method="pro_rata",
        )


def test_refund_rejects_unknown_method():
    with pytest.raises(ValueError, match=r"unknown cancellation method"):
        compute_refund(
            annual_premium=Decimal("10000.00"),
            effective_date=date(2026, 1, 1),
            expiration_date=date(2027, 1, 1),
            cancellation_date=date(2026, 6, 1),
            method="wishful_thinking",
        )


# ─── bind_quote ──────────────────────────────────────────────────────────


def test_bind_quote_creates_policy_and_withdraws_siblings():
    with _session() as s:
        sub, q = _make_quoting_submission_with_selected_quote(s)
        # Add a sibling quote that should get withdrawn.
        sib = CarrierQuote(
            id="q-bind-2",
            submission_id=sub.id,
            carrier_id="burns-wilcox",
            status="quoted",
            is_selected=False,
            premium_breakdown=_well_formed_breakdown(),
        )
        s.add(sib); s.commit()

        policy = bind_quote(s, q.id, bound_by=USER_ID)
        s.commit()

        # Policy created in bound_pending_number (no policy_number passed)
        assert policy.id.startswith("pol-")
        assert policy.status == "bound_pending_number"
        assert policy.policy_number is None
        assert policy.snapshot_hash != ""
        assert policy.annual_premium == Decimal("5894.84")
        assert policy.commission_rate == Decimal("0.15")
        assert policy.coverage_lines == ["gl", "liquor"]

        # Chosen quote transitioned to 'bound'.
        re_q = s.get(CarrierQuote, q.id)
        assert re_q.status == "bound"

        # Sibling withdrawn.
        re_sib = s.get(CarrierQuote, sib.id)
        assert re_sib.status == "withdrawn"

        # Submission terminal.
        re_sub = s.get(Submission, sub.id)
        assert re_sub.status == "bound"
        assert re_sub.bound_at is not None


def test_bind_quote_with_policy_number_starts_active():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="MK-2026-00042", bound_by=USER_ID)
        s.commit()
        assert policy.status == "active"
        assert policy.policy_number == "MK-2026-00042"


def test_bind_quote_emits_audit_event_with_hash():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, bound_by=USER_ID)
        s.commit()
        events = s.exec(
            select(AuditEvent).where(AuditEvent.entity_id == policy.id)
        ).all()
        bound_events = [e for e in events if e.event_type == "policy.bound"]
        assert len(bound_events) == 1
        assert bound_events[0].event_metadata["snapshot_hash"] == policy.snapshot_hash


def test_bind_quote_rejects_unselected_quote():
    with _session() as s:
        sub, q = _make_quoting_submission_with_selected_quote(s)
        q.is_selected = False
        s.add(q); s.commit()
        with pytest.raises(QuoteNotBindableError, match=r"not selected"):
            bind_quote(s, q.id, bound_by=USER_ID)


def test_bind_quote_rejects_wrong_status():
    with _session() as s:
        sub, q = _make_quoting_submission_with_selected_quote(s)
        q.status = "requested"
        s.add(q); s.commit()
        with pytest.raises(QuoteNotBindableError, match=r"must be 'quoted'"):
            bind_quote(s, q.id, bound_by=USER_ID)


def test_bind_quote_rejects_expired_quote():
    with _session() as s:
        sub, q = _make_quoting_submission_with_selected_quote(s)
        q.expires_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        s.add(q); s.commit()
        with pytest.raises(QuoteNotBindableError, match=r"expired"):
            bind_quote(s, q.id, bound_by=USER_ID)


def test_bind_quote_rejects_unknown_quote():
    with _session() as s:
        with pytest.raises(PoliciesError, match=r"Unknown CarrierQuote"):
            bind_quote(s, "q-doesnotexist", bound_by=USER_ID)


# ─── assign_policy_number ───────────────────────────────────────────────


def test_assign_policy_number_transitions_to_active():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, bound_by=USER_ID)
        s.commit()
        hash_before = policy.snapshot_hash
        updated = assign_policy_number(s, policy.id, policy_number="MK-12345", assigned_by=USER_ID)
        s.commit()
        assert updated.status == "active"
        assert updated.policy_number == "MK-12345"
        # Hash MUST change because policy_number is in the anchored snapshot.
        assert updated.snapshot_hash != hash_before


def test_assign_policy_number_rejects_active_policy():
    """Already-active policy shouldn't accept a number re-assignment via
    this code path — that's a correction endorsement, not an assignment."""
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="initial", bound_by=USER_ID)
        s.commit()
        with pytest.raises(PoliciesError, match=r"bound_pending_number"):
            assign_policy_number(s, policy.id, policy_number="other", assigned_by=USER_ID)


def test_assign_policy_number_rejects_empty_string():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, bound_by=USER_ID)
        s.commit()
        with pytest.raises(PoliciesError, match=r"cannot be empty"):
            assign_policy_number(s, policy.id, policy_number="  ", assigned_by=USER_ID)


# ─── issue_endorsement ──────────────────────────────────────────────────


def test_issue_endorsement_adjusts_premium_and_rehashes():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        before_hash = policy.snapshot_hash
        before_premium = policy.annual_premium

        end = issue_endorsement(
            s, policy.id,
            endorsement_type="change_limit",
            effective_date=date(2027, 1, 15),
            terms_diff={
                "coverage_line": "gl",
                "field": "per_occurrence",
                "before": "1000000",
                "after": "2000000",
            },
            premium_change=Decimal("250.00"),
            tax_change=Decimal("9.40"),
            description="Raise GL per-occ to $2M.",
            issued_by=USER_ID,
        )
        s.commit()

        re_policy = s.get(Policy, policy.id)
        assert re_policy.annual_premium == (before_premium + Decimal("250.00"))
        assert re_policy.snapshot_hash != before_hash
        history = re_policy.terms_snapshot.get("endorsement_history") or []
        assert len(history) == 1
        assert history[0]["endorsement_type"] == "change_limit"
        assert history[0]["premium_change"] == "250.00"
        assert end.terms_diff["field"] == "per_occurrence"


def test_issue_endorsement_rejects_malformed_terms_diff():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        with pytest.raises(PoliciesError, match=r"validation failed"):
            issue_endorsement(
                s, policy.id,
                endorsement_type="change_limit",
                effective_date=date(2027, 1, 15),
                terms_diff={"coverage_line": "gl"},  # missing field/before/after
                issued_by=USER_ID,
            )


def test_issue_endorsement_rejects_cancelled_policy():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        cancel_policy(
            s, policy.id,
            reason="Test", method="pro_rata",
            cancellation_date=date(2027, 1, 1),
            cancelled_by=USER_ID,
        )
        s.commit()
        with pytest.raises(PoliciesError, match=r"cannot endorse"):
            issue_endorsement(
                s, policy.id,
                endorsement_type="correction",
                effective_date=date(2027, 2, 1),
                terms_diff={
                    "field_corrected": "address",
                    "before": "x", "after": "y", "explanation": "typo",
                },
                issued_by=USER_ID,
            )


# ─── cancel_policy ───────────────────────────────────────────────────────


def test_cancel_policy_pro_rata_populates_refund():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        # Manually set effective date to 90 days ago so refund is meaningful.
        policy.effective_date = date(2026, 8, 1)
        policy.expiration_date = date(2027, 8, 1)
        s.add(policy); s.commit()

        cancelled = cancel_policy(
            s, policy.id,
            reason="Venue closed",
            method="pro_rata",
            cancellation_date=date(2026, 11, 1),
            cancelled_by=USER_ID,
        )
        s.commit()

        assert cancelled.status == "cancelled"
        assert cancelled.cancellation_method == "pro_rata"
        assert cancelled.refund_amount is not None and cancelled.refund_amount > Decimal("0.00")
        assert cancelled.cancelled_at is not None


def test_cancel_policy_short_rate_yields_smaller_refund():
    """Same policy + dates, short_rate must produce a smaller refund."""
    with _session() as s:
        _, q1 = _make_quoting_submission_with_selected_quote(s)
        p1 = bind_quote(s, q1.id, policy_number="P-A", bound_by=USER_ID)
        s.commit()
        # Build a second submission/policy to cancel via short_rate.
        sub2 = Submission(
            id="sub-bind-2", venue_id=VENUE_ID,
            effective_date=date(2026, 11, 1),
            coverage_lines=["gl"], status="quoting",
        )
        s.add(sub2); s.flush()
        q2 = CarrierQuote(
            id="q-bind-3",
            submission_id=sub2.id,
            carrier_id="markel-specialty",
            status="quoted", is_selected=True,
            premium_breakdown=_well_formed_breakdown(),
        )
        s.add(q2); s.commit()
        p2 = bind_quote(s, q2.id, policy_number="P-B", bound_by=USER_ID)
        s.commit()

        for p in (p1, p2):
            p.effective_date = date(2026, 8, 1)
            p.expiration_date = date(2027, 8, 1)
            s.add(p)
        s.commit()

        p1_cancelled = cancel_policy(
            s, p1.id, reason="x", method="pro_rata",
            cancellation_date=date(2026, 11, 1), cancelled_by=USER_ID,
        )
        p2_cancelled = cancel_policy(
            s, p2.id, reason="x", method="short_rate",
            cancellation_date=date(2026, 11, 1), cancelled_by=USER_ID,
        )
        s.commit()
        assert p2_cancelled.refund_amount < p1_cancelled.refund_amount


def test_cancel_policy_rejects_invalid_method():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        with pytest.raises(PoliciesError, match=r"unknown cancellation method"):
            cancel_policy(
                s, policy.id,
                reason="x", method="freebie",
                cancellation_date=date(2027, 1, 1),
                cancelled_by=USER_ID,
            )


# ─── policy end-of-life transitions (expire / non-renew / lapse / reinstate) ─
#
# These states were defined in lifecycles.POLICY_TRANSITIONS but had no
# service path — only cancel_policy existed. So an active policy stayed
# "Active" forever past its expiration_date, corrupting in-force counts and
# win/loss reporting. These close that gap. None re-hash the snapshot
# (status-only mutations; see CLAUDE.md snapshot-hash rule).


def _active_policy(s, pid="P-eol") -> "Policy":
    _, q = _make_quoting_submission_with_selected_quote(s)
    policy = bind_quote(s, q.id, policy_number="MK-EOL-1", bound_by=USER_ID)
    s.commit()
    assert policy.status == "active"
    return policy


def test_expire_policy_active_to_expired():
    with _session() as s:
        policy = _active_policy(s)
        before = policy.snapshot_hash
        expire_policy(s, policy.id, actor_id=USER_ID)
        s.commit()
        reread = s.get(Policy, policy.id)
        assert reread.status == "expired"
        assert reread.snapshot_hash == before  # status change must NOT re-hash


def test_expire_policy_emits_audit_event():
    with _session() as s:
        policy = _active_policy(s)
        expire_policy(s, policy.id, actor_id="user-eol")
        s.commit()
        ev = s.exec(
            select(AuditEvent).where(
                AuditEvent.entity_id == policy.id,
                AuditEvent.event_type == "policy.expired",
            )
        ).one()
        assert ev.event_metadata["from"] == "active"


def test_non_renew_policy_active_to_non_renewed_with_reason():
    with _session() as s:
        policy = _active_policy(s)
        non_renew_policy(s, policy.id, reason="loss ratio too high", actor_id=USER_ID)
        s.commit()
        reread = s.get(Policy, policy.id)
        assert reread.status == "non_renewed"
        ev = s.exec(
            select(AuditEvent).where(
                AuditEvent.entity_id == policy.id,
                AuditEvent.event_type == "policy.non_renewed",
            )
        ).one()
        assert ev.event_metadata["reason"] == "loss ratio too high"


def test_lapse_then_reinstate_round_trip():
    """Premium unpaid → 'lapsed'; carrier accepts late payment → back to
    'active'. Reinstate is the one non-terminal exit the matrix allows."""
    with _session() as s:
        policy = _active_policy(s)
        lapse_policy(s, policy.id, reason="premium not received", actor_id=USER_ID)
        s.commit()
        assert s.get(Policy, policy.id).status == "lapsed"

        reinstate_policy(s, policy.id, actor_id=USER_ID)
        s.commit()
        assert s.get(Policy, policy.id).status == "active"


def test_expire_cancelled_policy_raises_invalid_transition():
    """'cancelled' is a dead end — you cannot then expire it."""
    with _session() as s:
        policy = _active_policy(s)
        cancel_policy(
            s, policy.id, reason="x", method="pro_rata",
            cancellation_date=date(2027, 1, 1), cancelled_by=USER_ID,
        )
        s.commit()
        with pytest.raises(InvalidTransitionError):
            expire_policy(s, policy.id, actor_id=USER_ID)


def test_reinstate_active_policy_raises_invalid_transition():
    """Reinstate is only legal from 'lapsed'."""
    with _session() as s:
        policy = _active_policy(s)
        with pytest.raises(InvalidTransitionError):
            reinstate_policy(s, policy.id, actor_id=USER_ID)


def test_expire_unknown_policy_raises():
    with _session() as s:
        with pytest.raises(PoliciesError, match=r"[Uu]nknown"):
            expire_policy(s, "pol-nope", actor_id=USER_ID)


# ─── issue_certificate ──────────────────────────────────────────────────


def test_issue_certificate_basic():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        coi = issue_certificate(
            s, policy.id,
            certificate_holder="599 Johnson LLC",
            certificate_holder_address="599 Johnson Ave, Brooklyn",
            description_of_operations="Music venue + bar operations",
            expires_on=date(2027, 11, 1),
            issued_by=USER_ID,
        )
        s.commit()
        assert coi.status == "active"
        assert coi.additional_insured is False


def test_issue_certificate_supersedes_prior_to_same_holder():
    """Issuing a NEW COI to the same holder marks the prior 'superseded'."""
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        first = issue_certificate(
            s, policy.id,
            certificate_holder="EventCo",
            certificate_holder_address="100 Broadway",
            description_of_operations="Event A",
            expires_on=date(2027, 6, 1),
            issued_by=USER_ID,
        )
        s.commit()
        second = issue_certificate(
            s, policy.id,
            certificate_holder="EventCo",
            certificate_holder_address="100 Broadway",
            description_of_operations="Event B (updated)",
            expires_on=date(2027, 7, 1),
            issued_by=USER_ID,
        )
        s.commit()
        re_first = s.get(CertificateOfInsurance, first.id)
        assert re_first.status == "superseded"
        assert second.status == "active"


def test_issue_certificate_with_additional_insured_requires_scope():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        with pytest.raises(PoliciesError, match=r"requires additional_insured_scope"):
            issue_certificate(
                s, policy.id,
                certificate_holder="X", certificate_holder_address="Y",
                description_of_operations="z", expires_on=date(2027, 6, 1),
                additional_insured=True,
                additional_insured_scope=None,
                issued_by=USER_ID,
            )


def test_issue_certificate_rejects_invalid_scope():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        with pytest.raises(PoliciesError, match=r"invalid additional_insured_scope"):
            issue_certificate(
                s, policy.id,
                certificate_holder="X", certificate_holder_address="Y",
                description_of_operations="z", expires_on=date(2027, 6, 1),
                additional_insured=True,
                additional_insured_scope="everywhere",
                issued_by=USER_ID,
            )


def test_issue_certificate_rejects_cancelled_policy():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        cancel_policy(
            s, policy.id, reason="x", method="pro_rata",
            cancellation_date=date(2027, 1, 1), cancelled_by=USER_ID,
        )
        s.commit()
        with pytest.raises(PoliciesError, match=r"cannot issue COI"):
            issue_certificate(
                s, policy.id,
                certificate_holder="X", certificate_holder_address="Y",
                description_of_operations="z", expires_on=date(2027, 6, 1),
                issued_by=USER_ID,
            )


# ─── Read helpers ────────────────────────────────────────────────────────


def test_policy_for_venue_returns_active():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        result = policy_for_venue(s, VENUE_ID)
        assert result is not None and result.id == policy.id


def test_list_policies_defaults_to_active():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        results = list_policies(s)
        assert any(p.id == policy.id for p in results)


def test_list_policies_default_includes_bound_pending_number():
    """A just-bound policy (status='bound_pending_number', carrier hasn't
    issued the number yet) is in-force coverage and must still appear in the
    default working book. Filtering the default on status=='active' alone
    made a freshly-bound policy vanish from /policies until a number landed."""
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, bound_by=USER_ID)  # no policy_number
        s.commit()
        assert policy.status == "bound_pending_number"
        results = list_policies(s)
        assert any(p.id == policy.id for p in results), (
            "bound_pending_number policy vanished from the default /policies list"
        )


def test_snapshot_hash_is_invariant_to_coverage_line_ordering():
    """The hash must be deterministic from CONTENT, not from JSON-storage
    insertion order. If a future SQLAlchemy / Postgres version returns
    coverage_lines in a different order, the hash should stay stable."""
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()

        hash_original = _compute_policy_snapshot_hash(policy)
        # Re-order the list and re-hash; result must be identical.
        policy.coverage_lines = list(reversed(policy.coverage_lines))
        hash_after_reorder = _compute_policy_snapshot_hash(policy)
        assert hash_original == hash_after_reorder, (
            "Coverage line ordering leaked into the hash — sort defensive fix regressed."
        )


def test_list_policies_filters_by_venue_and_carrier():
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        venue_match = list_policies(s, venue_id=VENUE_ID)
        carrier_match = list_policies(s, carrier_id="markel-specialty")
        no_match = list_policies(s, venue_id="ghost-venue")
        assert policy.id in {p.id for p in venue_match}
        assert policy.id in {p.id for p in carrier_match}
        assert no_match == []


def test_certificate_pdf_renders():
    """render_coi_pdf produces real PDF bytes from a COI + its policy, and
    still renders if the policy is missing (defensive)."""
    from app.coi_pdf import render_coi_pdf
    with _session() as s:
        _, q = _make_quoting_submission_with_selected_quote(s)
        policy = bind_quote(s, q.id, policy_number="P-1", bound_by=USER_ID)
        s.commit()
        coi = issue_certificate(
            s, policy.id,
            certificate_holder="599 Johnson LLC",
            certificate_holder_address="599 Johnson Ave, Brooklyn",
            description_of_operations="Music venue + bar operations",
            expires_on=date(2027, 11, 1),
            issued_by=USER_ID,
        )
        s.commit()
        pdf = render_coi_pdf(coi, policy)
        assert pdf[:4] == b"%PDF"
        assert len(pdf) > 800
        # policy-missing path still produces a valid PDF
        assert render_coi_pdf(coi, None)[:4] == b"%PDF"
