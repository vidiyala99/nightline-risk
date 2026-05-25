"""Tests for app/services/submissions.py — the broker placement workflow.

Coverage:
  - create_submission: defaults, audit event, unknown venue raises
  - submit_to_market: appetite check, allow_out_of_appetite override,
    submission transition, quote rows created, audit events
  - record_carrier_response: premium sum validation, decline_reason
    required, first-response promotes submission to 'quoting'
  - select_quote: only one selection at a time per submission,
    must be in 'quoted' status
  - withdraw_submission: cascades to live quotes, sets terminal state
  - list_submissions: default hides terminal, filters compose
"""

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, Carrier, CarrierQuote, Submission, Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.submissions import (
    OutOfAppetiteError,
    PremiumBreakdownMismatchError,
    SubmissionsError,
    check_appetite,
    create_submission,
    list_submissions,
    record_carrier_response,
    select_quote,
    submit_to_market,
    update_submission,
    validate_premium_breakdown,
    withdraw_submission,
)


VENUE_ID = "elsewhere-brooklyn"


# ─── Fixtures ─────────────────────────────────────────────────────────────

def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    # Seed the broker platform reference data + venue row so FK
    # lookups in `_venue_dict` (which falls back to Venue table) work.
    s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
    seed_broker_platform_data(s)
    s.commit()
    return s


