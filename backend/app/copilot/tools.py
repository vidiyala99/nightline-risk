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
            # Count queries answer with a number + a link to the full surface,
            # not a wall of per-item chips. The count is grounded by ``data``.
            "nav_href": "/dashboard",
            "nav_label": "Open what needs your attention",
        },
        citations=[],
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
            "nav_href": f"/risk-profile/{venue_id}",
            "nav_label": "View the full risk profile",
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
            "nav_href": "/claims",
            "nav_label": "View open claims",
        },
        citations=[],
    )


def list_incidents(scope: CopilotScope, args: dict) -> ToolResult:
    """The owning venue's incident-status feed (incident → packet → proposal →
    claim chain). Reuses ``incident_status_feed`` — the same helper the
    ``/venues/{id}/incident-status-feed`` route calls."""
    venue_id = scope.primary_venue_id
    if not venue_id:
        return ToolResult(tool="list_incidents", data={"count": 0, "items": []}, citations=[])

    feed = incident_status_feed(scope.session, venue_id)
    # Match the dashboard's "Open Incidents" stat exactly (IncidentRecord.status
    # == "open"), so the copilot's number agrees with what the operator sees on
    # their home rather than counting the whole archive.
    open_incidents = [r for r in feed if r.get("status") == "open"]
    return ToolResult(
        tool="list_incidents",
        data={
            "count": len(open_incidents),
            "items": open_incidents,
            "nav_href": "/incidents",
            "nav_label": "View open incidents",
        },
        citations=[],
    )


TOOL_CATALOG: list[ToolDef] = [
    ToolDef("get_exposure", "read", get_exposure),
    ToolDef("get_risk_score", "read", get_risk_score),
    ToolDef("list_open_claims", "read", list_open_claims),
    ToolDef("list_incidents", "read", list_incidents),
]


# ─── Act tools (Task 3, two-phase confirm-gated) ────────────────────────────
#
# Each operator action is two-phase:
#   - ``validate_*`` runs the gate and returns an ``ActValidation`` carrying a
#     ``ProposedAction`` (NO side effects) — phase 1, surfaced for confirm.
#   - ``execute_*`` re-validates, then performs the action through the EXISTING
#     audited service (``create_proposal`` / the shared compliance-upload sync
#     service) — phase 2. Never autonomous; the model proposes, the server acts
#     only on an explicit confirm.

from dataclasses import dataclass as _dc

from sqlmodel import select

from app.copilot.schemas import ProposedAction
from app.models import ClaimProposal, UnderwritingPacket


@_dc
class ActValidation:
    ok: bool
    reason: str = ""
    proposed: Optional[ProposedAction] = None


def _primary_packet_for_incident(session: Session, incident_id: str) -> Optional[UnderwritingPacket]:
    return session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == incident_id)
    ).first()


def validate_send_to_broker(scope: CopilotScope, incident_id: str) -> ActValidation:
    """Phase 1: is this incident eligible to be routed to the broker?

    Blocks when (a) no packet exists, (b) it's already been sent, (c) there's
    no active policy to file against, or (d) it isn't in the operator-decision
    band. Otherwise returns a confirmable ``ProposedAction``."""
    from app.claim_routing import recommendation_for_packet, route_status

    pkt = _primary_packet_for_incident(scope.session, incident_id)
    if pkt is None:
        return ActValidation(False, "No insurance report exists for that incident yet.")
    existing = scope.session.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == pkt.id)
    ).first()
    if existing is not None:
        return ActValidation(False, "That incident has already been sent to your broker.")
    rec = recommendation_for_packet(scope.session, pkt)
    if not rec.has_active_policy:
        return ActValidation(
            False,
            "There's no active policy to file against — talk to your broker about coverage.",
        )
    if route_status(rec) != "borderline":
        return ActValidation(False, "That incident isn't in the operator-decision band.")
    sign = "+" if rec.net_expected_value_usd >= 0 else "-"
    return ActValidation(True, proposed=ProposedAction(
        kind="send_to_broker", target_id=incident_id,
        summary=f"Send this incident to your broker (net {sign}${abs(rec.net_expected_value_usd):,}).",
        gating_passed=True))


