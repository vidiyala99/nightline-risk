from datetime import date
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

from app.models import Declination, SurplusLinesFiling
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX
from app.underwriting.surplus_lines import (
    NY_STAMPING_FEE,
    REQUIRED_DECLINATIONS,
    compute_sl_charges,
    diligent_search_complete,
)


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
