"""Characterization tests for the legacy `pricing.py` API.

These tests pin the EXACT numeric output of `PremiumCalculator.calculate_quote()`
for every (seed venue × tier × billing) combination, captured BEFORE the
Decimal refactor. They form the safety net that makes the in-place refactor
safe:

  - Before refactor: every assertion passes (values captured live).
  - After step 1 of refactor (BASE_RATES/TIER_MULTIPLIERS → Decimal,
    float cast at boundary): every assertion must still pass.
  - After step 2 (Decimal helpers in private methods): every assertion
    must still pass.
  - After step 3 (LineQuote/FullQuote/build_quote_for_carrier added):
    every assertion must still pass.

Comparison uses `pytest.approx(abs=0.005)` instead of `==` because
`float(Decimal("4200.00"))` is not guaranteed bit-identical to the legacy
`round(0.7 * 6000, 2)` — both display as `4200.00` but their underlying
IEEE-754 representations can differ. The 0.005 tolerance is half-a-cent,
which is below the precision boundary of any user-visible number.

If a test in this file fails after a refactor commit, the refactor has
changed user-visible pricing and must be reverted or re-justified.

Captured: 2026-05-21, commit `cee7112` (the helper-only commit; pricing.py
is still float-based here).
"""

import pytest

from app.seed_data import VENUES
from app.underwriting.pricing import PremiumCalculator


# ─── Expected values, captured live from PremiumCalculator before refactor ──
# Shape: {venue_id: {tier: {field: expected_value}}}
EXPECTED = {
    "elsewhere-brooklyn": {
        "A": {"annual_premium": 8400.0,  "monthly_premium": 721.0,    "market_rate_annual": 12000.0, "savings_annual": 3600.0,   "savings_pct": 30.0,   "base_rate": 12000.0},
        "B": {"annual_premium": 12000.0, "monthly_premium": 1030.0,   "market_rate_annual": 12000.0, "savings_annual": 0.0,      "savings_pct": 0.0,    "base_rate": 12000.0},
        "C": {"annual_premium": 18000.0, "monthly_premium": 1545.0,   "market_rate_annual": 12000.0, "savings_annual": -6000.0,  "savings_pct": -50.0,  "base_rate": 12000.0},
        "D": {"annual_premium": 30000.0, "monthly_premium": 2575.0,   "market_rate_annual": 12000.0, "savings_annual": -18000.0, "savings_pct": -150.0, "base_rate": 12000.0},
    },
    "brooklyn-mirage": {
        "A": {"annual_premium": 10500.0, "monthly_premium": 901.25,   "market_rate_annual": 15000.0, "savings_annual": 4500.0,   "savings_pct": 30.0,   "base_rate": 15000.0},
        "B": {"annual_premium": 15000.0, "monthly_premium": 1287.5,   "market_rate_annual": 15000.0, "savings_annual": 0.0,      "savings_pct": 0.0,    "base_rate": 15000.0},
        "C": {"annual_premium": 22500.0, "monthly_premium": 1931.25,  "market_rate_annual": 15000.0, "savings_annual": -7500.0,  "savings_pct": -50.0,  "base_rate": 15000.0},
        "D": {"annual_premium": 37500.0, "monthly_premium": 3218.75,  "market_rate_annual": 15000.0, "savings_annual": -22500.0, "savings_pct": -150.0, "base_rate": 15000.0},
    },
    "house-of-yes": {
        "A": {"annual_premium": 11200.0, "monthly_premium": 961.33,   "market_rate_annual": 16000.0, "savings_annual": 4800.0,   "savings_pct": 30.0,   "base_rate": 16000.0},
        "B": {"annual_premium": 16000.0, "monthly_premium": 1373.33,  "market_rate_annual": 16000.0, "savings_annual": 0.0,      "savings_pct": 0.0,    "base_rate": 16000.0},
        "C": {"annual_premium": 24000.0, "monthly_premium": 2060.0,   "market_rate_annual": 16000.0, "savings_annual": -8000.0,  "savings_pct": -50.0,  "base_rate": 16000.0},
        "D": {"annual_premium": 40000.0, "monthly_premium": 3433.33,  "market_rate_annual": 16000.0, "savings_annual": -24000.0, "savings_pct": -150.0, "base_rate": 16000.0},
    },
    "nowadays": {
        "A": {"annual_premium": 7700.0,  "monthly_premium": 660.92,   "market_rate_annual": 11000.0, "savings_annual": 3300.0,   "savings_pct": 30.0,   "base_rate": 11000.0},
        "B": {"annual_premium": 11000.0, "monthly_premium": 944.17,   "market_rate_annual": 11000.0, "savings_annual": 0.0,      "savings_pct": 0.0,    "base_rate": 11000.0},
        "C": {"annual_premium": 16500.0, "monthly_premium": 1416.25,  "market_rate_annual": 11000.0, "savings_annual": -5500.0,  "savings_pct": -50.0,  "base_rate": 11000.0},
        "D": {"annual_premium": 27500.0, "monthly_premium": 2360.42,  "market_rate_annual": 11000.0, "savings_annual": -16500.0, "savings_pct": -150.0, "base_rate": 11000.0},
    },
    "market-hotel": {
        "A": {"annual_premium": 7000.0,  "monthly_premium": 600.83,   "market_rate_annual": 10000.0, "savings_annual": 3000.0,   "savings_pct": 30.0,   "base_rate": 10000.0},
        "B": {"annual_premium": 10000.0, "monthly_premium": 858.33,   "market_rate_annual": 10000.0, "savings_annual": 0.0,      "savings_pct": 0.0,    "base_rate": 10000.0},
        "C": {"annual_premium": 15000.0, "monthly_premium": 1287.5,   "market_rate_annual": 10000.0, "savings_annual": -5000.0,  "savings_pct": -50.0,  "base_rate": 10000.0},
        "D": {"annual_premium": 25000.0, "monthly_premium": 2145.83,  "market_rate_annual": 10000.0, "savings_annual": -15000.0, "savings_pct": -150.0, "base_rate": 10000.0},
    },
}

