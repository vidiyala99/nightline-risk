from __future__ import annotations

from pydantic import BaseModel

from app.schemas.domain import Citation


class SubjectOut(BaseModel):
    entity_type: str
    entity_id: str
    label: str = ""
    href: str = ""


class RecommendedActionOut(BaseModel):
    label: str
    href: str = ""


class PredictionOut(BaseModel):
    claim: str
    falsifiable_by: str = ""
    horizon: str = ""


class FindingOut(BaseModel):
    id: str
    persona: str
    kind: str
    subject: SubjectOut
    severity: str
    severity_rank: int
    why: list[Citation]
    recommended_action: RecommendedActionOut
    prediction: PredictionOut
    venue_id: str | None = None


class ExposureResponse(BaseModel):
    persona: str
    findings: list[FindingOut]