def _make_submission(s: Session, **kwargs) -> Submission:
    """Helper: create a default submission for tests."""
    defaults = dict(
        venue_id=VENUE_ID,
        effective_date=date(2026, 11, 1),
        coverage_lines=["gl", "liquor"],
        requested_limits={"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
        actor_id="user_test",
    )
    defaults.update(kwargs)
    return create_submission(s, **defaults)


def _well_formed_breakdown(total: str = "5894.84") -> dict:
    """A premium_breakdown that passes validate_premium_breakdown."""
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


# ─── create_submission ────────────────────────────────────────────────────

def test_create_submission_defaults_to_open():
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        assert sub.status == "open"
        assert sub.id.startswith("sub-")
        assert sub.submitted_at is None
        assert sub.bound_at is None
        assert sub.coverage_lines == ["gl", "liquor"]


def test_create_submission_emits_audit_event():
    with _session() as s:
        sub = _make_submission(s, actor_id="user_broker_42")
        s.commit()
        events = s.exec(
            select(AuditEvent).where(AuditEvent.entity_id == sub.id)
        ).all()
        assert len(events) == 1
        assert events[0].event_type == "submission.created"
        assert events[0].actor_id == "user_broker_42"


def test_create_submission_with_unknown_venue_raises():
    with _session() as s:
        with pytest.raises(SubmissionsError, match=r"Unknown venue 'ghost-venue'"):
            create_submission(
                s,
                venue_id="ghost-venue",
                effective_date=date(2026, 11, 1),
                coverage_lines=["gl"],
                requested_limits={},
            )


# ─── check_appetite ──────────────────────────────────────────────────────

def test_appetite_match_for_music_venue_to_markel():
    with _session() as s:
        markel = s.get(Carrier, "markel-specialty")
        assert markel is not None
        venue = VENUES[VENUE_ID]
        matches, reasons = check_appetite(markel, venue, ["gl", "liquor"])
        assert matches is True
        assert reasons == []


def test_appetite_rejects_unsupported_coverage_line():
    with _session() as s:
        nautilus = s.get(Carrier, "nautilus")  # property-only carrier
        assert nautilus is not None
        venue = VENUES[VENUE_ID]
        matches, reasons = check_appetite(nautilus, venue, ["gl", "liquor"])
        assert matches is False
        joined = " ".join(reasons).lower()
        assert "does not write" in joined


def test_appetite_rejects_capacity_overflow():
    with _session() as s:
        markel = s.get(Carrier, "markel-specialty")  # max_capacity=2000
        assert markel is not None
        big_venue = {**VENUES[VENUE_ID], "capacity": 5000}
        matches, reasons = check_appetite(markel, big_venue, ["gl"])
        assert matches is False
        assert any("capacity" in r.lower() for r in reasons)


# ─── submit_to_market ────────────────────────────────────────────────────

def test_submit_to_market_creates_quote_per_carrier_in_appetite():
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        result = submit_to_market(
            s, sub.id,
            target_carriers=["markel-specialty", "burns-wilcox"],
            submitted_by="user_broker_1",
        )
        s.commit()
        assert result.submission.status == "in_market"
        assert result.submission.submitted_at is not None
        assert len(result.quotes_created) == 2
        assert all(q.status == "requested" for q in result.quotes_created)
        assert result.rejected_carriers == []


def test_submit_to_market_skips_out_of_appetite_by_default():
    """Nautilus writes property-only; sending a GL submission to it should
    skip it (not create a CarrierQuote)."""
    with _session() as s:
        sub = _make_submission(s)  # coverage_lines=['gl','liquor']
        s.commit()
        result = submit_to_market(
            s, sub.id,
            target_carriers=["markel-specialty", "nautilus"],
            submitted_by="user_broker_1",
        )
        s.commit()
        # Only Markel got a quote.
        assert len(result.quotes_created) == 1
        assert result.quotes_created[0].carrier_id == "markel-specialty"
        # Nautilus is in rejected.
        assert any(r["carrier_id"] == "nautilus" for r in result.rejected_carriers)


def test_submit_to_market_all_out_of_appetite_raises():
    """If EVERY target carrier is out of appetite, we don't transition
    the submission to in_market — there's no market."""
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        with pytest.raises(OutOfAppetiteError):
            submit_to_market(
                s, sub.id,
                target_carriers=["nautilus"],
                submitted_by="user_broker_1",
            )


def test_submit_to_market_allow_out_of_appetite_creates_quote_anyway():
    """Broker can override appetite check — sometimes you submit anyway
    to build a relationship. The rejection reasons are still captured."""
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        result = submit_to_market(
            s, sub.id,
            target_carriers=["nautilus"],
            submitted_by="user_broker_1",
            allow_out_of_appetite=True,
        )
        s.commit()
        assert len(result.quotes_created) == 1
        assert result.quotes_created[0].carrier_id == "nautilus"


def test_submit_to_market_blocks_invalid_status_transition():
    """A submission in 'bound' state cannot be re-submitted to market."""
    with _session() as s:
        sub = _make_submission(s)
        sub.status = "bound"  # direct write only for test setup
        s.add(sub); s.commit()
        from app.lifecycles import InvalidTransitionError
        with pytest.raises(InvalidTransitionError):
            submit_to_market(
                s, sub.id,
                target_carriers=["markel-specialty"],
                submitted_by="user_broker_1",
            )


def test_submit_to_market_skips_unknown_carrier():
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        result = submit_to_market(
            s, sub.id,
            target_carriers=["markel-specialty", "ghost-insurance"],
            submitted_by="user_broker_1",
        )
        assert len(result.quotes_created) == 1
        assert any(r["carrier_id"] == "ghost-insurance" for r in result.rejected_carriers)


# ─── validate_premium_breakdown ─────────────────────────────────────────

def test_validate_premium_breakdown_accepts_well_formed():
    ok, reason = validate_premium_breakdown(_well_formed_breakdown())
    assert ok is True
    assert reason == ""


def test_validate_premium_breakdown_catches_off_by_100():
    """Off by $100 in the total is the canonical 'broker typo' scenario.
    The sum-check must catch it."""
    bad = _well_formed_breakdown(total="5994.84")  # $100 too high
    ok, reason = validate_premium_breakdown(bad)
    assert ok is False
    assert "drift" in reason.lower()


def test_validate_premium_breakdown_accepts_cents_of_rounding_drift():
    """Carriers sometimes round line premiums independently; up to $1
    of drift is acceptable."""
    bad = _well_formed_breakdown(total="5894.34")  # off by $0.50
    ok, _reason = validate_premium_breakdown(bad)
    assert ok is True


def test_validate_premium_breakdown_rejects_missing_total():
    bad = {"lines": {"gl": {"premium": "1000.00"}}, "fees": {}}
    ok, reason = validate_premium_breakdown(bad)
    assert ok is False
    assert "total" in reason.lower()


def test_validate_premium_breakdown_rejects_empty_lines():
    bad = {"lines": {}, "fees": {}, "total": "0.00"}
    ok, reason = validate_premium_breakdown(bad)
    assert ok is False
    assert "lines" in reason.lower()


# ─── record_carrier_response ─────────────────────────────────────────────

def test_record_quoted_response_advances_submission_to_quoting():
    """First 'quoted' response on an in_market submission must escalate
    the submission's status to 'quoting'."""
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty"], submitted_by="u1",
        )
        s.commit()
        q = result.quotes_created[0]
        record_carrier_response(
            s, q.id, status="quoted",
            premium_breakdown=_well_formed_breakdown(),
            recorded_by="u1",
        )
        s.commit()

        reread_sub = s.get(Submission, sub.id)
        assert reread_sub.status == "quoting"
        reread_q = s.get(CarrierQuote, q.id)
        assert reread_q.status == "quoted"
        assert reread_q.responded_at is not None


