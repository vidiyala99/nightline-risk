"""Tests for app/services/loss_run.py — the per-venue loss run.

A loss run is the standard insurance artifact: a venue's full claims history
(open AND closed) with reserves/paid/incurred per claim, plus summary totals
and a per-coverage-line rollup. Underwriters read it at renewal/placement.

Coverage:
  - empty venue → zeros, empty lists
  - per-claim rows carry policy/carrier/coverage detail + money
  - incurred = paid (indemnity + expense) − recoveries + reserve
  - summary + by-coverage-line totals
  - only THIS venue's claims (joined via Policy.venue_id)
  - closed claims still appear (full history); open_count excludes them
  - claims sorted most-recent-loss first
"""
from datetime import date
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

from app.models import Carrier, Claim, Policy, Venue
from app.services.loss_run import venue_loss_run


VENUE_ID = "elsewhere-brooklyn"
OTHER_VENUE = "house-of-yes"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(Venue(id=OTHER_VENUE, name="House of Yes"))
    s.add(Carrier(id="carr-a", name="Carrier A", market_type="admitted"))
    s.commit()
    return s


def _policy(s: Session, *, pid: str, venue_id: str = VENUE_ID, policy_number: str | None = "POL-1") -> Policy:
    p = Policy(
        id=pid,
        submission_id=f"sub-{pid}",
        bound_quote_id=f"q-{pid}",
        venue_id=venue_id,
        carrier_id="carr-a",
        status="active",
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("10000.00"),
        commission_amount=Decimal("1500.00"),
        commission_rate=Decimal("0.15"),
        coverage_lines=["gl"],
        terms_snapshot={},
        snapshot_hash="x",
        policy_number=policy_number,
    )
    s.add(p)
    s.commit()
    return p


def _claim(
    s: Session,
    *,
    cid: str,
    policy_id: str,
    coverage_line: str = "gl",
    status: str = "open_adjusting",
    date_of_loss: date = date(2026, 3, 1),
    reserve: str = "0.00",
    indemnity: str = "0.00",
    expense: str = "0.00",
    recoveries: str = "0.00",
    carrier_claim_number: str | None = None,
) -> Claim:
    c = Claim(
        id=cid,
        policy_id=policy_id,
        coverage_line=coverage_line,
        status=status,
        date_of_loss=date_of_loss,
        carrier_claim_number=carrier_claim_number,
        current_reserve=Decimal(reserve),
        indemnity_paid_to_date=Decimal(indemnity),
        expense_paid_to_date=Decimal(expense),
        recoveries_to_date=Decimal(recoveries),
    )
    s.add(c)
    s.commit()
    return c


def test_empty_venue_returns_zeros():
    s = _session()
    out = venue_loss_run(s, VENUE_ID)
    assert out["venue_id"] == VENUE_ID
    assert out["claims"] == []
    assert out["by_coverage_line"] == []
    assert out["summary"]["claim_count"] == 0
    assert out["summary"]["open_count"] == 0
    assert out["summary"]["total_incurred"] == "0.00"
    assert out["summary"]["total_paid"] == "0.00"


def test_claim_row_carries_detail_and_money():
    s = _session()
    _policy(s, pid="p1", policy_number="MAR-2026-001")
    _claim(s, cid="c1", policy_id="p1", carrier_claim_number="CX-99",
           reserve="700.00", indemnity="1000.00", expense="500.00", recoveries="200.00")
    out = venue_loss_run(s, VENUE_ID)
    assert len(out["claims"]) == 1
    row = out["claims"][0]
    assert row["claim_id"] == "c1"
    assert row["carrier_claim_number"] == "CX-99"
    assert row["policy_number"] == "MAR-2026-001"
    assert row["carrier_name"] == "Carrier A"
    assert row["coverage_line"] == "gl"
    assert row["current_reserve"] == "700.00"
    assert row["indemnity_paid"] == "1000.00"
    assert row["expense_paid"] == "500.00"
    assert row["recoveries"] == "200.00"
    # incurred = 1000 + 500 − 200 + 700 = 2000
    assert row["total_incurred"] == "2000.00"


def test_summary_and_by_coverage_line_totals():
    s = _session()
    _policy(s, pid="p1")
    _claim(s, cid="c1", policy_id="p1", coverage_line="gl",
           reserve="700.00", indemnity="1000.00", expense="500.00", recoveries="200.00")
    _claim(s, cid="c2", policy_id="p1", coverage_line="liquor",
           reserve="0.00", indemnity="3000.00", expense="0.00", recoveries="0.00")
    out = venue_loss_run(s, VENUE_ID)
    summ = out["summary"]
    assert summ["claim_count"] == 2
    assert summ["total_reserve"] == "700.00"
    assert summ["total_paid"] == "4500.00"          # (1000+500) + 3000
    assert summ["total_recoveries"] == "200.00"
    assert summ["total_incurred"] == "5000.00"      # 2000 + 3000
    by_line = {r["coverage_line"]: r for r in out["by_coverage_line"]}
    assert set(by_line) == {"gl", "liquor"}
    assert by_line["gl"]["incurred"] == "2000.00"
    assert by_line["gl"]["claim_count"] == 1
    assert by_line["liquor"]["incurred"] == "3000.00"


def test_only_this_venues_claims():
    s = _session()
    _policy(s, pid="p1", venue_id=VENUE_ID)
    _policy(s, pid="p2", venue_id=OTHER_VENUE)
    _claim(s, cid="c1", policy_id="p1", indemnity="1000.00")
    _claim(s, cid="c2", policy_id="p2", indemnity="9999.00")
    out = venue_loss_run(s, VENUE_ID)
    assert [r["claim_id"] for r in out["claims"]] == ["c1"]
    assert out["summary"]["total_paid"] == "1000.00"


def test_closed_claims_in_history_but_not_open_count():
    s = _session()
    _policy(s, pid="p1")
    _claim(s, cid="c1", policy_id="p1", status="open_adjusting", indemnity="100.00")
    _claim(s, cid="c2", policy_id="p1", status="closed_paid", indemnity="500.00")
    out = venue_loss_run(s, VENUE_ID)
    assert out["summary"]["claim_count"] == 2     # full history
    assert out["summary"]["open_count"] == 1      # only the open one
    ids = {r["claim_id"] for r in out["claims"]}
    assert ids == {"c1", "c2"}


def test_claims_sorted_most_recent_loss_first():
    s = _session()
    _policy(s, pid="p1")
    _claim(s, cid="old", policy_id="p1", date_of_loss=date(2026, 1, 15))
    _claim(s, cid="new", policy_id="p1", date_of_loss=date(2026, 6, 1))
    out = venue_loss_run(s, VENUE_ID)
    assert [r["claim_id"] for r in out["claims"]] == ["new", "old"]
