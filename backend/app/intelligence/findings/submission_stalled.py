"""Broker finding: a non-terminal submission with no movement for too long."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.lifecycles import SUBMISSION_TERMINAL_STATES
from app.models import Submission
from app.schemas.domain import Citation
from app.time import as_utc

STALE_AFTER_DAYS = 14
VERY_STALE_DAYS = 30
# Sourced directly from app.lifecycles so it can't drift. The real terminal set
# is {"bound", "lost", "declined", "withdrawn"} — there is no "expired"
# submission status (that exists on CarrierQuote, not Submission).
TERMINAL = SUBMISSION_TERMINAL_STATES


def find(scope: FindingScope) -> list[Finding]:
    q = select(Submission)
    if scope.venue_ids is not None:
        q = q.where(Submission.venue_id.in_(scope.venue_ids))
    findings: list[Finding] = []
    for sub in scope.session.exec(q).all():
        if sub.status in TERMINAL:
            continue
        updated = as_utc(sub.updated_at)
        if updated is None:
            continue
        age = (scope.now - updated).days
        if age <= STALE_AFTER_DAYS:
            continue
        findings.append(Finding(
            id=f"submission_stalled:submission:{sub.id}",
            persona="broker",
            kind="submission_stalled",
            subject=Subject(entity_type="submission", entity_id=sub.id,
                            label=sub.id, href=f"/submissions/{sub.id}"),
            severity="high" if age > VERY_STALE_DAYS else "medium",
            why=[Citation(source_id=sub.id, source_type="submission",
                          excerpt=f"Status '{sub.status}', no movement for {age} days.")],
            recommended_action=RecommendedAction(
                label="Follow up on this submission", href=f"/submissions/{sub.id}"),
            prediction=Prediction(
                claim="A stalled submission risks the effective date and the placement.",
                falsifiable_by="submission_status", horizon="effective_date"),
            venue_id=sub.venue_id,
        ))
    return findings
