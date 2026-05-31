"""Tests for the claim-filing recommender.

The recommender is deterministic — these tests lock in the expected-value math
and the should_file gate so demo scenarios produce stable outputs.
"""

import pytest

from app.claim_recommendation import (
    PayoutRange,
    PremiumImpact,
    recommend_claim_filing,
    recommendation_to_dict,
)


def _rs(type_, severity, confidence=0.8):
    return {"type": type_, "severity": severity, "confidence": confidence}


def _inc(injury=False, police=False, ems=False):
    return {"injury_observed": injury, "police_called": police, "ems_called": ems}


def test_critical_medical_with_ems_recommends_file_with_high_probability():
    rec = recommend_claim_filing(
        risk_signal=_rs("medical_emergency", "critical", confidence=0.94),
        incident=_inc(injury=True, police=False, ems=True),
    )
    assert rec.should_file is True
    assert rec.probability >= 0.9
    # Medical emergency at critical severity median sits well above the
    # cumulative premium delta — net EV should be strongly positive.
    assert rec.net_expected_value_usd > 0
    assert any("EMS" in r for r in rec.reasons)
    assert any("Medical Emergency" in r for r in rec.reasons)


def test_low_severity_no_signals_does_not_recommend_file():
    rec = recommend_claim_filing(
        risk_signal=_rs("general_incident", "low", confidence=0.7),
        incident=_inc(injury=False, police=False, ems=False),
    )
    assert rec.should_file is False
    assert rec.probability < 0.45
    assert any("No hard signals" in r for r in rec.reasons)


def test_liquor_liability_high_severity_is_always_flagged():
    """Dram-shop has the highest defense-cost regardless of injury — the
    recommender should reflect that even without operator-confirmed injury."""
    rec = recommend_claim_filing(
        risk_signal=_rs("liquor_liability", "high", confidence=0.91),
        incident=_inc(injury=False, police=False, ems=False),
    )
    assert rec.should_file is True
    assert rec.probability >= 0.7
    assert any("Dram-shop" in r or "liquor" in r.lower() for r in rec.reasons)


def test_premium_impact_is_roughly_10_percent_of_payout_over_3_years():
    rec = recommend_claim_filing(
        risk_signal=_rs("premises_liability", "medium"),
        incident=_inc(injury=True),
    )
    median = rec.expected_payout.median_usd
    cumulative = rec.expected_premium_impact.cumulative_usd
    # Allow a small int-rounding window
    assert abs(cumulative - int(median * 0.10)) <= 3
    assert rec.expected_premium_impact.duration_years == 3


def test_payout_range_widens_with_severity():
    low = recommend_claim_filing(risk_signal=_rs("altercation_event", "low"), incident=_inc()).expected_payout
    high = recommend_claim_filing(risk_signal=_rs("altercation_event", "high"), incident=_inc()).expected_payout
    assert high.median_usd > low.median_usd
    assert high.high_usd > low.high_usd


def test_confidence_drops_for_low_severity_with_no_hard_signals():
    rec = recommend_claim_filing(
        risk_signal=_rs("general_incident", "low", confidence=0.8),
        incident=_inc(),
    )
    # Lower-confidence floor when nothing corroborates
    assert rec.confidence < 0.8


def test_confidence_boosts_when_multiple_hard_signals_corroborate():
    rec = recommend_claim_filing(
        risk_signal=_rs("altercation_event", "medium", confidence=0.78),
        incident=_inc(injury=True, police=True, ems=True),
    )
    assert rec.confidence >= 0.83


def test_venue_with_prior_claims_surfaces_compounding_premium_reason():
    rec = recommend_claim_filing(
        risk_signal=_rs("premises_liability", "medium"),
        incident=_inc(injury=True),
        venue_prior_claim_count=5,
    )
    assert any("prior claims" in r.lower() for r in rec.reasons)


def test_recommendation_to_dict_has_stable_shape():
    """Lock the API contract — frontend reads these exact keys."""
    rec = recommend_claim_filing(
        risk_signal=_rs("medical_emergency", "high"),
        incident=_inc(injury=True, ems=True),
    )
    d = recommendation_to_dict(rec)
    assert set(d.keys()) == {
        "should_file", "probability",
        "expected_payout", "expected_premium_impact",
        "net_expected_value_usd", "reasons", "confidence", "rubric_version",
        "deductible", "carrier_payout", "pay_out_of_pocket_cost",
    }
    assert set(d["expected_payout"].keys()) == {"low_usd", "median_usd", "high_usd"}
    assert set(d["expected_premium_impact"].keys()) == {"annual_delta_usd", "duration_years", "cumulative_usd"}
    assert d["rubric_version"] == "claim-recommendation-v1"


# ─── deductible-aware recommendation ────────────────────────────────────────

from decimal import Decimal

RS = {"type": "premises_liability", "severity": "high", "confidence": 0.9}
INC = {"injury_observed": True, "police_called": True, "ems_called": True}


def test_deductible_reduces_carrier_payout_and_can_flip_to_dont_file():
    big = recommend_claim_filing(risk_signal=RS, incident=INC, deductible=None)
    d = recommendation_to_dict(big)
    assert d["carrier_payout"] == d["expected_payout"]["median_usd"]   # no deductible → full

    huge = recommend_claim_filing(risk_signal=RS, incident=INC, deductible=Decimal("10000000"))
    hd = recommendation_to_dict(huge)
    assert hd["carrier_payout"] == 0
    assert hd["should_file"] is False
    assert hd["pay_out_of_pocket_cost"] == hd["expected_payout"]["median_usd"]
