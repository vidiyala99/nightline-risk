"""Telemetry for copilot LLM calls — makes spend and the deterministic-fallback
rate *visible* instead of a silent `print`. The prior failure path only printed
on error; now every call (success or fallback) emits a structured, parseable log
line carrying token counts, an estimated cost, latency, and outcome.

This is the lightweight (log-only) slice — enough to safely point the copilot at
a paid provider. A persisted/queryable `LlmCallRecord` table + dashboard is the
Track 14 follow-up.
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger("copilot.llm")

# (input $/M tokens, output $/M tokens). June 2026 list prices.
# xAI Grok via api.x.ai; Groq free-tier llama models carry no marginal $.
MODEL_PRICES: dict[str, tuple[float, float]] = {
    "grok-4-fast": (0.20, 0.50),
    "grok-4.3": (1.25, 2.50),
    "grok-4": (3.00, 15.00),
    "llama-3.1-8b-instant": (0.0, 0.0),
    "llama-3.3-70b-versatile": (0.0, 0.0),
}


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Best-effort USD estimate. Unknown models degrade to 0.0 (never crash the
    request path over a missing price)."""
    price = MODEL_PRICES.get(model)
    if not price:
        return 0.0
    in_per_m, out_per_m = price
    return (prompt_tokens / 1_000_000) * in_per_m + (completion_tokens / 1_000_000) * out_per_m


def format_call_log(
    *,
    provider: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    latency_ms: int,
    outcome: str,
    fallback_reason: str | None = None,
) -> str:
    payload: dict = {
        "event": "copilot_llm_call",
        "provider": provider,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "cost_usd": round(estimate_cost_usd(model, prompt_tokens, completion_tokens), 6),
        "latency_ms": latency_ms,
        "outcome": outcome,
    }
    if fallback_reason is not None:
        payload["fallback_reason"] = str(fallback_reason)[:200]
    return json.dumps(payload, default=str)


def log_llm_call(**kwargs) -> None:
    """Emit one structured telemetry line. Never raises — telemetry must not break
    the request it's measuring."""
    try:
        logger.info(format_call_log(**kwargs))
    except Exception:  # noqa: BLE001 — telemetry is best-effort
        pass
