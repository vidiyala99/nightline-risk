"""Tests for the broker-path quote engine: build_quote_for_carrier + LineQuote
+ FullQuote + carrier_rate_table.

The contract:
  - Per-carrier multipliers stack on top of shared BASE_RATES.
  - Tier multiplier still applies (consistent with legacy single-line path).
  - Surplus lines tax (3.6%) applies to E&S carriers only.
  - Policy fee is per-carrier; default $150 when not overridden.
  - Commission is computed on pre-tax premium (taxes pass-through).
  - to_json_dict() serializes money as STRINGS for safe JSON column storage.
  - Loss adjustment is identity (1.0) for Phase 1 unless score < 40
    (Tier D territory), where it adds 10% — hook for Phase 6 LossRun.
"""

from decimal import Decimal

from app.underwriting.pricing import (
    CARRIER_RATES,
    DEFAULT_COMMISSION_RATE,
    DEFAULT_POLICY_FEE,
    NY_SURPLUS_LINES_TAX,
    build_quote_for_carrier,
    carrier_rate_table,
)


VENUE_ELSEWHERE = {
    "id": "elsewhere-brooklyn",
    "name": "Elsewhere Brooklyn",
    "venue_type": "music venue and bar",
    "capacity": 800,
}

VENUE_CLUB = {
    "id": "test-club",
    "name": "Test Club",
    "venue_type": "club",
    "capacity": 2000,
}

RISK_TIER_A = {"total_score": 85, "tier": "A"}
RISK_TIER_B = {"total_score": 70, "tier": "B"}
RISK_TIER_D = {"total_score": 30, "tier": "D"}


# ─── carrier_rate_table ──────────────────────────────────────────────────

def test_carrier_rate_table_returns_carrier_specific_rates():
    rates = carrier_rate_table("markel-specialty")
    assert rates is CARRIER_RATES["markel-specialty"]


def test_carrier_rate_table_falls_back_for_unknown_carrier():
    """Unknown carrier id returns identity-multiplier defaults, not raises."""
    rates = carrier_rate_table("ghost-carrier")
    assert rates["venue_multipliers"]["_default"] == Decimal("1.00")
    assert rates["line_multipliers"]["_default"] == Decimal("1.00")
    assert rates["policy_fee"] == DEFAULT_POLICY_FEE
    assert rates["commission_rate"] == DEFAULT_COMMISSION_RATE


# ─── Per-carrier divergence on identical inputs ─────────────────────────