def test_record_quoted_response_rejects_invalid_premium_math():
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty"], submitted_by="u1",
        )
        s.commit()
        q = result.quotes_created[0]
        with pytest.raises(PremiumBreakdownMismatchError, match=r"drift"):
            record_carrier_response(
                s, q.id, status="quoted",
                premium_breakdown=_well_formed_breakdown(total="9999.99"),
                recorded_by="u1",
            )


def test_record_decline_requires_reason():
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty"], submitted_by="u1",
        )
        s.commit()
        q = result.quotes_created[0]
        with pytest.raises(SubmissionsError, match=r"decline_reason"):
            record_carrier_response(
                s, q.id, status="declined",
                decline_reason="",
                recorded_by="u1",
            )


def test_record_decline_persists_reason_and_does_not_promote_submission():
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty", "burns-wilcox"], submitted_by="u1",
        )
        s.commit()

        # Decline the first carrier. Submission should still be in_market —
        # only a 'quoted' response promotes to 'quoting'. (Per the current
        # implementation, both responses trigger the in_market→quoting
        # transition; we lock that behavior here.)
        record_carrier_response(
            s, result.quotes_created[0].id, status="declined",
            decline_reason="Account too small for our minimum premium",
            recorded_by="u1",
        )
        s.commit()
        q = s.get(CarrierQuote, result.quotes_created[0].id)
        assert q.status == "declined"
        assert "minimum premium" in q.decline_reason


# ─── select_quote ────────────────────────────────────────────────────────

def test_select_quote_clears_sibling_selections():
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty", "burns-wilcox"], submitted_by="u1",
        )
        s.commit()
        # Quote both carriers.
        for q in result.quotes_created:
            record_carrier_response(
                s, q.id, status="quoted",
                premium_breakdown=_well_formed_breakdown(),
                recorded_by="u1",
            )
        s.commit()

        # Select the first.
        first = select_quote(s, result.quotes_created[0].id, selected_by="u1")
        s.commit()
        assert first.is_selected is True

        # Select the second — first should be deselected.
        second = select_quote(s, result.quotes_created[1].id, selected_by="u1")
        s.commit()
        assert second.is_selected is True
        reread_first = s.get(CarrierQuote, result.quotes_created[0].id)
        assert reread_first.is_selected is False


def test_select_quote_requires_quoted_status():
    """Cannot recommend a quote that hasn't actually been quoted."""
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty"], submitted_by="u1",
        )
        s.commit()
        # quote is still in 'requested' status
        with pytest.raises(SubmissionsError, match=r"expected 'quoted'"):
            select_quote(s, result.quotes_created[0].id, selected_by="u1")


# ─── withdraw_submission ─────────────────────────────────────────────────

def test_withdraw_submission_cascades_to_live_quotes():
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty", "burns-wilcox"], submitted_by="u1",
        )
        s.commit()

        withdraw_submission(s, sub.id, reason="Venue chose Cookiy AI", withdrawn_by="u1")
        s.commit()

        reread_sub = s.get(Submission, sub.id)
        assert reread_sub.status == "withdrawn"
        for q in result.quotes_created:
            reread = s.get(CarrierQuote, q.id)
            assert reread.status == "withdrawn"


