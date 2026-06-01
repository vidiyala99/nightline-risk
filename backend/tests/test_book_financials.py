"""Tests for app/services/book.py — the broker Book financials rollup.

Coverage:
  - empty book → zeros + null loss ratio
  - written premium + commission summed over the in-force book (cancelled excluded)
  - earned premium pro-rated by elapsed fraction of each policy's term
  - incurred losses = paid (indemnity + expense) − recoveries + reserve
  - loss ratio = incurred ÷ earned (null when earned is 0)
  - by-coverage-line breakdown (per-line premium from terms_snapshot)
  - by-carrier breakdown
  - terms_snapshot stored as a JSON *string* (Postgres/Neon) is coerced
"""
import json
from datetime import date, timedelta
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

from app.models import Carrier, Claim, Policy, UserRecord, Venue
from app.services.book import book_financials


VENUE_ID = "elsewhere-brooklyn"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(UserRecord(id="u-b", email="b@x.com", password_hash="x", name="B", role="broker"))
    s.add(Carrier(id="carr-a", name="Carrier A", market_type="admitted"))
    s.add(Carrier(id="carr-b", name="Carrier B", market_type="e&s"))
    s.commit()
    return s


def _breakdown(lines: dict[str, str]) -> dict:
    """A premium_breakdown with per-line premium values."""
    return {"lines": {k: {"premium": v} for k, v in lines.items()}, "total": str(sum(Decimal(v) for v in lines.values()))}


def _policy(
    s: Session,
    *,
    pid: str,
    carrier_id: str = "carr-a",
    status: str = "active",
    premium: str,
    commission: str,
    coverage_lines: list[str],
    line_premiums: dict[str, str] | None = None,
    effective: date,
    expiration: date,
    terms_snapshot_as_string: bool = False,
) -> Policy:
    snapshot = {"premium_breakdown": _breakdown(line_premiums or {})}
    p = Policy(
        id=pid,
        submission_id=f"sub-{pid}",
        bound_quote_id=f"q-{pid}",
        venue_id=VENUE_ID,
        carrier_id=carrier_id,
        status=status,
        effective_date=effective,
        expiration_date=expiration,
        annual_premium=Decimal(premium),
        commission_amount=Decimal(commission),
        commission_rate=Decimal("0.15"),
        coverage_lines=coverage_lines,
        # Postgres returns Column(JSON) as a STRING; simulate that path.
        terms_snapshot=json.dumps(snapshot) if terms_snapshot_as_string else snapshot,
        snapshot_hash="x",
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
    reserve: str = "0.00",
    indemnity: str = "0.00",
    expense: str = "0.00",
    recoveries: str = "0.00",
) -> Claim:
    c = Claim(
        id=cid,
        policy_id=policy_id,
        coverage_line=coverage_line,
        status=status,
        date_of_loss=date(2026, 1, 1),
        current_reserve=Decimal(reserve),
        indemnity_paid_to_date=Decimal(indemnity),
        expense_paid_to_date=Decimal(expense),
        recoveries_to_date=Decimal(recoveries),
    )
    s.add(c)
    s.commit()
    return c


# A policy whose term straddles today symmetrically → exactly 50% earned.
def _half_earned_dates() -> tuple[date, date]:
    today = date.today()
    return today - timedelta(days=100), today + timedelta(days=100)


def test_empty_book_returns_zeros():
    s = _session()
    out = book_financials(s)
    assert out["written_premium"] == "0.00"
    assert out["earned_premium"] == "0.00"
    assert out["commission_revenue"] == "0.00"
    assert out["incurred_losses"] == "0.00"
    assert out["loss_ratio"] is None
    assert out["policy_count"] == 0
    assert out["open_claim_count"] == 0
    assert out["by_coverage_line"] == []
    assert out["by_carrier"] == []


def test_written_premium_and_commission_sum_inforce_only():
    s = _session()
    eff, exp = _half_earned_dates()
    _policy(s, pid="p1", premium="10000.00", commission="1500.00",
            coverage_lines=["gl"], line_premiums={"gl": "10000.00"}, effective=eff, expiration=exp)
    _policy(s, pid="p2", premium="20000.00", commission="3000.00",
            coverage_lines=["gl"], line_premiums={"gl": "20000.00"}, effective=eff, expiration=exp)
    # Cancelled policy must NOT count toward the in-force book.
    _policy(s, pid="p3", status="cancelled", premium="99999.00", commission="9999.00",
            coverage_lines=["gl"], line_premiums={"gl": "99999.00"}, effective=eff, expiration=exp)

    out = book_financials(s)
    assert out["written_premium"] == "30000.00"
    assert out["commission_revenue"] == "4500.00"
    assert out["policy_count"] == 2