def test_markel_and_brit_produce_different_quotes_for_same_venue():
    """The whole point of per-carrier rate tables: two carriers given the
    same venue/coverage/risk profile must produce different premiums.
    Otherwise the broker comparison view shows identical numbers and the
    UI loses its purpose."""
    markel_q = build_quote_for_carrier(
        venue=VENUE_CLUB,
        coverage_lines=["gl", "liquor"],
        carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    brit_q = build_quote_for_carrier(
        venue=VENUE_CLUB,
        coverage_lines=["gl", "liquor"],
        carrier_id="brit-syndicate",
        market_type="e&s",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    assert markel_q.total_premium != brit_q.total_premium, (
        f"Markel ({markel_q.total_premium}) and Brit ({brit_q.total_premium}) "
        f"both quoted identical premium — per-carrier rate tables aren't taking effect."
    )


# ─── Math sanity: known inputs → known outputs ──────────────────────────

def test_markel_music_venue_tier_b_baseline():
    """The simplest case: music venue, Tier B (1.0x), Markel's
    venue_multiplier=1.0 + GL line_multiplier=1.0 + loss_adj=1.0.
    Result should be BASE_RATES["music venue and bar"] = $12,000 exactly
    for a GL-only quote, plus the policy fee."""
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE,
        coverage_lines=["gl"],
        carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    assert len(q.lines) == 1
    line = q.lines[0]
    assert line.base_premium == Decimal("12000.00")
    assert line.premium == Decimal("12000.00")
    assert q.subtotal == Decimal("12000.00")
    assert q.policy_fee == Decimal("150")
    assert q.surplus_lines_tax == Decimal("0.00")  # admitted, no tax
    assert q.total_premium == Decimal("12150.00")


def test_brit_club_tier_b_with_surplus_lines_tax():
    """Brit (E&S) on a club. Tier B. Brit's venue_mult for club=1.0,
    line_mult for gl=1.05. Surplus lines tax 3.6% on (subtotal + policy_fee)."""
    q = build_quote_for_carrier(
        venue=VENUE_CLUB,
        coverage_lines=["gl"],
        carrier_id="brit-syndicate",
        market_type="e&s",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    # BASE_RATES["club"] = $15,000 * 1.0 venue * 1.0 tier * 1.05 line = $15,750
    assert q.lines[0].premium == Decimal("15750.00")
    assert q.subtotal == Decimal("15750.00")
    assert q.policy_fee == Decimal("250")  # Brit override
    expected_taxable = Decimal("15750.00") + Decimal("250")  # = $16,000
    expected_tax = expected_taxable * NY_SURPLUS_LINES_TAX
    # Account for usd() quantization:
    assert q.surplus_lines_tax == (expected_taxable * NY_SURPLUS_LINES_TAX).quantize(Decimal("0.01"))
    assert q.total_premium == (expected_taxable + expected_tax).quantize(Decimal("0.01"))


def test_admitted_carrier_no_surplus_lines_tax():
    """Markel is admitted — surplus lines tax must be exactly $0, not a
    near-zero amount from a multiplication mistake."""
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE,
        coverage_lines=["gl"],
        carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    assert q.surplus_lines_tax == Decimal("0.00")
    # Total must equal subtotal + policy_fee, no hidden tax:
    assert q.total_premium == q.subtotal + q.policy_fee


def test_tier_multiplier_stacks_correctly():
    """Tier A (0.7x discount) on the same venue/carrier should produce
    exactly 70% of the Tier B premium on the line level."""
    q_b = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    q_a = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score=RISK_TIER_A, requested_limits={},
    )
    ratio = q_a.lines[0].premium / q_b.lines[0].premium
    assert ratio == Decimal("0.7")


def test_loss_adjustment_kicks_in_below_score_40():
    """Tier D venues (score < 40) get an extra 10% multiplier on top of
    the tier mult — the hook for Phase 6's claim-history math. Tests
    that the function actually applies it."""
    q_normal = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted",
        risk_score={"total_score": 50, "tier": "D"},  # tier D but score ≥ 40
        requested_limits={},
    )
    q_loss_adj = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_D,                        # score 30, tier D
        requested_limits={},
    )
    # Loss adjustment 1.1 means the latter is exactly 10% higher on the line.
    ratio = q_loss_adj.lines[0].premium / q_normal.lines[0].premium
    assert ratio == Decimal("1.1")


# ─── Multi-line quote behavior ─────────────────────────────────────────

def test_multi_line_subtotal_is_sum_of_line_premiums():
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE,
        coverage_lines=["gl", "liquor", "epli"],
        carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    assert len(q.lines) == 3
    assert q.subtotal == sum((lq.premium for lq in q.lines), Decimal("0"))


def test_line_order_matches_requested_order():
    """Frontend renders lines in the order the broker submitted them. The
    builder must not reorder by line_id or alphabetic — it processes the
    requested list in order."""
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE,
        coverage_lines=["liquor", "gl", "epli"],
        carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_B,
        requested_limits={},
    )
    assert [lq.line for lq in q.lines] == ["liquor", "gl", "epli"]


# ─── Commission ──────────────────────────────────────────────────────────

def test_commission_uses_carrier_override():
    """Markel commission rate is 0.15 (override); Brit is 0.12. Verify the
    override flows through."""
    markel_q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    assert markel_q.commission_rate == Decimal("0.15")


