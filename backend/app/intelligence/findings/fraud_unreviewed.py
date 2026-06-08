"""Carrier finding: a CONTRADICTED corroboration verdict needs human review.

v1 limitation: there is no per-analysis review marker yet, so every CONTRADICTED
verdict surfaces (the finding itself is the review surface). When a review marker
lands, filter on it here."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import EvidenceAnalysis
from app.schemas.domain import Citation

FLAGGED = ("CONTRADICTED",)


def find(scope: FindingScope) -> list[Finding]:
    q = select(EvidenceAnalysis).where(
        EvidenceAnalysis.corroboration.in_(FLAGGED),
        EvidenceAnalysis.status == "complete",
    )
    findings: list[Finding] = []
    for ea in scope.session.exec(q).all():
        findings.append(Finding(
            id=f"fraud_unreviewed:incident:{ea.incident_id}",
            persona="carrier",
            kind="fraud_unreviewed",
            subject=Subject(entity_type="incident", entity_id=ea.incident_id,
                            label=ea.incident_id, href=f"/incidents/{ea.incident_id}"),
            severity="high",
            why=[Citation(source_id=ea.id, source_type="evidence_analysis",
                          excerpt=f"Evidence corroboration: {ea.corroboration}.")],
            recommended_action=RecommendedAction(
                label="Review contradicted evidence", href=f"/incidents/{ea.incident_id}"),
            prediction=Prediction(
                claim="A contradicted corroboration left unreviewed risks paying a "
                      "fraudulent or misstated claim.",
                falsifiable_by="review_decision", horizon="claim_life"),
            venue_id=None,
        ))
    return findings
