"""Cost-safety guards for the copilot LLM path — the prerequisites for pointing
the copilot at a *paid* provider (xAI Grok). Two concerns:

  - Rate limiting: a single operator token can't burn unbounded credits.
  - Telemetry: every LLM call's outcome + token cost is recorded, so spend and
    the deterministic-fallback rate are visible instead of silent.
"""
from __future__ import annotations

from app.copilot.rate_limit import FixedWindowRateLimiter
from app.copilot.llm_telemetry import estimate_cost_usd, format_call_log


class TestFixedWindowRateLimiter:
    def test_allows_up_to_limit_then_blocks_within_window(self):
        rl = FixedWindowRateLimiter(limit=3, window_seconds=60)
        assert rl.allow("u1", now=1000.0)
        assert rl.allow("u1", now=1001.0)
        assert rl.allow("u1", now=1002.0)
        assert not rl.allow("u1", now=1003.0)  # 4th within the window → blocked

    def test_window_resets_after_it_elapses(self):
        rl = FixedWindowRateLimiter(limit=1, window_seconds=60)
        assert rl.allow("u1", now=1000.0)
        assert not rl.allow("u1", now=1030.0)  # still inside the 60s window
        assert rl.allow("u1", now=1061.0)      # window elapsed → allowed again

    def test_keys_are_isolated(self):
        rl = FixedWindowRateLimiter(limit=1, window_seconds=60)
        assert rl.allow("u1", now=1000.0)
        assert rl.allow("u2", now=1000.0)      # different user unaffected
        assert not rl.allow("u1", now=1000.0)  # u1 still capped


class TestCostEstimate:
    def test_grok_4_fast_known_math(self):
        # 1M input @ $0.20 + 1M output @ $0.50 = $0.70
        assert round(estimate_cost_usd("grok-4-fast", 1_000_000, 1_000_000), 4) == 0.70

    def test_grok_4_is_the_expensive_default(self):
        # grok-4 is $3 / $15 — the price trap if LLM_MODEL is left unset.
        assert round(estimate_cost_usd("grok-4", 1_000_000, 1_000_000), 4) == 18.0

    def test_unknown_model_degrades_to_zero_not_crash(self):
        assert estimate_cost_usd("mystery-model", 1000, 1000) == 0.0


class TestCallLog:
    def test_success_log_carries_cost_and_outcome(self):
        line = format_call_log(
            provider="grok", model="grok-4-fast",
            prompt_tokens=2000, completion_tokens=500,
            latency_ms=420, outcome="success",
        )
        assert "grok-4-fast" in line
        assert "success" in line
        assert "cost_usd" in line

    def test_fallback_log_carries_reason(self):
        line = format_call_log(
            provider="grok", model="grok-4-fast",
            prompt_tokens=0, completion_tokens=0,
            latency_ms=10, outcome="fallback", fallback_reason="HTTP 429",
        )
        assert "fallback" in line
        assert "429" in line
