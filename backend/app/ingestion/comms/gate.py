# backend/app/ingestion/comms/gate.py
"""Eval-calibrated routing gate. Auto-create only when confidence clears the
per-kind threshold (tuned for >=0.90 precision on the eval set); else send to a
human. `noise` below its confidence threshold also goes to review so a possible
incident is never silently dropped."""
from __future__ import annotations

from typing import Literal

from app.ingestion.comms.types import CommsClassification

# Tune against app/evals/comms_classifier_eval.py.
# incident/compliance thresholds target ≥0.90 precision on the eval set.
# Requires ≥2 classifier keyword cues per message (deterministic scorer gives
# 0.70+0.1*n confidence, so 2 cues → 0.90, 1 cue → 0.80 → routes to review).
AUTO_CREATE_THRESHOLD: dict[str, float] = {
    "incident": 0.90,
    "compliance": 0.85,
    "noise": 0.75,
}

Decision = Literal["auto", "review", "drop"]


def decide(c: CommsClassification) -> Decision:
    if c.kind == "noise":
        return "drop" if c.confidence >= AUTO_CREATE_THRESHOLD["noise"] else "review"
    return "auto" if c.confidence >= AUTO_CREATE_THRESHOLD[c.kind] else "review"
