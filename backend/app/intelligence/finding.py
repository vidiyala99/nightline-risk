"""Core types for the Risk Intelligence Layer.

A judgment module is a pure function `find(scope: FindingScope) -> list[Finding]`.
Findings are deterministic, persona-gated, and cited — no LLM, no retrieval.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, computed_field
from sqlmodel import Session

from app.schemas.domain import Citation

# Higher = more urgent. 0 is reserved for unknown severities so a typo can never
# outrank a real finding.
SEVERITY_RANK: dict[str, int] = {"critical": 4, "high": 3, "medium": 2, "low": 1}


def rank_for(severity: str) -> int:
    return SEVERITY_RANK.get(severity, 0)


# Which judgment kinds each persona is allowed to see. Enforced in code (the
# engine only runs these), never in a prompt. admin sees everything.
PERSONA_KINDS: dict[str, list[str]] = {
    "venue_operator": ["evidence_gap", "compliance_overdue", "renewal_approaching"],
    "broker": ["coverage_gap_eo", "renewal_at_risk", "submission_stalled"],
    "carrier": ["reserve_light", "fraud_unreviewed"],
}
PERSONA_KINDS["admin"] = [k for kinds in PERSONA_KINDS.values() for k in kinds]


class Subject(BaseModel):
    entity_type: str
    entity_id: str
    label: str = ""
    href: str = ""


class RecommendedAction(BaseModel):
    label: str
    href: str = ""


class Prediction(BaseModel):
    claim: str
    falsifiable_by: str = ""
    horizon: str = ""


class Finding(BaseModel):
    id: str
    persona: str
    kind: str
    subject: Subject
    severity: str
    why: list[Citation] = Field(default_factory=list)
    recommended_action: RecommendedAction
    prediction: Prediction
    venue_id: Optional[str] = None

    @computed_field  # type: ignore[misc]
    @property
    def severity_rank(self) -> int:
        return rank_for(self.severity)


@dataclass
class FindingScope:
    """Everything a judgment module needs, with persona scope already resolved.

    `venue_ids` is None for unrestricted personas (broker/admin) and a concrete
    set for operators (their tenant + extra_venue_ids). `now` is injected so
    time-window findings (renewals, staleness) are deterministically testable.
    """
    persona: str
    user: dict
    venue_ids: Optional[set[str]]
    session: Session
    now: datetime
