"""Step 5 tests: chain-ladder ultimate wired into rate_adequacy + reserve_hint.

All tests are failure-isolated (no DB required for recommender tests;
reserve_hint tests use the same in-memory SQLite fixture as test_actuarial_adapters).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.underwriting.recommender import RecommenderInputs, _rate_adequacy, recommend


# ── _rate_adequacy unit tests ─────────────────────────────────────────────────

class TestRateAdequacyWithUltimate:
    def test_no_ultimate_falls_back_to_total_incurred(self):
        # 60000/100000 = 0.60 → adequate band
        label, note = _rate_adequacy(Decimal("60000"), Decimal("100000"))
        assert label == "adequate"
        assert "60,000" in note

    def test_ultimate_lean_debit_when_high(self):
        # ultimate = 85000, indicated = 100000 → ratio 0.85 ≥ 0.8 → lean_debit
        label, note = _rate_adequacy(
            Decimal("0"), Decimal("100000"), ultimate_total=Decimal("85000")
        )
        assert label == "lean_debit"
        assert "chain-ladder" in note
        assert "85,000" in note

    def test_ultimate_lean_credit_when_low(self):
        # ultimate = 25000, indicated = 100000 → ratio 0.25 ≤ 0.3 → lean_credit
        label, note = _rate_adequacy(
            Decimal("0"), Decimal("100000"), ultimate_total=Decimal("25000")
        )
        assert label == "lean_credit"
        assert "chain-ladder" in note

    def test_ultimate_adequate_in_middle_band(self):
        # ultimate = 50000, indicated = 100000 → ratio 0.50
        label, note = _rate_adequacy(
            Decimal("90000"), Decimal("100000"), ultimate_total=Decimal("50000")
        )
        assert label == "adequate"
        assert "chain-ladder" in note

    def test_zero_ultimate_falls_back_to_total_incurred(self):
        # ultimate=0 treated as not available (guard: ultimate must be > 0)
        label, note = _rate_adequacy(
            Decimal("90000"), Decimal("100000"), ultimate_total=Decimal("0")
        )
        assert label == "lean_debit"
        assert "90,000" in note

    def test_no_history_no_ultimate_returns_adequate(self):
        label, note = _rate_adequacy(Decimal("0"), Decimal("50000"))
        assert label == "adequate"
        assert "No prior" in note

    def test_zero_indicated_always_adequate(self):
        label, note = _rate_adequacy(
            Decimal("999999"), Decimal("0"), ultimate_total=Decimal("500000")
        )
        assert label == "adequate"
        assert "No indicated" in note


class TestRecommendPassesUltimate:
    def _base_inputs(self, **kw) -> RecommenderInputs:
        return RecommenderInputs(
            tier="B",
            total_score=65,
            coverage_lines=["gl"],
            loss_by_line={"gl": {"claim_count": 3, "incurred": Decimal("30000")}},
            indicated_total=Decimal("100000"),
            **kw,
        )

    def test_recommend_without_ultimate_uses_incurred(self):
        rec = recommend(self._base_inputs())
        # 30000/100000 = 0.30 → boundary → lean_credit
        assert rec.rate_adequacy == "lean_credit"
        assert rec.grounding["ultimate_total"] is None

    def test_recommend_with_ultimate_uses_it(self):
        rec = recommend(self._base_inputs(ultimate_total=Decimal("85000")))
        assert rec.rate_adequacy == "lean_debit"
        assert rec.grounding["ultimate_total"] == "85000"
        assert "chain-ladder" in rec.rate_adequacy_note

    def test_ultimate_total_in_grounding(self):
        rec = recommend(self._base_inputs(ultimate_total=Decimal("50000")))
        assert "ultimate_total" in rec.grounding
        assert rec.grounding["ultimate_total"] == "50000"
