"""Carrier finding: an open claim whose reserve looks inadequate."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Claim
from app.schemas.domain import Citation


# Any claim status starting with "closed" is terminal for this finding.
def _is_open(status: str) -> bool:
    return not status.startswith("closed")


def find(scope: FindingScope) -> list[Finding]:
    findings: list[Finding] = []
    for clm in scope.session.exec(select(Claim)).all():
        if not _is_open(clm.status):
            continue
        paid = (clm.indemnity_paid_to_date or 0) + (clm.expense_paid_to_date or 0)
        reserve = clm.current_reserve or 0
        # Light if paid has caught up to/exceeded the reserve, or reserve is zero
        # on an open claim.
        if reserve == 0 or paid > reserve:
            findings.append(Finding(
                id=f"reserve_light:claim:{clm.id}",
                persona="carrier",
                kind="reserve_light",
                subject=Subject(entity_type="claim", entity_id=clm.id,
                                label=clm.carrier_claim_number or clm.id,
                                href=f"/adjusting/{clm.id}"),
                severity="high",
                why=[Citation(source_id=clm.id, source_type="claim",
                              excerpt=f"Paid {paid} vs reserve {reserve} on an open claim.")],
                recommended_action=RecommendedAction(
                    label="Review reserve adequacy", href=f"/adjusting/{clm.id}"),
                prediction=Prediction(
                    claim="An inadequate reserve understates incurred loss and will "
                          "require an upward development.",
                    falsifiable_by="reserve_change", horizon="claim_life"),
                venue_id=None,
            ))
    return findings