# Tolerance: half a cent. Below the precision boundary of every user-visible
# money field. Lets `float(Decimal('4200.00'))` and legacy `round(0.7*6000, 2)`
# agree even if their bit-level reps differ.
CENT_TOLERANCE = 0.005


def _params() -> list[tuple[str, str]]:
    return [(vid, t) for vid in EXPECTED for t in ("A", "B", "C", "D")]


@pytest.mark.parametrize("venue_id,tier", _params())
def test_legacy_annual_quote_values_pinned(venue_id, tier):
    """Every (venue, tier) annual quote field must remain at its captured
    value through every step of the Decimal refactor."""
    calc = PremiumCalculator(VENUES)
    quote = calc.calculate_quote(venue_id, billing="annual", tier_override=tier).model_dump()
    expected = EXPECTED[venue_id][tier]

    assert quote["base_rate"] == pytest.approx(expected["base_rate"], abs=CENT_TOLERANCE)
    assert quote["annual_premium"] == pytest.approx(expected["annual_premium"], abs=CENT_TOLERANCE)
    assert quote["monthly_premium"] == pytest.approx(expected["monthly_premium"], abs=CENT_TOLERANCE)
    assert quote["market_rate_annual"] == pytest.approx(expected["market_rate_annual"], abs=CENT_TOLERANCE)
    assert quote["savings_annual"] == pytest.approx(expected["savings_annual"], abs=CENT_TOLERANCE)
    # savings_pct quantizes to 1dp in the legacy code; tolerance 0.05.
    assert quote["savings_pct"] == pytest.approx(expected["savings_pct"], abs=0.05)


@pytest.mark.parametrize("venue_id,tier", _params())
def test_monthly_billing_produces_same_monthly_premium(venue_id, tier):
    """`billing='monthly'` should not change the monthly_premium field —
    only the displayed breakdown. The number itself is identical."""
    calc = PremiumCalculator(VENUES)
    monthly_quote = calc.calculate_quote(venue_id, billing="monthly", tier_override=tier).model_dump()
    expected = EXPECTED[venue_id][tier]
    assert monthly_quote["monthly_premium"] == pytest.approx(expected["monthly_premium"], abs=CENT_TOLERANCE)


@pytest.mark.parametrize("venue_id,tier", _params())
def test_display_string_format_matches_legacy(venue_id, tier):
    """The deepest regression check: after Decimal refactor, the f'{x:.2f}'
    rendered value (what the frontend actually shows) must equal the legacy
    string format. Bit-level float drift doesn't matter; display drift does."""
    calc = PremiumCalculator(VENUES)
    quote = calc.calculate_quote(venue_id, billing="annual", tier_override=tier).model_dump()
    expected = EXPECTED[venue_id][tier]

    for field in ("annual_premium", "monthly_premium", "market_rate_annual", "savings_annual"):
        actual_2dp = f"{quote[field]:.2f}"
        expected_2dp = f"{expected[field]:.2f}"
        assert actual_2dp == expected_2dp, (
            f"{venue_id}/{tier}/{field}: display drift "
            f"actual={actual_2dp} expected={expected_2dp}"
        )

    # savings_pct renders to 1dp
    actual_1dp = f"{quote['savings_pct']:.1f}"
    expected_1dp = f"{expected['savings_pct']:.1f}"
    assert actual_1dp == expected_1dp


def test_return_shape_unchanged():
    """The legacy API returns a dict with these exact keys. The refactor
    must NOT add or remove top-level fields — frontend, eval scorers, and
    dashboard rely on this shape."""
    calc = PremiumCalculator(VENUES)
    quote = calc.calculate_quote("elsewhere-brooklyn", billing="annual", tier_override="A").model_dump()
    expected_keys = {
        "venue_id", "venue_type", "tier", "base_rate",
        "annual_premium", "monthly_premium",
        "market_rate_annual", "savings_annual", "savings_pct",
        "renewal_date", "billing_options", "coverage_breakdown",
    }
    assert set(quote.keys()) == expected_keys, (
        f"missing: {expected_keys - set(quote.keys())}, "
        f"extra: {set(quote.keys()) - expected_keys}"
    )


def test_return_value_types_unchanged():
    """The legacy API returns Python floats for money. After the refactor,
    these MUST still be Python floats (not Decimal), because the eval
    scorers and frontend JSON serialization don't handle Decimal."""
    calc = PremiumCalculator(VENUES)
    quote = calc.calculate_quote("elsewhere-brooklyn", billing="annual", tier_override="A").model_dump()

    for field in ("base_rate", "annual_premium", "monthly_premium",
                  "market_rate_annual", "savings_annual", "savings_pct"):
        assert isinstance(quote[field], float), f"{field} is {type(quote[field]).__name__}, expected float"
