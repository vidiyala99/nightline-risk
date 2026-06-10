"""Broker finding: a policy nearing expiration with no renewal in motion."""
from __future__ import annotations

from sqlmodel import col, select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy, PolicyRequest
from app.schemas.domain import Citation
from app.services.renewals import find_live_renewal

WINDOW_DAYS = 60
IN_FORCE = ("active", "bound_pending_number")
# A renewal request that is still live counts as "in motion".
LIVE_REQUEST_STATUSES = ("pending", "approved")


def find(scope: FindingScope) -> list[Finding]:
    q = select(Policy).where(col(Policy.status).in_(IN_FORCE))
    if scope.venue_ids is not None:
        q = q.where(col(Policy.venue_id).in_(scope.venue_ids))
    today = scope.now.date()
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        days = (pol.expiration_date - today).days
        if days < 0 or days > WINDOW_DAYS:
            continue
        in_motion = scope.session.exec(
            select(PolicyRequest.id).where(
                PolicyRequest.policy_id == pol.id,
                PolicyRequest.request_type == "renewal",
                col(PolicyRequest.status).in_(LIVE_REQUEST_STATUSES),
            )
        ).first()
        if in_motion:
            continue
        # The canonical broker "Renew" action creates a renewal *Submission*
        # (prior_policy_id == pol.id), not a PolicyRequest — count it as in
        # motion too, otherwise the finding never clears after a broker renews.
        if find_live_renewal(scope.session, pol.id) is not None:
            continue
        findings.append(Finding(
            id=f"renewal_at_risk:policy:{pol.id}",
            persona="broker",
            kind="renewal_at_risk",
            subject=Subject(entity_type="policy", entity_id=pol.id,
                            label=pol.policy_number or pol.id, href=f"/policies/{pol.id}"),
            severity="high" if days <= 30 else "medium",
            why=[Citation(source_id=pol.id, source_type="policy",
                          excerpt=f"Expires in {days} days, no renewal request in motion.")],
            recommended_action=RecommendedAction(
                label="Start the renewal", href=f"/policies/{pol.id}"),
            prediction=Prediction(
                claim="Client will be uninsured at term if no renewal is placed.",
                falsifiable_by="policy_status", horizon="expiration_date"),
            venue_id=pol.venue_id,
        ))
    return findings
