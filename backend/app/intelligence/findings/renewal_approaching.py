"""Operator finding: an in-force policy nearing expiration."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy
from app.schemas.domain import Citation

WINDOW_DAYS = 60
IN_FORCE = ("active", "bound_pending_number")


def _severity(days: int) -> str:
    if days <= 14:
        return "high"
    if days <= 30:
        return "medium"
    return "low"


def find(scope: FindingScope) -> list[Finding]:
    if not scope.venue_ids:
        return []
    q = select(Policy).where(
        Policy.venue_id.in_(scope.venue_ids),
        Policy.status.in_(IN_FORCE),
    )
    today = scope.now.date()
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        days = (pol.expiration_date - today).days
        if days < 0 or days > WINDOW_DAYS:
            continue
        findings.append(Finding(
            id=f"renewal_approaching:policy:{pol.id}",
            persona="venue_operator",
            kind="renewal_approaching",
            subject=Subject(
                entity_type="policy", entity_id=pol.id,
                label=pol.policy_number or pol.id, href=f"/policies/{pol.id}",
            ),
            severity=_severity(days),
            why=[Citation(source_id=pol.id, source_type="policy",
                          excerpt=f"Expires {pol.expiration_date.isoformat()} ({days} days).")],
            recommended_action=RecommendedAction(
                label="Review upcoming renewal", href=f"/policies/{pol.id}",
            ),
            prediction=Prediction(
                claim="Policy will lapse if not renewed by its expiration date.",
                falsifiable_by="policy_status", horizon="expiration_date",
            ),
            venue_id=pol.venue_id,
        ))
    return findings
