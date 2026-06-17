"""Tests for experience_rating.py — pure math, no DB required."""
from decimal import Decimal

import pytest

from app.underwriting.experience_rating import (
    EXPERIENCE_LOGIC_VERSION,
    EXPECTED_LOSS_RATIO,
    FULL_CREDIBILITY_CLAIMS,
    MOD_CAP,
    MOD_FLOOR,
    ExperienceYear,
    compute_experience_mod,
)

D = Decimal


class TestNoHistory:
    def test_empty_years_returns_neutral_mod(self):
        result = compute_experience_mod([])
        assert result.mod == D("1.00")

    def test_empty_years_zero_credibility(self):
        result = compute_experience_mod([])
        assert result.credibility_z == D("0")

    def test_empty_years_zero_claims(self):
        result = compute_experience_mod([])
        assert result.claim_count == 0

    def test_logic_version_present(self):
        result = compute_experience_mod([])
        assert result.logic_version == EXPERIENCE_LOGIC_VERSION


class TestZeroCredibility:
    """0 claims → Z=0 → mod pulls entirely to ELR → mod=1.00."""

    def test_zero_claims_neutral_even_with_high_losses(self):
        year = ExperienceYear(
            years_back=0,
            incurred=D("500000"),
            earned_premium=D("100000"),
            claim_count=0,
        )
        result = compute_experience_mod([year])
        assert result.credibility_z == D("0")
        assert result.mod == D("1.00")


class TestFullCredibility:
    """82+ claims → Z=1 → mod driven entirely by experience LR."""

    def test_full_credibility_at_threshold(self):
        year = ExperienceYear(
            years_back=0,
            incurred=D("65000"),   # 65% of 100k = ELR → mod=1.00
            earned_premium=D("100000"),
            claim_count=82,
        )
        result = compute_experience_mod([year])
        assert result.credibility_z == D("1")
        assert result.mod == D("1.00")

    def test_full_credibility_2x_elr_capped(self):
        # 130% LR → raw mod = 2.0, but capped at 1.75
        year = ExperienceYear(
            years_back=0,
            incurred=D("130000"),
            earned_premium=D("100000"),
            claim_count=82,
        )
        result = compute_experience_mod([year])
        assert result.mod == MOD_CAP

    def test_full_credibility_excellent_lr_floored(self):
        # 20% LR → raw mod ≈ 0.31, floored at 0.75
        year = ExperienceYear(
            years_back=0,
            incurred=D("20000"),
            earned_premium=D("100000"),
            claim_count=82,
        )
        result = compute_experience_mod([year])
        assert result.mod == MOD_FLOOR

    def test_above_threshold_still_z_one(self):
        year = ExperienceYear(
            years_back=0,
            incurred=D("65000"),
            earned_premium=D("100000"),
            claim_count=200,
        )
        result = compute_experience_mod([year])
        assert result.credibility_z == D("1")


class TestTrending:
    """Older losses are trended up; year-0 losses are unchanged."""

    def test_year_zero_no_trend_applied(self):
        year = ExperienceYear(
            years_back=0,
            incurred=D("65000"),
            earned_premium=D("100000"),
            claim_count=82,
        )
        result = compute_experience_mod([year])
        # trend factor = 1.05^0 = 1.0 → trended == incurred → LR = 0.65
        assert result.experience_lr == D("65000") / D("100000")

    def test_older_losses_produce_higher_mod(self):
        recent = ExperienceYear(years_back=0, incurred=D("65000"), earned_premium=D("100000"), claim_count=82)
        older = ExperienceYear(years_back=3, incurred=D("65000"), earned_premium=D("100000"), claim_count=82)
        mod_recent = compute_experience_mod([recent]).mod
        mod_older = compute_experience_mod([older]).mod
        assert mod_older > mod_recent

    def test_trend_math_exact(self):
        # 1 year back: trended = 65000 * 1.05 = 68250; LR = 68250/100000 = 0.6825
        year = ExperienceYear(years_back=1, incurred=D("65000"), earned_premium=D("100000"), claim_count=82)
        result = compute_experience_mod([year])
        expected_lr = D("65000") * D("1.05") / D("100000")
        assert result.experience_lr == expected_lr


class TestMultiYear:
    def test_two_years_aggregate_claim_count(self):
        y1 = ExperienceYear(years_back=0, incurred=D("30000"), earned_premium=D("50000"), claim_count=20)
        y2 = ExperienceYear(years_back=1, incurred=D("30000"), earned_premium=D("50000"), claim_count=20)
        result = compute_experience_mod([y1, y2])
        assert result.claim_count == 40

    def test_partial_credibility_between_bounds(self):
        # 20 claims → Z = sqrt(20/82) ≈ 0.49 → 0 < Z < 1
        year = ExperienceYear(years_back=0, incurred=D("65000"), earned_premium=D("100000"), claim_count=20)
        result = compute_experience_mod([year])
        assert D("0") < result.credibility_z < D("1")

    def test_zero_earned_premium_returns_neutral(self):
        year = ExperienceYear(years_back=0, incurred=D("50000"), earned_premium=D("0"), claim_count=10)
        result = compute_experience_mod([year])
        # earned=0 → experience_lr=0 → fully pulls to ELR → mod=1.00
        assert result.mod == D("1.00")


class TestQuantization:
    def test_mod_quantized_to_cent(self):
        year = ExperienceYear(years_back=0, incurred=D("70000"), earned_premium=D("100000"), claim_count=50)
        result = compute_experience_mod([year])
        assert result.mod == result.mod.quantize(D("0.01"))

    def test_mod_never_below_floor(self):
        year = ExperienceYear(years_back=0, incurred=D("1"), earned_premium=D("100000"), claim_count=200)
        result = compute_experience_mod([year])
        assert result.mod >= MOD_FLOOR

    def test_mod_never_above_cap(self):
        year = ExperienceYear(years_back=0, incurred=D("9999999"), earned_premium=D("100000"), claim_count=200)
        result = compute_experience_mod([year])
        assert result.mod <= MOD_CAP
