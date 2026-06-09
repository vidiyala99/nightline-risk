"""Copilot READ tools + scope + catalog (Task 2, spec §4).

Four read tools wrap the existing persona-gated services:

  - ``get_exposure``      -> app.intelligence.engine.compute_exposure
  - ``get_risk_score``    -> app.underwriting.get_risk_score
  - ``list_open_claims``  -> app.services.claims.list_claims
  - ``list_incidents``    -> app.services.incident_feed.incident_status_feed

Each tool returns a ``ToolResult`` whose ``citations`` carry provenance (a
``Citation`` per item, or a single summary citation), so grounding travels
with the data and is never invented by the model layer downstream. The tools
reuse the SAME callables the HTTP routes use — one source of truth.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

from sqlmodel import Session

from app.copilot.schemas import ToolResult
from app.intelligence.engine import compute_exposure
from app.schemas.domain import Citation
from app.services.claims import list_claims
from app.services.incident_feed import incident_status_feed
from app.underwriting import get_risk_score as compute_risk_score


@dataclass
class CopilotScope:
    """Resolved request scope handed to every tool.

    ``user`` is the decoded token claims, ``venue_ids`` is the operator's
    accessible set (None for unrestricted personas), ``now`` is injected so
    time-dependent tools (risk decay) stay deterministic in tests.
    """
    user: dict
    venue_ids: Optional[set[str]]
    session: Session
    now: datetime

    @property
    def primary_venue_id(self) -> Optional[str]:
        return self.user.get("tenant_id") or (
            next(iter(self.venue_ids)) if self.venue_ids else None
        )


@dataclass
class ToolDef:
    name: str
    kind: str  # "read" | "act"
    run: Callable[["CopilotScope", dict], ToolResult]


# ─── Read tools ─────────────────────────────────────────────────────────


def get_exposure(scope: CopilotScope, args: dict) -> ToolResult:
    """Persona-gated proactive findings (evidence gaps, overdue compliance,
    renewals, …). Each finding becomes one citation so the panel's grounding
    survives into any downstream answer."""
    findings = compute_exposure(scope.user, scope.session, now=scope.now)
    return ToolResult(
        tool="get_exposure",
        data={
            "count": len(findings),
            "items": [
                {
                    "id": f.id,
                    "kind": f.kind,
                    "severity": f.severity,
                    "label": f.subject.label or f.subject.entity_id,
                    "action": f.recommended_action.label,
                    "href": f.subject.href,
                }
                for f in findings
            ],
        },
        citations=[
            Citation(
                source_id=f.id,
                source_type=f.kind,
                excerpt=(f.why[0].excerpt if f.why else f.recommended_action.label),
            )
            for f in findings
        ],
    )


def get_risk_score(scope: CopilotScope, args: dict) -> ToolResult:
    """The owning venue's underwriting risk score. Reuses the SAME
    ``get_risk_score`` engine the ``/venues/{id}/risk-score`` route calls, so
    the copilot can never quote a number the dashboard disagrees with."""
    venue_id = scope.primary_venue_id
    if not venue_id:
        return ToolResult(tool="get_risk_score", data={}, citations=[])

    from app.seed_data import VENUES

    if venue_id not in VENUES:
        return ToolResult(tool="get_risk_score", data={}, citations=[])

    result = compute_risk_score(venue_id, VENUES, session=scope.session, now=scope.now)
    score = result["total_score"]
    tier = result["tier"]
    factors = result.get("factors", {}) or {}

    # "Top factor" = the lowest-scoring weighted factor (the one dragging the
    # score down), so the copilot can name what to fix, not just the number.
    top_factor = ""
    worst = None
    for name, detail in factors.items():
        fscore = detail.get("score") if isinstance(detail, dict) else None
        if fscore is None:
            continue
        if worst is None or fscore < worst:
            worst = fscore
            top_factor = name

    return ToolResult(
        tool="get_risk_score",
        data={
            "venue_id": venue_id,
            "score": score,
            "tier": tier,
            "top_factor": top_factor,
            "factors": factors,
        },
        citations=[
            Citation(
                source_id=f"risk-{venue_id}",
                source_type="risk_score",
                excerpt=f"{score}/100 tier {tier}",
            )
        ],
    )


def list_open_claims(scope: CopilotScope, args: dict) -> ToolResult:
    """Open carrier-side claims for the owning venue. Reuses ``list_claims``
    (the same service the ``/venues/{id}/claims`` route calls) with
    ``open_only=True``."""
    venue_id = scope.primary_venue_id
    if not venue_id:
        return ToolResult(tool="list_open_claims", data={"count": 0, "items": []}, citations=[])

    claims = list_claims(scope.session, venue_id=venue_id, open_only=True)
    return ToolResult(
        tool="list_open_claims",
        data={
            "count": len(claims),
            "items": [
                {
                    "id": c.id,
                    "status": c.status,
                    "coverage": c.coverage_line,
                    "current_reserve": str(c.current_reserve),
                }
                for c in claims
            ],
        },
        citations=[
            Citation(
                source_id=c.id,
                source_type="claim",
                excerpt=f"{c.coverage_line} — {c.status} (reserve {c.current_reserve})",
            )
            for c in claims
        ],
    )


def list_incidents(scope: CopilotScope, args: dict) -> ToolResult:
    """The owning venue's incident-status feed (incident → packet → proposal →
    claim chain). Reuses ``incident_status_feed`` — the same helper the
    ``/venues/{id}/incident-status-feed`` route calls."""
    venue_id = scope.primary_venue_id
    if not venue_id:
        return ToolResult(tool="list_incidents", data={"count": 0, "items": []}, citations=[])

    feed = incident_status_feed(scope.session, venue_id)
    return ToolResult(
        tool="list_incidents",
        data={"count": len(feed), "items": feed},
        citations=[
            Citation(
                source_id=item["incident_id"],
                source_type="incident",
                excerpt=f"{item['summary']} — {item['status']}",
            )
            for item in feed
        ],
    )


TOOL_CATALOG: list[ToolDef] = [
    ToolDef("get_exposure", "read", get_exposure),
    ToolDef("get_risk_score", "read", get_risk_score),
    ToolDef("list_open_claims", "read", list_open_claims),
    ToolDef("list_incidents", "read", list_incidents),
]
