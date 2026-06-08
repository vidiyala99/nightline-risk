"""Broker finding: a bound policy missing a default-required coverage line is
direct E&O exposure for the broker."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy, CoverageLine
from app.schemas.domain import Citation
from app.defense_package import _as_list

IN_FORCE = ("active", "bound_pending_number")


def _scope_filter(q, scope: FindingScope):
    if scope.venue_ids is not None:
        q = q.where(Policy.venue_id.in_(scope.venue_ids))
    return q


def find(scope: FindingScope) -> list[Finding]:
    required = {
        cl.id for cl in scope.session.exec(
            select(CoverageLine).where(CoverageLine.is_required_by_default == True)  # noqa: E712
        ).all()
    }
    if not required:
        return []
    q = _scope_filter(select(Policy).where(Policy.status.in_(IN_FORCE)), scope)
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        have = set(_as_list(pol.coverage_lines))
        missing = sorted(required - have)
        if not missing:
            continue
        findings.append(Finding(
            id=f"coverage_gap_eo:policy:{pol.id}",
            persona="broker",
            kind="coverage_gap_eo",
            subject=Subject(entity_type="policy", entity_id=pol.id,
                            label=pol.policy_number or pol.id, href=f"/policies/{pol.id}"),
            severity="high",
            why=[Citation(source_id=pol.id, source_type="policy",
                          excerpt=f"Missing required coverage: {', '.join(missing)}.")],
            recommended_action=RecommendedAction(
                label="Close coverage gap (E&O exposure)", href=f"/policies/{pol.id}"),
            prediction=Prediction(
                claim="A loss on a missing required line is an uncovered E&O exposure.",
                falsifiable_by="claim_outcome", horizon="on_claim"),
            venue_id=pol.venue_id,
        ))
    return findings
