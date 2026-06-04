from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.database import engine
from app.lifecycles import (
    InvalidTransitionError,
    SL_FILING_TERMINAL_STATES,
    SL_FILING_TRANSITIONS,
    assert_valid_transition,
)
from app.models import Declination, Policy, SurplusLinesFiling
from app.services.surplus_lines import (
    SurplusLinesError,
    create_filing_for_policy,
    record_declination,
    recompute_diligent_search,
)
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX
from app.underwriting.surplus_lines import (
    NY_STAMPING_FEE,
    REQUIRED_DECLINATIONS,
    compute_sl_charges,
    diligent_search_complete,
)
from scripts.seed_demo_placements import seed as seed_placements


def test_tax_rate_is_corrected():
    assert NY_SURPLUS_LINES_TAX == Decimal("0.036")
    assert NY_STAMPING_FEE == Decimal("0.0015")
    assert REQUIRED_DECLINATIONS == 3


def test_compute_sl_charges_known_base():
    # base = subtotal + policy_fee
    charges = compute_sl_charges(Decimal("5650.00"))
    assert charges.tax == Decimal("203.40")          # 5650 * 0.036
    assert charges.stamping_fee == Decimal("8.48")    # usd(5650 * 0.0015) = usd(8.475) = 8.48
    assert charges.total_charges == Decimal("211.88")


def test_diligent_search_rules():
    assert diligent_search_complete(3, export_list_exempt=False) is True
    assert diligent_search_complete(2, export_list_exempt=False) is False
    assert diligent_search_complete(0, export_list_exempt=True) is True


def test_models_persist():
    # Self-sufficient in-memory engine (peer pattern: test_ingestion_models.py)
    # — isolated, builds its own schema, no dependency on the shared database.db.
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        f = SurplusLinesFiling(
            id="slf-1", policy_id="pol-1", venue_id="v-1",
            taxable_premium=Decimal("5650.00"), surplus_lines_tax=Decimal("203.40"),
            stamping_fee=Decimal("8.48"), total_charges=Decimal("211.88"),
            filing_deadline=date(2026, 7, 1),
        )
        d = Declination(
            id="decl-1", submission_id="sub-1",
            carrier_name="Acme Admitted", declined_at=date(2026, 5, 1),
            reason="outside appetite",
        )
        s.add(f); s.add(d); s.commit()
        assert f.status == "pending"
        assert f.diligent_search_complete is False
        assert d.reason == "outside appetite"


def test_filing_lifecycle_matrix():
    assert SL_FILING_TRANSITIONS["pending"] == {"filed", "void"}
    assert SL_FILING_TRANSITIONS["filed"] == {"confirmed", "void"}
    assert SL_FILING_TRANSITIONS["confirmed"] == {"void"}
    assert SL_FILING_TRANSITIONS["void"] == set()
    assert SL_FILING_TERMINAL_STATES == frozenset({"void"})
    assert_valid_transition(SL_FILING_TRANSITIONS, "pending", "filed", entity_name="filing")
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(SL_FILING_TRANSITIONS, "pending", "confirmed", entity_name="filing")


def _bound_demo_policy(session):
    """Seed the demo placements and return the bound E&S policy (BW-DEMO)."""
    seed_placements(session)
    session.commit()
    return session.exec(
        select(Policy).where(Policy.policy_number == "BW-DEMO-2026-0001")
    ).first()


def test_create_filing_computes_charges_and_deadline():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        bd = pol.terms_snapshot["premium_breakdown"]
        base = Decimal(bd["subtotal"]) + Decimal(bd["fees"]["policy_fee"])
        assert filing.taxable_premium == base
        # reconciles with the quote engine's own tax (same 0.036, same base)
        assert filing.surplus_lines_tax == Decimal(bd["fees"]["surplus_lines_tax"])
        assert filing.stamping_fee == (base * Decimal("0.0015")).quantize(Decimal("0.01"))
        assert filing.filing_deadline == pol.bound_at.date() + timedelta(days=45)


def test_diligent_search_recompute_and_idempotent_create():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        assert filing.diligent_search_complete is False
        for i in range(3):
            record_declination(
                s, pol.submission_id, carrier_name=f"Admitted {i}",
                reason="outside appetite", declined_at=pol.effective_date,
            )
        s.commit()
        recompute_diligent_search(s, filing)
        s.commit()
        assert filing.diligent_search_complete is True
        # idempotent: re-create returns the same filing, doesn't duplicate
        again = create_filing_for_policy(s, pol, actor_id="user_001")
        assert again.id == filing.id