def execute_send_to_broker(scope: CopilotScope, incident_id: str) -> ToolResult:
    """Phase 2: route the incident through ``create_proposal`` (idempotent per
    packet, so a re-confirm reuses the existing proposal rather than duplicating)."""
    from app.claim_proposals import create_proposal
    from app.claim_recommendation import recommendation_to_dict
    from app.claim_routing import recommendation_for_packet

    v = validate_send_to_broker(scope, incident_id)
    if not v.ok:
        return ToolResult(tool="send_to_broker", data={"executed": False, "reason": v.reason})
    pkt = _primary_packet_for_incident(scope.session, incident_id)
    rec = recommendation_for_packet(scope.session, pkt)
    proposal = create_proposal(
        session=scope.session, packet_id=pkt.id,
        operator_id=scope.user.get("user_id", "operator"),
        override_recommendation=False, override_reason=None, override_freetext=None,
        recommendation_snapshot=recommendation_to_dict(rec),
    )
    return ToolResult(
        tool="send_to_broker",
        data={"executed": True, "proposal_id": proposal.id, "state": proposal.state},
        citations=[Citation(
            source_id=proposal.id, source_type="claim_proposal",
            excerpt="Sent to broker · awaiting decision",
        )],
    )


def validate_resolve_compliance(scope: CopilotScope, item_id: str) -> ActValidation:
    """Phase 1: is this compliance item resolvable by uploading evidence?

    Blocks unknown / already-resolved items; otherwise returns a confirmable
    ``ProposedAction`` flagged ``requires_attachment`` (the operator must attach
    the evidence file on confirm)."""
    from app.main import _find_compliance_item, _resolve_venue

    vid = scope.primary_venue_id
    venue = _resolve_venue(vid, scope.session)
    item = _find_compliance_item(vid, venue, item_id, session=scope.session)
    if item is None:
        return ActValidation(False, "I can't find that compliance item.")
    if getattr(item, "status", "") == "resolved":
        return ActValidation(False, "That item is already resolved.")
    return ActValidation(True, proposed=ProposedAction(
        kind="resolve_compliance", target_id=item_id,
        summary=f"Resolve “{item.description}” by uploading the required evidence.",
        gating_passed=True, requires_attachment=True))


def execute_resolve_compliance(
    scope: CopilotScope, item_id: str, *,
    file_bytes: Optional[bytes] = None,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> ToolResult:
    """Phase 2: persist the attached evidence + resolve the item through the
    shared ``upload_compliance_evidence_sync`` service (same path the HTTP
    upload route uses). An attachment is mandatory — resolving without one is
    refused."""
    from app.services.compliance_upload import upload_compliance_evidence_sync

    v = validate_resolve_compliance(scope, item_id)
    if not v.ok:
        return ToolResult(tool="resolve_compliance", data={"executed": False, "reason": v.reason})
    if not file_bytes:
        return ToolResult(
            tool="resolve_compliance",
            data={"executed": False, "reason": "Attach the evidence file to resolve this item."},
        )
    result = upload_compliance_evidence_sync(
        scope.session, scope.primary_venue_id, item_id,
        file_bytes, filename, content_type,
        uploaded_by=scope.user.get("user_id", "operator"),
    )
    return ToolResult(
        tool="resolve_compliance",
        data={"executed": True, **result},
        citations=[Citation(
            source_id=item_id, source_type="compliance",
            excerpt="Evidence uploaded · item resolved",
        )],
    )


TOOL_CATALOG += [
    ToolDef("send_to_broker", "act",
            lambda scope, args: execute_send_to_broker(scope, args["target_id"])),
    ToolDef("resolve_compliance", "act",
            lambda scope, args: execute_resolve_compliance(
                scope, args["target_id"],
                file_bytes=args.get("file_bytes"),
                filename=args.get("filename"),
                content_type=args.get("content_type"),
            )),
]
