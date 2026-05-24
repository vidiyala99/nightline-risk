from decimal import Decimal

from app.underwriting.pricing import loss_adjustment_from_loss_ratio


def test_loss_adjustment_bands():
    assert loss_adjustment_from_loss_ratio(Decimal("0.0")) == Decimal("0.90")
    assert loss_adjustment_from_loss_ratio(Decimal("0.39")) == Decimal("0.90")
    assert loss_adjustment_from_loss_ratio(Decimal("0.40")) == Decimal("1.00")
    assert loss_adjustment_from_loss_ratio(Decimal("0.69")) == Decimal("1.00")
    assert loss_adjustment_from_loss_ratio(Decimal("0.70")) == Decimal("1.25")
    assert loss_adjustment_from_loss_ratio(Decimal("0.99")) == Decimal("1.25")
    assert loss_adjustment_from_loss_ratio(Decimal("1.00")) == Decimal("1.60")
    assert loss_adjustment_from_loss_ratio(Decimal("3.5")) == Decimal("1.60")
