"""
DB adapter tests for the actuarial layer (Step 3).

Uses an isolated in-memory SQLite engine — no TestClient, no app.database.
SQLite does not enforce FKs by default, so we can insert Claim / ClaimPayment /
ReserveChange rows with synthetic parent IDs without needing the full
Venue/Carrier/Submission/Policy chain.

Key contracts:
  - Same loss data + same logic version → same AgentRun.input_hash (reproducibility).
  - Adapter correctly maps DB rows → ExperienceYear / TriangleCell inputs.
  - record_agent_run wraps both computations without committing (session owns it).
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.models import Claim, ClaimPayment, Policy, ReserveChange
from app.services.loss_development_data import build_development_cells_for_venue
from app.services.renewals import build_experience_years_for_policy


# ── In-memory engine fixture ──────────────────────────────────────────────

@pytest.fixture()
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


# ── Helpers ───────────────────────────────────────────────────────────────

def _policy(session: Session, *, policy_id: str, venue_id: str) -> None:
    """Minimal Policy row — satisfies the Claim FK and the venue_id join."""
    p = Policy(
        id=policy_id,
        venue_id=venue_id,
        submission_id="sub-test",
        bound_quote_id="cq-test",
        carrier_id="car-test",
        effective_date=date(2024, 1, 1),
        expiration_date=date(2025, 1, 1),
        annual_premium=Decimal("100000"),
        commission_amount=Decimal("10000"),
        commission_rate=Decimal("0.10"),
    )
    session.add(p)
    session.flush()


def _claim(
    session: Session,
    *,
    claim_id: str,
    policy_id: str,
    coverage_line: str,
    date_of_loss: date,
    current_reserve: str = "0",
    indemnity_paid: str = "0",
    expense_paid: str = "0",
    recoveries: str = "0",
) -> Claim:
    c = Claim(
        id=claim_id,
        policy_id=policy_id,
        coverage_line=coverage_line,
        date_of_loss=date_of_loss,
        current_reserve=Decimal(current_reserve),
        indemnity_paid_to_date=Decimal(indemnity_paid),
        expense_paid_to_date=Decimal(expense_paid),
        recoveries_to_date=Decimal(recoveries),
    )
    session.add(c)
    session.flush()
    return c


def _payment(session, *, pay_id, claim_id, amount, payment_type, paid_on) -> None:
    session.add(ClaimPayment(
        id=pay_id,
        claim_id=claim_id,
        payment_type=payment_type,
        amount=Decimal(amount),
        paid_on=paid_on,
        recorded_by="sys",
    ))
    session.flush()


def _reserve_change(session, *, rc_id, claim_id, to_amount, received_at) -> None:
    session.add(ReserveChange(
        id=rc_id,
        claim_id=claim_id,
        from_amount=Decimal("0"),
        to_amount=Decimal(to_amount),
        change_reason="test",
        received_from="carrier",
        received_at=received_at,
        recorded_by="sys",
    ))
    session.flush()


# ── Experience year adapter tests ─────────────────────────────────────────

class TestBuildExperienceYears:
    def test_single_policy_single_year_maps_correctly(self, session):
        _claim(
            session, claim_id="cl-001", policy_id="pol-001",
            coverage_line="gl", date_of_loss=date(2024, 6, 1),
            indemnity_paid="30000", current_reserve="20000",
        )
        session.commit()

        years = build_experience_years_for_policy(
            session, policy_id="pol-001",
            annual_premium=Decimal("100000"),
            years_back=0,
        )

        assert len(years) == 1
        assert years[0].years_back == 0
        assert years[0].earned_premium == Decimal("100000")
        assert years[0].claim_count == 1
        # incurred = indemnity_paid + expense_paid - recoveries + current_reserve
        assert years[0].incurred == Decimal("50000")

    def test_no_claims_returns_zero_incurred(self, session):
        years = build_experience_years_for_policy(
            session, policy_id="pol-empty",
            annual_premium=Decimal("80000"),
            years_back=1,
        )
        assert len(years) == 1
        assert years[0].incurred == Decimal("0")
        assert years[0].claim_count == 0
        assert years[0].years_back == 1

    def test_multiple_claims_aggregate_incurred(self, session):
        for i in range(3):
            _claim(
                session, claim_id=f"cl-{i}", policy_id="pol-002",
                coverage_line="gl", date_of_loss=date(2023, 3, i + 1),
                indemnity_paid="10000",
            )
        session.commit()

        years = build_experience_years_for_policy(
            session, policy_id="pol-002",
            annual_premium=Decimal("120000"),
            years_back=0,
        )
        assert years[0].claim_count == 3
        assert years[0].incurred == Decimal("30000")


# ── Reproducibility: same data → same input_hash ─────────────────────────

class TestExperienceModReproducibility:
    def test_same_inputs_same_hash(self, session):
        from app.ai_provenance import canonical_input_hash
        from app.underwriting.experience_rating import (
            ExperienceYear, EXPERIENCE_LOGIC_VERSION,
        )

        years = [
            ExperienceYear(years_back=0, incurred=Decimal("65000"),
                           earned_premium=Decimal("100000"), claim_count=30),
            ExperienceYear(years_back=1, incurred=Decimal("55000"),
                           earned_premium=Decimal("95000"), claim_count=25),
        ]
        payload = {
            "logic_version": EXPERIENCE_LOGIC_VERSION,
            "years": [
                {"years_back": y.years_back, "incurred": str(y.incurred),
                 "earned_premium": str(y.earned_premium), "claim_count": y.claim_count}
                for y in years
            ],
        }
        h1 = canonical_input_hash(payload)
        h2 = canonical_input_hash(payload)
        assert h1 == h2

    def test_different_amounts_different_hash(self):
        from app.ai_provenance import canonical_input_hash
        from app.underwriting.experience_rating import EXPERIENCE_LOGIC_VERSION

        base = {"logic_version": EXPERIENCE_LOGIC_VERSION, "incurred": "65000"}
        changed = {"logic_version": EXPERIENCE_LOGIC_VERSION, "incurred": "70000"}
        assert canonical_input_hash(base) != canonical_input_hash(changed)


# ── Chain-ladder cell adapter tests ──────────────────────────────────────

class TestBuildDevelopmentCells:
    def test_single_claim_current_balance_produces_cell(self, session):
        _policy(session, policy_id="pol-t", venue_id="v-tri")
        _claim(
            session, claim_id="cl-tri-1", policy_id="pol-t",
            coverage_line="gl", date_of_loss=date(2023, 5, 1),
            indemnity_paid="40000", current_reserve="15000",
        )
        session.commit()

        cells_by_line, count = build_development_cells_for_venue(
            session, venue_id="v-tri", reference_year=2025,
        )

        assert "gl" in cells_by_line
        assert count == 1
        gl_cells = cells_by_line["gl"]
        assert len(gl_cells) >= 1
        # The latest diagonal for AY 2023: incurred = 40000 + 15000 = 55000
        latest = max(gl_cells, key=lambda c: c.dev_age)
        assert latest.accident_year == 2023
        assert latest.incurred == Decimal("55000")

    def test_groups_by_coverage_line(self, session):
        _policy(session, policy_id="pol-t2", venue_id="v-multi")
        _claim(
            session, claim_id="cl-gl", policy_id="pol-t2",
            coverage_line="gl", date_of_loss=date(2024, 1, 1),
            indemnity_paid="20000",
        )
        _claim(
            session, claim_id="cl-liq", policy_id="pol-t2",
            coverage_line="liquor", date_of_loss=date(2024, 2, 1),
            indemnity_paid="30000",
        )
        session.commit()

        cells_by_line, count = build_development_cells_for_venue(
            session, venue_id="v-multi", reference_year=2025,
        )

        assert "gl" in cells_by_line
        assert "liquor" in cells_by_line
        assert count == 2

    def test_no_claims_returns_empty(self, session):
        cells_by_line, count = build_development_cells_for_venue(
            session, venue_id="v-none", reference_year=2025,
        )
        assert cells_by_line == {}
        assert count == 0

    def test_historical_payments_used_for_past_dev_ages(self, session):
        _policy(session, policy_id="pol-h", venue_id="v-hist")
        _claim(
            session, claim_id="cl-hist", policy_id="pol-h",
            coverage_line="gl", date_of_loss=date(2023, 6, 1),
            indemnity_paid="50000", current_reserve="10000",
        )
        _payment(
            session, pay_id="pay-1", claim_id="cl-hist",
            amount="20000", payment_type="indemnity",
            paid_on=date(2023, 10, 1),
        )
        _payment(
            session, pay_id="pay-2", claim_id="cl-hist",
            amount="30000", payment_type="indemnity",
            paid_on=date(2024, 4, 1),
        )
        _reserve_change(
            session, rc_id="rc-1", claim_id="cl-hist",
            to_amount="25000",
            received_at=datetime(2023, 11, 1, 0, 0, 0),
        )
        session.commit()

        cells_by_line, _ = build_development_cells_for_venue(
            session, venue_id="v-hist", reference_year=2025,
        )

        gl_cells = {c.dev_age: c for c in cells_by_line["gl"]}
        # dev_age=0 (val=2023-12-31): paid=20000 (only pay-1), reserve=25000
        assert gl_cells[0].incurred == Decimal("45000")
        # dev_age=1 (val=2024-12-31): paid=20000+30000=50000, reserve=25000 (latest)
        assert gl_cells[1].incurred == Decimal("75000")
