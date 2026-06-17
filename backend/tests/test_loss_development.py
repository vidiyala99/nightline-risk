"""Tests for loss_development.py — pure math, no DB required."""
from decimal import Decimal

import pytest

from app.underwriting.loss_development import (
    DEVELOPMENT_LOGIC_VERSION,
    MIN_CREDIBLE_CLAIMS,
    TAIL_FACTOR,
    TriangleCell,
    compute_chain_ladder,
)

D = Decimal


class TestEmptyTriangle:
    def test_no_cells_zero_ultimate(self):
        result = compute_chain_ladder([])
        assert result.ultimate_total == D("0")

    def test_no_cells_not_credible(self):
        result = compute_chain_ladder([])
        assert result.is_credible is False

    def test_no_cells_has_caveat(self):
        result = compute_chain_ladder([])
        assert result.caveat is not None

    def test_no_cells_empty_ratios(self):
        result = compute_chain_ladder([])
        assert result.link_ratios == {}
        assert result.cdfs == {}

    def test_logic_version_present(self):
        result = compute_chain_ladder([])
        assert result.logic_version == DEVELOPMENT_LOGIC_VERSION


class TestSingleCell:
    """One AY, one dev age → no link ratios possible; ultimate==incurred×TAIL."""

    def test_ultimate_equals_incurred_times_tail(self):
        cell = TriangleCell(accident_year=2023, dev_age=0, incurred=D("50000"))
        result = compute_chain_ladder([cell], claim_count=15)
        assert result.ultimate_by_accident_year[2023] == D("50000") * TAIL_FACTOR

    def test_total_equals_single_ay_ultimate(self):
        cell = TriangleCell(accident_year=2023, dev_age=0, incurred=D("50000"))
        result = compute_chain_ladder([cell], claim_count=15)
        assert result.ultimate_total == result.ultimate_by_accident_year[2023]

    def test_cdf_at_only_age_equals_tail(self):
        cell = TriangleCell(accident_year=2023, dev_age=0, incurred=D("50000"))
        result = compute_chain_ladder([cell], claim_count=15)
        assert result.cdfs[0] == TAIL_FACTOR

    def test_no_link_ratio_with_single_age(self):
        cell = TriangleCell(accident_year=2023, dev_age=0, incurred=D("50000"))
        result = compute_chain_ladder([cell], claim_count=15)
        assert result.link_ratios == {}


