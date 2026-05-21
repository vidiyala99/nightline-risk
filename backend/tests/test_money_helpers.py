"""Tests for app/money.py — the foundation that every dollar value in the
new broker platform passes through. The helpers must:
  - Quantize to cents (usd) and to a configurable decimal place (pct).
  - Match Python's `round()` rounding behavior so the legacy pricing.py
    refactor preserves return values.
  - Round-trip through JSON storage without precision loss.
"""

from decimal import Decimal

import pytest

from app.money import (
    USD_QUANT,
    cast_money_to_float,
    json_to_usd,
    pct,
    usd,
    usd_to_json,
)


# ─── usd(): basic quantization ────────────────────────────────────────────

def test_usd_quantizes_to_cents():
    assert usd("100.123") == Decimal("100.12")
    assert usd("100.125") == Decimal("100.12")  # banker's rounding (even)
    assert usd("100.135") == Decimal("100.14")  # banker's rounding (even)
    assert usd("100.5") == Decimal("100.50")


def test_usd_handles_all_input_types():
    assert usd(100) == Decimal("100.00")
    assert usd(100.50) == Decimal("100.50")
    assert usd("100.50") == Decimal("100.50")
    assert usd(Decimal("100.50")) == Decimal("100.50")


def test_usd_float_input_does_not_leak_precision():
    """The killer bug: float(0.1) is 0.1000000000000000055511...
    If we accept float and don't go through str(), precision corrupts."""
    result = usd(0.1)
    assert result == Decimal("0.10")
    # The result should be exactly 0.10, not the float-imprecise value.
    assert str(result) == "0.10"


def test_usd_quantum_constant():
    assert USD_QUANT == Decimal("0.01")


# ─── usd(): banker's rounding matches Python round() ─────────────────────

@pytest.mark.parametrize("value,expected", [
    # round() in Python 3 uses banker's rounding by default.
    ("0.125", "0.12"),   # rounds to even
    ("0.135", "0.14"),   # rounds to even
    ("0.145", "0.14"),   # rounds to even
    ("0.155", "0.16"),   # rounds to even
    ("0.165", "0.16"),   # rounds to even
])
def test_usd_matches_python_round_at_half(value, expected):
    assert usd(value) == Decimal(expected)
    # Sanity check: Python's round() on a Decimal also produces these.
    assert round(Decimal(value), 2) == Decimal(expected)


# ─── pct(): percentage with configurable precision ──────────────────────

def test_pct_default_one_decimal_place():
    """Mirrors legacy savings_pct rounding."""
    assert pct(7, 21) == Decimal("33.3")
    assert pct(1, 3) == Decimal("33.3")
    assert pct(2, 3) == Decimal("66.7")


def test_pct_with_two_places():
    """For loss ratios — want cent precision."""
    assert pct(7, 21, places=2) == Decimal("33.33")
    assert pct(1, 3, places=2) == Decimal("33.33")


def test_pct_with_zero_places():
    assert pct(1, 3, places=0) == Decimal("33")


def test_pct_whole_zero_returns_quantized_zero():
    """No ZeroDivisionError; returns 0 with the right quantization
    so callers can render without conditional logic."""
    assert pct(100, 0) == Decimal("0.0")
    assert pct(100, 0, places=2) == Decimal("0.00")


def test_pct_negative_places_rejected():
    with pytest.raises(ValueError, match=r"places must be >= 0"):
        pct(1, 2, places=-1)


def test_pct_handles_mixed_input_types():
    assert pct(Decimal("100"), 200) == Decimal("50.0")
    assert pct("100.50", "200.00") == Decimal("50.2")  # 100.50/200 = 0.5025 -> 50.2 (banker's)


# ─── JSON round-trip ────────────────────────────────────────────────────

def test_json_roundtrip_preserves_cents():
    original = Decimal("1234.56")
    serialized = usd_to_json(original)
    assert serialized == "1234.56"
    assert isinstance(serialized, str)

    restored = json_to_usd(serialized)
    assert restored == original


def test_json_to_usd_accepts_legacy_float_columns():
    """Existing JSON columns may have raw floats from before this helper
    existed. Reading them must coerce through str() to prevent float
    precision leak."""
    assert json_to_usd(1234.56) == Decimal("1234.56")
    assert json_to_usd(1234) == Decimal("1234.00")
    assert json_to_usd("1234.56") == Decimal("1234.56")


def test_json_to_usd_quantizes_messy_input():
    """If someone wrote '100.1234567' to JSON, reading it should still
    yield a cent-quantized Decimal."""
    assert json_to_usd("100.1234567") == Decimal("100.12")


# ─── Boundary cast for legacy float APIs ─────────────────────────────────

def test_cast_money_to_float_preserves_display():
    """The legacy get_premium_quote() returns floats. After Decimal refactor,
    cast at the boundary. The displayed value must equal what legacy code
    produced."""
    assert cast_money_to_float(Decimal("4200.00")) == 4200.0
    assert cast_money_to_float(Decimal("100.50")) == 100.5
    # 100.10 as float is technically 100.09999... but rounds to 100.10 for display.
    cast = cast_money_to_float(Decimal("100.10"))
    assert f"{cast:.2f}" == "100.10"


def test_cast_money_through_str_format_matches_legacy_round():
    """The whole point of the cast: legacy `round(x, 2)` formatted to 2dp
    must equal `cast_money_to_float(usd(x))` formatted to 2dp."""
    for raw in ["100", "100.5", "100.123", "100.125", "0.7", "4200.00"]:
        legacy = round(float(raw), 2)
        new = cast_money_to_float(usd(raw))
        assert f"{legacy:.2f}" == f"{new:.2f}", (
            f"Drift at raw={raw}: legacy={legacy:.2f} new={new:.2f}"
        )


# ─── Real-world quote computation: the actual regression risk ────────────

def test_quote_math_decimal_matches_legacy_float_at_two_decimals():
    """The end-to-end test that justifies the whole refactor.
    Compute an annual premium two ways: legacy (float) and new (Decimal),
    cast both to 2dp strings. They must agree."""
    base_rate = 6000
    tier_multiplier = 0.7

    # Legacy path
    legacy_annual = round(base_rate * tier_multiplier, 2)

    # New path
    new_annual = cast_money_to_float(
        usd(Decimal(str(base_rate)) * Decimal(str(tier_multiplier)))
    )

    assert f"{legacy_annual:.2f}" == f"{new_annual:.2f}"
