# backend/app/ingestion/comms/classifier.py
"""Classify a CommsItem into incident / compliance / noise.

Default is a deterministic keyword classifier (testable, no LLM). Prod can inject
an LLM-backed `classifier` callable with the same signature — the routing and
eval-gating around it never change.
"""
from __future__ import annotations

from typing import Callable, Optional

from app.ingestion.comms.types import CommsClassification, CommsItem

_INCIDENT_KW = ["fight", "punch", "assault", "altercation", "weapon", "injured",
                "injury", "slip", "ems", "ambulance", "cops", "police", "blood"]
_AB_KW = ["fight", "punch", "assault", "altercation", "weapon"]
_COMPLIANCE_KW = ["exit sign", "extinguisher", "expired", "first aid", "cert",
                  "license", "permit", "inspection", "blocked", "fire"]


def _deterministic(item: CommsItem) -> CommsClassification:
    t = item.text.lower()
    inc = sum(k in t for k in _INCIDENT_KW)
    comp = sum(k in t for k in _COMPLIANCE_KW)
    if inc and inc >= comp:
        return CommsClassification(
            kind="incident",
            confidence=min(0.7 + 0.1 * inc, 0.99),
            fields={"category": "a_and_b" if any(k in t for k in _AB_KW) else "general"},
            rationale=f"matched {inc} incident cue(s)",
        )
    if comp:
        return CommsClassification(
            kind="compliance",
            confidence=min(0.7 + 0.1 * comp, 0.99),
            fields={"compliance_type": "facility"},
            rationale=f"matched {comp} compliance cue(s)",
        )
    return CommsClassification(kind="noise", confidence=0.8, rationale="no incident/compliance cues")


def classify_comms_item(
    item: CommsItem,
    *,
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> CommsClassification:
    return (classifier or _deterministic)(item)