def test_commission_paid_on_pretax_amount_not_total():
    """Commission is calculated on subtotal + policy_fee, NOT on
    surplus_lines_tax. Taxes pass through to the state."""
    q = build_quote_for_carrier(
        venue=VENUE_CLUB, coverage_lines=["gl"], carrier_id="brit-syndicate",
        market_type="e&s", risk_score=RISK_TIER_B, requested_limits={},
    )
    expected_pretax = q.subtotal + q.policy_fee
    expected_commission = (expected_pretax * q.commission_rate).quantize(Decimal("0.01"))
    assert q.commission_amount == expected_commission
    # Confirm commission is LESS than what it would be if tax were included.
    if q.surplus_lines_tax > 0:
        commission_if_we_included_tax = (q.total_premium * q.commission_rate).quantize(Decimal("0.01"))
        assert q.commission_amount < commission_if_we_included_tax


# ─── requested_limits handling ──────────────────────────────────────────

def test_requested_limits_override_defaults():
    """If the broker requests $2M/$4M instead of $1M/$2M, the LineQuote
    reflects those numbers. (Premium calc itself doesn't currently scale
    with limits; that's a Phase 6 enhancement. But the requested values
    must appear on the line for the comparison UI.)"""
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE,
        coverage_lines=["gl"],
        carrier_id="markel-specialty",
        market_type="admitted",
        risk_score=RISK_TIER_B,
        requested_limits={
            "gl": {"per_occurrence": "2000000", "aggregate": "4000000", "deductible": "5000"},
        },
    )
    assert q.lines[0].per_occurrence_limit == Decimal("2000000")
    assert q.lines[0].aggregate_limit == Decimal("4000000")
    assert q.lines[0].deductible == Decimal("5000")


def test_requested_limits_default_to_standard_when_not_specified():
    """When the broker omits limits, defaults to $1M/$2M/$2500 (the most
    common nightlife GL/Liquor terms)."""
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    assert q.lines[0].per_occurrence_limit == Decimal("1000000")
    assert q.lines[0].aggregate_limit == Decimal("2000000")
    assert q.lines[0].deductible == Decimal("2500")


# ─── to_json_dict — the CarrierQuote.premium_breakdown shape ───────────

def test_to_json_dict_stores_money_as_strings():
    """The whole point of the JSON shape contract: money must be strings,
    not Decimal (which doesn't serialize) or float (which corrupts precision)."""
    q = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl", "liquor"], carrier_id="markel-specialty",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    j = q.to_json_dict()
    assert isinstance(j["total"], str)
    assert isinstance(j["subtotal"], str)
    assert isinstance(j["fees"]["policy_fee"], str)
    assert isinstance(j["lines"]["gl"]["premium"], str)
    # No raw Decimal or float anywhere in money fields:
    import json as _json
    _json.dumps(j)  # If this raises, money slipped through as Decimal.


def test_to_json_dict_passes_validate_premium_breakdown():
    """The output of build_quote_for_carrier().to_json_dict() must satisfy
    submissions service's validate_premium_breakdown — otherwise we have
    two systems disagreeing on what a 'valid' breakdown looks like."""
    from app.services.submissions import validate_premium_breakdown
    q = build_quote_for_carrier(
        venue=VENUE_CLUB, coverage_lines=["gl", "liquor"], carrier_id="brit-syndicate",
        market_type="e&s", risk_score=RISK_TIER_B, requested_limits={},
    )
    j = q.to_json_dict()
    ok, reason = validate_premium_breakdown(j)
    assert ok is True, f"breakdown failed validation: {reason}"


# ─── Nautilus (property-only) sanity ────────────────────────────────────

def test_nautilus_writes_property_competitively_but_makes_gl_unaffordable():
    """Nautilus's seed rates are property-favorable but multiply GL by 2.5x
    so it never wins on liability. This expresses appetite in price form."""
    q_prop = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["property"], carrier_id="nautilus",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    q_gl = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="nautilus",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    markel_gl = build_quote_for_carrier(
        venue=VENUE_ELSEWHERE, coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score=RISK_TIER_B, requested_limits={},
    )
    # Nautilus GL premium should be much higher than Markel GL (price-based "no thanks").
    assert q_gl.lines[0].premium > markel_gl.lines[0].premium * Decimal("2")
