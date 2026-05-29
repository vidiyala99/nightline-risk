"""Deterministic signal-fusion engine.

A `Signal` is a factor-agnostic (provenance, severity, status) triple. The
engine folds a list of signals into a 0-100 factor score by summing each
signal's weight (provenance x severity x status) into a "load" and mapping it
through an exponential-decay curve, mirroring `_incident_weight` in scoring.py.

Generality lives here: any factor that can express its data as `Signal`s scores
through `fuse()`. No wall-clock time is consulted — same inputs, same score.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

PROVENANCE_WEIGHT = {
    "underwriter_verified": 1.0,
    "ingested": 0.9,
    "operator_reported": 0.6,
    "auto_generated": 0.3,
}
SEVERITY_WEIGHT = {"urgent": 2.5, "high": 1.5, "medium": 1.0, "low": 0.5}
STATUS_WEIGHT = {"open": 1.0, "resolved": 0.2}

# Per-factor decay constant. Compliance: 1 verified-open item -> ~70.
COMPLIANCE_K = 2.8


@dataclass(frozen=True)
class Signal:
    provenance: str
    severity: str
    status: str


def signal_weight(s: Signal) -> float:
    """How much a single signal contributes to the load. Unknown enum values
    raise KeyError (fail loud) — they should be impossible past the Literal
    columns on write."""
    return (
        PROVENANCE_WEIGHT[s.provenance]
        * SEVERITY_WEIGHT[s.severity]
        * STATUS_WEIGHT[s.status]
    )


def fuse(signals: list[Signal], k: float) -> int:
    """Fold signals into a 0-100 score. Higher score = lower risk."""
    load = sum(signal_weight(s) for s in signals)
    return max(0, min(100, round(100 * math.exp(-load / k))))
