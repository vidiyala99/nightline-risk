"""Operator finding: an open incident with no attached evidence is a
claim-defense exposure (most venue claims fail on thin documentation)."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import IncidentRecord, EvidenceFile
from app.schemas.domain import Citation

OPEN_STATUSES = ("open", "under_review")


def find(scope: FindingScope) -> list[Finding]:
    if not scope.venue_ids:
        return []
    q = select(IncidentRecord).where(
        IncidentRecord.venue_id.in_(scope.venue_ids),
        IncidentRecord.status.in_(OPEN_STATUSES),
    )
    findings: list[Finding] = []
    for inc in scope.session.exec(q).all():
        has_evidence = scope.session.exec(
            select(EvidenceFile.id).where(EvidenceFile.incident_id == inc.id)
        ).first()
        if has_evidence:
            continue
        severe = inc.injury_observed or inc.police_called or inc.ems_called
        findings.append(Finding(
            id=f"evidence_gap:incident:{inc.id}",
            persona="venue_operator",
            kind="evidence_gap",
            subject=Subject(
                entity_type="incident", entity_id=inc.id,
                label=inc.summary[:80], href=f"/incidents/{inc.id}",
            ),
            severity="high" if severe else "medium",
            why=[Citation(
                source_id=inc.id, source_type="incident",
                excerpt=inc.summary[:240],
            )],
            recommended_action=RecommendedAction(
                label="Attach evidence to defend this incident",
                href=f"/incidents/{inc.id}",
            ),
            prediction=Prediction(
                claim="If a claim is filed on this incident it will likely be "
                      "denied or disputed for insufficient evidence.",
                falsifiable_by="claim_outcome",
                horizon="on_claim",
            ),
            venue_id=inc.venue_id,
        ))
    return findings
