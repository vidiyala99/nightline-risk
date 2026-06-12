"""Broker finding: an in-flight renewal whose proposed terms REDUCE coverage vs
the expiring policy is direct broker E&O exposure.

This is the #1 broker-E&O fact pattern — the silently dropped line, the added
exclusion, the lowered limit / raised attachment point at renewal that the broker
didn't catch and got sued over. Detected purely from structured `coverage_terms`
on both sides (no document upload). Cites each adverse change.
"""
from __future__ import annotations

from sqlmodel import col, select

from app.coverage.renewal_review import review_renewal
from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Submission
from app.schemas.domain import Citation

# A renewal is only diffable while it's still in flight (a quote in hand, not yet
# bound/dead). review_renewal returns None for non-renewals, so fresh business is
# naturally skipped.
INFLIGHT = ("open", "in_market", "quoting")


def find(scope: FindingScope) -> list[Finding]:
    q = select(Submission).where(col(Submission.status).in_(INFLIGHT))
    if scope.venue_ids is not None:
        q = q.where(col(Submission.venue_id).in_(scope.venue_ids))

    findings: list[Finding] = []
    for sub in scope.session.exec(q).all():
        result = review_renewal(scope.session, sub)
        if result is None:
            continue
        expiring, diff = result
        if not (diff.has_adverse or diff.carrier_changed):
            continue
        # A coverage reduction (dropped line / carved-out exclusion) is the
        # serious E&O gap; a limit-only or carrier-only change is a lesser flag.
        severity = "high" if (diff.dropped_lines or diff.added_exclusions) else "medium"
        msgs = diff.adverse_findings or ["carrier changed at renewal"]
        findings.append(Finding(
            id=f"renewal_term_drift:submission:{sub.id}",
            persona="broker",
            kind="renewal_term_drift",
            # Subject is the expiring policy (the thing at risk) so the
            # acknowledge → E&O-trail wiring works; href points at the renewal
            # submission where the broker acts.
            subject=Subject(entity_type="policy", entity_id=expiring.id,
                            label=expiring.policy_number or expiring.id,
                            href=f"/submissions/{sub.id}"),
            severity=severity,
            why=[Citation(source_id=sub.id, source_type="policy", excerpt=m) for m in msgs],
            recommended_action=RecommendedAction(
                label="Review renewal coverage changes (E&O)",
                href=f"/submissions/{sub.id}"),
            prediction=Prediction(
                claim=f"The renewal reduces coverage vs the expiring policy "
                      f"({msgs[0]}) — a loss in that gap would be an uncovered "
                      f"E&O exposure.",
                falsifiable_by="claim_outcome", horizon="on_renewal"),
            venue_id=sub.venue_id,
        ))
    return findings
