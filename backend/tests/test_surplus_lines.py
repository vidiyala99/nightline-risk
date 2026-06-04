from decimal import Decimal

from app.underwriting.surplus_lines import (
    NY_STAMPING_FEE,
    REQUIRED_DECLINATIONS,
    compute_sl_charges,
    diligent_search_complete,
)
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX


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


from datetime import date
from uuid import uuid4

from sqlmodel import Session

from app.database import engine
from app.models import Declination, SurplusLinesFiling


def test_models_persist():
    # Unique ids per run: policy_id is UNIQUE-constrained and the shared
    # database.db persists across runs, so fixed PKs collide on re-run.
    u = uuid4().hex[:8]
    with Session(engine) as s:
        f = SurplusLinesFiling(
            id=f"slf-{u}", policy_id=f"pol-{u}", venue_id=f"v-{u}",
            taxable_premium=Decimal("5650.00"), surplus_lines_tax=Decimal("203.40"),
            stamping_fee=Decimal("8.48"), total_charges=Decimal("211.88"),
            filing_deadline=date(2026, 7, 1),
        )
        d = Declination(
            id=f"decl-{u}", submission_id=f"sub-{u}",
            carrier_name="Acme Admitted", declined_at=date(2026, 5, 1),
            reason="outside appetite",
        )
        s.add(f); s.add(d); s.commit()
        assert f.status == "pending"
        assert f.diligent_search_complete is False
        assert d.reason == "outside appetite"
