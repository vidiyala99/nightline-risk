"""Operator finding: an open compliance item, escalated by age."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import ComplianceSignal
from app.schemas.domain import Citation
from app.time import as_utc

# severity from the signal, escalated one step if older than this.
ESCALATE_AFTER_DAYS = 30
_BUMP = {"low": "medium", "medium": "high", "high": "high", "urgent": "critical"}


def find(scope: FindingScope) -> list[Finding]:
    if not scope.venue_ids:
        return []
    q = select(ComplianceSignal).where(
        ComplianceSignal.venue_id.in_(scope.venue_ids),
        ComplianceSignal.status == "open",
    )
    findings: list[Finding] = []
    for sig in scope.session.exec(q).all():
        severity = sig.severity
        created = as_utc(sig.created_at)
        if created is not None and (scope.now - created).days > ESCALATE_AFTER_DAYS:
            severity = _BUMP.get(sig.severity, sig.severity)
        findings.append(Finding(
            id=f"compliance_overdue:compliance:{sig.id}",
            persona="venue_operator",
            kind="compliance_overdue",
            subject=Subject(
                entity_type="compliance", entity_id=sig.id,
                label=sig.title[:80], href="/compliance",
            ),
            severity=severity,
            why=[Citation(source_id=sig.id, source_type="compliance",
                          excerpt=sig.description[:240])],
            recommended_action=RecommendedAction(
                label="Resolve this compliance item", href="/compliance",
            ),
            prediction=Prediction(
                claim="Unresolved compliance items raise premium or risk "
                      "non-renewal at the next term.",
                falsifiable_by="renewal_outcome", horizon="renewal",
            ),
            venue_id=sig.venue_id,
        ))
    return findings
