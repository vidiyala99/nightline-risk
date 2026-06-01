"""Tests for app/services/carriers.py — carrier detail (book + appetite).

A carrier detail view answers "what is this carrier doing in our book?" —
identity, appetite tags, and the money rollup for the policies placed with
them (count, written/earned premium, commission, incurred losses, loss ratio),
plus the policy list. It's the drill-down target for the Book Financials
"By carrier" rows.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.models import Carrier, Claim, Policy, Venue
from app.services.carriers import CarrierError, carrier_detail


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id="elsewhere-brooklyn", name="Elsewhere"))
    s.add(Carrier(
        id="carr-a", name="Carrier A", market_type="admitted", naic_code="12345",
        am_best_rating="A", contact_email="uw@carriera.com",
        appetite={"venue_types": ["nightclub", "music_venue"], "max_capacity": 1000,
                  "coverage_lines": ["gl", "liquor"]},
    ))
    s.commit()
    return s


def _half_earned_dates() -> tuple[date, date]:
    today = date.today()
    return today - timedelta(days=100), today + timedelta(days=100)


def _policy(s: Session, *, pid: str, status: str = "active", premium: str, commission: str) -> Policy:
    eff, exp = _half_earned_dates()
    p = Policy(
        id=pid, submission_id=f"sub-{pid}", bound_quote_id=f"q-{pid}",
        venue_id="elsewhere-brooklyn", carrier_id="carr-a", status=status,
        effective_date=eff, expiration_date=exp,
        annual_premium=Decimal(premium), commission_amount=Decimal(commission),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"], terms_snapshot={},
        snapshot_hash="x", policy_number=f"NUM-{pid}",
    )
    s.add(p)
    s.commit()
    return p


def _claim(s: Session, *, cid: str, policy_id: str, reserve: str = "0.00", indemnity: str = "0.00") -> Claim:
    c = Claim(
        id=cid, policy_id=policy_id, coverage_line="gl", status="open_adjusting",
        date_of_loss=date(2026, 3, 1), current_reserve=Decimal(reserve),
        indemnity_paid_to_date=Decimal(indemnity),
    )
    s.add(c)
    s.commit()
    return c


def test_unknown_carrier_raises():
    s = _session()
    with pytest.raises(CarrierError):
        carrier_detail(s, "carr-missing")


def test_identity_and_appetite_tags():
    s = _session()
    out = carrier_detail(s, "carr-a")
    assert out["carrier"]["name"] == "Carrier A"
    assert out["carrier"]["market_type"] == "admitted"
    assert out["carrier"]["am_best_rating"] == "A"
    assert out["appetite"]["venue_types"] == ["nightclub", "music_venue"]
    assert out["appetite"]["max_capacity"] == 1000
    assert out["appetite"]["coverage_lines"] == ["gl", "liquor"]


def test_empty_book_zeros():
    s = _session()
    out = carrier_detail(s, "carr-a")
    assert out["book"]["policy_count"] == 0
    assert out["book"]["written_premium"] == "0.00"
    assert out["book"]["loss_ratio"] is None
    assert out["policies"] == []


def test_book_rollup_inforce_only():
    s = _session()
    _policy(s, pid="p1", premium="10000.00", commission="1500.00")
    _policy(s, pid="p2", premium="20000.00", commission="3000.00")
    _policy(s, pid="p3", status="cancelled", premium="99999.00", commission="9999.00")
    _claim(s, cid="c1", policy_id="p1", reserve="1000.00", indemnity="1000.00")
    out = carrier_detail(s, "carr-a")
    assert out["book"]["policy_count"] == 2
    assert out["book"]["written_premium"] == "30000.00"
    assert out["book"]["commission"] == "4500.00"
    assert out["book"]["earned_premium"] == "15000.00"   # 50% elapsed
    assert out["book"]["incurred_losses"] == "2000.00"
    assert out["book"]["loss_ratio"] == "0.1333"          # 2000 / 15000
    # policies list carries the in-force rows (cancelled excluded), with detail
    pids = {p["policy_id"] for p in out["policies"]}
    assert pids == {"p1", "p2"}
    p1 = next(p for p in out["policies"] if p["policy_id"] == "p1")
    assert p1["policy_number"] == "NUM-p1"
    assert p1["annual_premium"] == "10000.00"
