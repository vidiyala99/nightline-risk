"""Fraud / SIU agent — deterministic claims-fraud screen for the packet flow.

Sibling to corroboration_agent: a pure function that turns incident metadata and
(optionally) corroboration results into an explainable, scored FraudSignal. No DB
access; callers assemble the inputs. See
docs/superpowers/specs/2026-06-04-fraud-siu-agent-design.md.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone


def _high_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_HIGH", "0.55"))


def _elevated_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_ELEVATED", "0.30"))


def _low_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_LOW", "0.10"))


@dataclass(frozen=True)
class FraudFlag:
    code: str
    label: str
    weight: float
    detail: str


@dataclass(frozen=True)
class FraudSignal:
    score: float
    tier: str
    red_flags: list  # list[FraudFlag]
    summary: str
    assessed_stage: str  # "v1" | "v2"

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "tier": self.tier,
            "red_flags": [asdict(f) for f in self.red_flags],
            "summary": self.summary,
            "assessed_stage": self.assessed_stage,
        }


def tier_for_score(score: float) -> str:
    if score >= _high_threshold():
        return "high"
    if score >= _elevated_threshold():
        return "elevated"
    if score >= _low_threshold():
        return "low"
    return "none"