def test_earned_premium_prorated_by_term():
    s = _session()
    eff, exp = _half_earned_dates()
    _policy(s, pid="p1", premium="10000.00", commission="1500.00",
            coverage_lines=["gl"], line_premiums={"gl": "10000.00"}, effective=eff, expiration=exp)
    out = book_financials(s)
    # ~50% of the term elapsed → ~$5,000 earned.
    assert out["earned_premium"] == "5000.00"


def test_loss_ratio_incurred_over_earned():
    s = _session()
    eff, exp = _half_earned_dates()
    _policy(s, pid="p1", premium="10000.00", commission="1500.00",
            coverage_lines=["gl"], line_premiums={"gl": "10000.00"}, effective=eff, expiration=exp)
    # incurred = indemnity 1000 + expense 500 − recoveries 200 + reserve 700 = 2000
    _claim(s, cid="c1", policy_id="p1", reserve="700.00", indemnity="1000.00",
           expense="500.00", recoveries="200.00")
    out = book_financials(s)
    assert out["incurred_losses"] == "2000.00"
    # earned ≈ 5000 → loss ratio ≈ 0.40
    assert out["loss_ratio"] == "0.4000"
    assert out["open_claim_count"] == 1


def test_by_coverage_line_breakdown():
    s = _session()
    eff, exp = _half_earned_dates()
    _policy(s, pid="p1", premium="30000.00", commission="4500.00",
            coverage_lines=["gl", "liquor"],
            line_premiums={"gl": "20000.00", "liquor": "10000.00"},
            effective=eff, expiration=exp)
    _claim(s, cid="c1", policy_id="p1", coverage_line="gl", reserve="1000.00", indemnity="1000.00")
    out = book_financials(s)
    by_line = {row["coverage_line"]: row for row in out["by_coverage_line"]}
    assert set(by_line) == {"gl", "liquor"}
    assert by_line["gl"]["written_premium"] == "20000.00"
    assert by_line["gl"]["earned_premium"] == "10000.00"   # 50% of 20000
    assert by_line["gl"]["incurred_losses"] == "2000.00"
    assert by_line["gl"]["loss_ratio"] == "0.2000"          # 2000 / 10000
    assert by_line["liquor"]["incurred_losses"] == "0.00"
    assert by_line["liquor"]["loss_ratio"] == "0.0000"


def test_by_carrier_breakdown():
    s = _session()
    eff, exp = _half_earned_dates()
    _policy(s, pid="p1", carrier_id="carr-a", premium="10000.00", commission="1500.00",
            coverage_lines=["gl"], line_premiums={"gl": "10000.00"}, effective=eff, expiration=exp)
    _policy(s, pid="p2", carrier_id="carr-b", premium="20000.00", commission="3000.00",
            coverage_lines=["gl"], line_premiums={"gl": "20000.00"}, effective=eff, expiration=exp)
    _claim(s, cid="c1", policy_id="p2", reserve="0.00", indemnity="2000.00")
    out = book_financials(s)
    by_carrier = {row["carrier_id"]: row for row in out["by_carrier"]}
    assert by_carrier["carr-a"]["carrier_name"] == "Carrier A"
    assert by_carrier["carr-a"]["written_premium"] == "10000.00"
    assert by_carrier["carr-a"]["policy_count"] == 1
    assert by_carrier["carr-a"]["incurred_losses"] == "0.00"
    assert by_carrier["carr-b"]["written_premium"] == "20000.00"
    assert by_carrier["carr-b"]["incurred_losses"] == "2000.00"
    assert by_carrier["carr-b"]["loss_ratio"] == "0.2000"   # 2000 / 10000 earned


def test_terms_snapshot_json_string_is_coerced():
    """Postgres returns Column(JSON) as a string — per-line premium must still
    resolve (the Neon JSON-string regression class)."""
    s = _session()
    eff, exp = _half_earned_dates()
    _policy(s, pid="p1", premium="10000.00", commission="1500.00",
            coverage_lines=["gl"], line_premiums={"gl": "10000.00"},
            effective=eff, expiration=exp, terms_snapshot_as_string=True)
    out = book_financials(s)
    by_line = {row["coverage_line"]: row for row in out["by_coverage_line"]}
    assert by_line["gl"]["written_premium"] == "10000.00"