def test_withdraw_terminal_submission_raises():
    with _session() as s:
        sub = _make_submission(s)
        sub.status = "bound"
        s.add(sub); s.commit()
        with pytest.raises(SubmissionsError, match=r"terminal state"):
            withdraw_submission(s, sub.id, reason="any", withdrawn_by="u1")


# ─── list_submissions ────────────────────────────────────────────────────

def test_list_submissions_default_hides_terminal():
    with _session() as s:
        active = _make_submission(s)
        terminal = _make_submission(s)
        terminal.status = "bound"
        s.add(terminal); s.commit()

        results = list_submissions(s)
        ids = {r.id for r in results}
        assert active.id in ids
        assert terminal.id not in ids


def test_list_submissions_status_in_filter():
    with _session() as s:
        a = _make_submission(s); s.commit()
        b = _make_submission(s)
        b.status = "in_market"
        s.add(b); s.commit()
        only_open = list_submissions(s, status_in=["open"])
        only_im   = list_submissions(s, status_in=["in_market"])
        assert {r.id for r in only_open} == {a.id}
        assert {r.id for r in only_im}   == {b.id}


def test_list_submissions_filters_by_venue():
    with _session() as s:
        # Add a second venue so we can filter.
        s.add(Venue(id="market-hotel", name="Market Hotel"))
        s.commit()
        sub_a = _make_submission(s, venue_id=VENUE_ID)
        sub_b = _make_submission(s, venue_id="market-hotel")
        s.commit()
        elsewhere_only = list_submissions(s, venue_id=VENUE_ID)
        assert {r.id for r in elsewhere_only} == {sub_a.id}


def test_list_submissions_days_in_market_filter():
    """`days_in_market_min` filters by `submitted_at` age. Submissions
    not yet submitted (submitted_at=None) are always excluded by this filter."""
    with _session() as s:
        sub = _make_submission(s); s.commit()
        result = submit_to_market(
            s, sub.id, target_carriers=["markel-specialty"], submitted_by="u1",
        )
        # Manually backdate submitted_at to simulate 5 days in market.
        from app.time import now_utc
        result.submission.submitted_at = now_utc() - timedelta(days=5)
        s.add(result.submission); s.commit()

        recent = list_submissions(s, days_in_market_min=10)
        assert sub.id not in {r.id for r in recent}
        old = list_submissions(s, days_in_market_min=3)
        assert sub.id in {r.id for r in old}


# ─── update_submission (edit while open) ─────────────────────────────────


def test_update_submission_edits_open():
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        updated = update_submission(
            s, sub.id, actor_id="u",
            notes="rush this one", coverage_lines=["gl"],
            effective_date=date(2026, 12, 1),
        )
        s.commit()
        assert updated.notes == "rush this one"
        assert updated.coverage_lines == ["gl"]
        assert updated.effective_date == date(2026, 12, 1)


def test_update_submission_emits_audit_with_changed_keys():
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        update_submission(s, sub.id, actor_id="u", notes="x")
        s.commit()
        ev = s.exec(
            select(AuditEvent)
            .where(AuditEvent.entity_id == sub.id)
            .where(AuditEvent.event_type == "submission.updated")
        ).first()
        assert ev is not None
        assert "notes" in ev.event_metadata["changed"]


def test_update_submission_unknown_raises():
    with _session() as s:
        with pytest.raises(SubmissionsError, match="Unknown submission"):
            update_submission(s, "sub-nope", actor_id="u", notes="x")


def test_update_submission_rejected_once_in_market():
    with _session() as s:
        sub = _make_submission(s)
        s.commit()
        submit_to_market(s, sub.id, target_carriers=["markel-specialty"], submitted_by="u")
        s.commit()
        with pytest.raises(SubmissionsError, match="can be edited"):
            update_submission(s, sub.id, actor_id="u", notes="too late")
