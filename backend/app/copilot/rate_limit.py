"""Per-user rate limiting for the copilot LLM surface.

A single operator token must not be able to burn unbounded LLM credits (the
backlog's key-day prerequisite: "any token can burn the LLM quota"). This is a
small in-memory fixed-window limiter — sufficient on a single-worker Railway
deploy. Under >1 worker the limit is per-process (looser, still bounded); a
shared store (Redis) is the upgrade if/when the deploy scales out.
"""
from __future__ import annotations

import os
import time


class FixedWindowRateLimiter:
    """Allow at most `limit` calls per `window_seconds`, keyed by an arbitrary
    string (here: the operator's user id). `now` is injectable for deterministic
    tests; in production it defaults to a monotonic clock."""

    def __init__(self, *, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str, *, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        recent = [t for t in self._hits.get(key, []) if now - t < self.window]
        if len(recent) >= self.limit:
            self._hits[key] = recent  # prune even on rejection so memory is bounded
            return False
        recent.append(now)
        self._hits[key] = recent
        return True


def _build_default_limiter() -> FixedWindowRateLimiter:
    # Generous default — protects against a runaway loop / abuse, not normal use.
    per_min = int(os.getenv("COPILOT_RATE_LIMIT_PER_MIN", "20"))
    return FixedWindowRateLimiter(limit=per_min, window_seconds=60.0)


# Process-wide singleton the copilot router consults.
COPILOT_LIMITER = _build_default_limiter()
