"""Broker finding: an in-force policy whose exclusions bite on the venue's
actual top loss exposure is direct E&O exposure for the broker.

The *exclusion* sibling of `coverage_gap_eo` (which flags a missing required
line). Where coverage_gap_eo asks "is a required coverage absent?", this asks
"is a coverage the venue demonstrably needs *carved back out* by an exclusion?"
— the canonical nightlife gap (an assault-&-battery exclusion on a venue whose
#1 loss is altercations). Every finding cites the governing exclusion clause.
"""
from __future__ import annotations

from sqlmodel import col, select

from app.coverage.exclusion_review import review_policy_exclusions
from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy

IN_FORCE = ("active", "bound_pending_number")


def _scope_filter(q, scope: FindingScope):
    if scope.venue_ids is not None:
        q = q.where(col(Policy.venue_id).in_(scope.venue_ids))
    return q


def find(scope: FindingScope) -> list[Finding]:
    q = _scope_filter(select(Policy).where(col(Policy.status).in_(IN_FORCE)), scope)
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        matches = review_policy_exclusions(scope.session, pol, now=scope.now)
        if not matches:
            continue
        top = matches[0]  # sorted: dominant exposure first
        # The venue's #1 loss being excluded is the serious E&O gap; an excluded
        # secondary exposure is a real but lesser concern.
        severity = "high" if top.exposure_rank == 1 else "medium"
        excluded = ", ".join(dict.fromkeys(m.category_label for m in matches))
        findings.append(Finding(
            id=f"coverage_exclusion_review:policy:{pol.id}",
            persona="broker",
            kind="coverage_exclusion_review",
            subject=Subject(entity_type="policy", entity_id=pol.id,
                            label=pol.policy_number or pol.id, href=f"/policies/{pol.id}/gaps"),
            severity=severity,
            why=[m.citation for m in matches],
            recommended_action=RecommendedAction(
                label="Review excluded exposure (E&O)",
                href=f"/policies/{pol.id}/gaps"),
            prediction=Prediction(
                claim=f"This venue's exposure to {top.category_label.lower()} is carved out "
                      f"by a policy exclusion — an uncovered E&O exposure ({excluded}).",
                falsifiable_by="claim_outcome", horizon="on_claim"),
            venue_id=pol.venue_id,
        ))
    return findings