class TestLinkRatios:
    """Volume-weighted f_k = Σ cell[AY][k+1] / Σ cell[AY][k]."""

    def test_single_ay_two_ages(self):
        cells = [
            TriangleCell(2022, 0, D("100000")),
            TriangleCell(2022, 1, D("110000")),
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        assert result.link_ratios[0] == D("110000") / D("100000")

    def test_volume_weighted_two_ay(self):
        cells = [
            TriangleCell(2021, 0, D("100000")),
            TriangleCell(2021, 1, D("120000")),
            TriangleCell(2022, 0, D("200000")),
            TriangleCell(2022, 1, D("220000")),
        ]
        result = compute_chain_ladder(cells, claim_count=25)
        # (120k+220k) / (100k+200k) = 340/300
        expected = D("340000") / D("300000")
        assert result.link_ratios[0] == expected

    def test_unpaired_ay_excluded_from_link(self):
        # AY 2020 has age 1 but no age 0 → can't form a pair → excluded
        cells = [
            TriangleCell(2020, 1, D("110000")),
            TriangleCell(2021, 0, D("100000")),
            TriangleCell(2021, 1, D("115000")),
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        assert result.link_ratios[0] == D("115000") / D("100000")

    def test_three_ages_two_link_ratios(self):
        cells = [
            TriangleCell(2022, 0, D("100000")),
            TriangleCell(2022, 1, D("110000")),
            TriangleCell(2022, 2, D("115000")),
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        assert 0 in result.link_ratios
        assert 1 in result.link_ratios
        assert result.link_ratios[0] == D("110000") / D("100000")
        assert result.link_ratios[1] == D("115000") / D("110000")


class TestCDFs:
    """CDF_k = TAIL × Π_{j≥k} f_j."""

    def test_cdf_at_max_age_equals_tail(self):
        cells = [
            TriangleCell(2022, 0, D("100000")),
            TriangleCell(2022, 1, D("110000")),
            TriangleCell(2022, 2, D("115000")),
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        assert result.cdfs[2] == TAIL_FACTOR

    def test_cdf_at_age_zero_product_of_all(self):
        cells = [
            TriangleCell(2022, 0, D("100000")),
            TriangleCell(2022, 1, D("110000")),
            TriangleCell(2022, 2, D("115000")),
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        f0 = D("110000") / D("100000")
        f1 = D("115000") / D("110000")
        expected = TAIL_FACTOR * f0 * f1
        assert result.cdfs[0] == expected

    def test_cdf_monotonically_decreasing_from_age_zero(self):
        cells = [
            TriangleCell(2022, 0, D("100000")),
            TriangleCell(2022, 1, D("110000")),
            TriangleCell(2022, 2, D("115000")),
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        assert result.cdfs[0] >= result.cdfs[1] >= result.cdfs[2]


class TestUltimate:
    def test_at_latest_age_ultimate_equals_incurred_times_tail(self):
        cells = [
            TriangleCell(2022, 0, D("100000")),
            TriangleCell(2022, 2, D("120000")),   # latest age
        ]
        result = compute_chain_ladder(cells, claim_count=15)
        assert result.ultimate_by_accident_year[2022] == D("120000") * TAIL_FACTOR

    def test_multi_ay_total_sums(self):
        cells = [
            TriangleCell(2021, 0, D("80000")),
            TriangleCell(2022, 0, D("90000")),
        ]
        result = compute_chain_ladder(cells, claim_count=20)
        ay_sum = sum(result.ultimate_by_accident_year.values(), D("0"))
        assert result.ultimate_total == ay_sum

    def test_undeveloped_ay_uses_own_latest_age(self):
        # AY 2021 is observed at age 1; AY 2022 only at age 0
        cells = [
            TriangleCell(2021, 0, D("100000")),
            TriangleCell(2021, 1, D("110000")),
            TriangleCell(2022, 0, D("90000")),
        ]
        result = compute_chain_ladder(cells, claim_count=20)
        # AY 2022 uses its latest age (0) × CDF at age 0
        f0 = D("110000") / D("100000")
        cdf0 = TAIL_FACTOR * f0
        assert result.ultimate_by_accident_year[2022] == D("90000") * cdf0


class TestCredibility:
    def test_below_threshold_not_credible(self):
        cells = [TriangleCell(2022, 0, D("50000"))]
        result = compute_chain_ladder(cells, claim_count=MIN_CREDIBLE_CLAIMS - 1)
        assert result.is_credible is False
        assert result.caveat is not None

    def test_at_threshold_credible(self):
        cells = [TriangleCell(2022, 0, D("50000"))]
        result = compute_chain_ladder(cells, claim_count=MIN_CREDIBLE_CLAIMS)
        assert result.is_credible is True
        assert result.caveat is None

    def test_above_threshold_credible(self):
        cells = [TriangleCell(2022, 0, D("50000"))]
        result = compute_chain_ladder(cells, claim_count=50)
        assert result.is_credible is True

    def test_no_claims_provided_not_credible(self):
        result = compute_chain_ladder([], claim_count=0)
        assert result.is_credible is False


class TestAccidentYearCount:
    def test_single_ay_count(self):
        cells = [TriangleCell(2022, 0, D("50000")), TriangleCell(2022, 1, D("55000"))]
        result = compute_chain_ladder(cells, claim_count=15)
        assert result.accident_year_count == 1

    def test_three_ay_count(self):
        cells = [
            TriangleCell(2020, 0, D("50000")),
            TriangleCell(2021, 0, D("60000")),
            TriangleCell(2022, 0, D("70000")),
        ]
        result = compute_chain_ladder(cells, claim_count=30)
        assert result.accident_year_count == 3
