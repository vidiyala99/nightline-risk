"""Tests for scripts.seed_defense_demo — date cap, --refresh, and prior loss.

Covers the three demo-data invariants:
  1. The seeded demo claim's date_of_loss is never in the future (cap holds).
  2. --refresh deletes the stale demo artifacts and recreates exactly one
     claim, re-capped to today-or-earlier.
  3. A prior CLOSED liquor loss is seeded so the venue loss run's liquor
     coverage line has non-zero incurred (the reserve advisory band).
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Claim, Policy, Venue
from app.services.loss_run import venue_loss_run
from scripts.seed_defense_demo import INCIDENT_ID, seed

VENUE_ID = "nowadays"
POLICY_ID = "pol-demo-1"


@pytest.fixture
def session(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 't.db'}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Venue(id=VENUE_ID, name="Nowadays"))
        s.add(
            Policy(
                id=POLICY_ID,
                policy_number="POL-DEMO-001",
                submission_id="sub-demo-1",
                bound_quote_id="q-demo-1",
                venue_id=VENUE_ID,
                carrier_id="markel-specialty",
                status="active",
                effective_date=date.today() - timedelta(days=5),
                expiration_date=date.today() + timedelta(days=360),
                annual_premium=Decimal("5000.00"),
                commission_amount=Decimal("750.00"),
                commission_rate=Decimal("0.15"),
                coverage_lines=["liquor"],
                terms_snapshot={},
                snapshot_hash="hash-demo",
            )
        )
        s.commit()
        yield s


def _demo_claims(session: Session) -> list[Claim]:
    return list(
        session.exec(select(Claim).where(Claim.incident_id == INCIDENT_ID)).all()
    )


def test_seed_caps_date_of_loss_to_today(session):
    result = seed(session)
    assert result is not None
    claims = _demo_claims(session)
    assert len(claims) == 1
    assert claims[0].date_of_loss <= date.today()


def test_refresh_recreates_single_claim_with_capped_date(session):
    seed(session)
    # Simulate the stale prod row: a future date_of_loss seeded before the cap.
    claim = _demo_claims(session)[0]
    claim.date_of_loss = date.today() + timedelta(days=40)
    session.add(claim)
    session.commit()

    seed(session, refresh=True)

    claims = _demo_claims(session)
    assert len(claims) == 1
    assert claims[0].date_of_loss <= date.today()


def test_prior_loss_makes_liquor_band_nonzero(session):
    seed(session)
    run = venue_loss_run(session, VENUE_ID)
    liquor = [
        line for line in run["by_coverage_line"] if line["coverage_line"] == "liquor"
    ]
    assert liquor, "expected a liquor coverage line in the loss run"
    assert Decimal(liquor[0]["incurred"]) > 0
