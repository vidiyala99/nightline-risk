from decimal import Decimal

from app.underwriting.pricing import build_quote_for_carrier


def _venue():
    return {"id": "v1", "venue_type": "music_venue"}


def test_override_scales_line_premium():
    """With an explicit loss_adjustment override, each line premium is the
    no-override premium times the override / the implicit 1.00 it replaces."""
    base = build_quote_for_carrier(
        venue=_venue(), coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score={"tier": "B", "total_score": 80},
        requested_limits={},
    )
    surcharged = build_quote_for_carrier(
        venue=_venue(), coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score={"tier": "B", "total_score": 80},
        requested_limits={}, loss_adjustment=Decimal("1.60"),
    )
    base_line = base.lines[0]
    sur_line = surcharged.lines[0]
    assert base_line.loss_adjustment == Decimal("1.00")
    assert sur_line.loss_adjustment == Decimal("1.60")
    assert sur_line.premium == (base_line.premium * Decimal("1.60")).quantize(Decimal("0.01"))
