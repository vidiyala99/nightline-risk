"""Read service over the AgentRun oversight ledger.

Read-only: never commits. Venue scope is resolved at query time (no venue_id
column on AgentRun) and enforced via app.auth.accessible_venue_ids — broker/admin
see all runs; operators see only runs whose entity resolves to one of their
venues; null-entity (unattributable) runs are operator-invisible.
"""
from __future__ import annotations

from typing import Optional

from sqlmodel import Session, select

from app.auth import accessible_venue_ids
from app.models import AgentRun, IncidentRecord


class AgentRunsError(Exception):
    """Typed service error — the router maps it to HTTP 400."""


def resolve_run_venue(run: AgentRun, session: Session) -> Optional[str]:
    """Resolve the venue a run is attributable to, or None if unattributable.

    Dispatch on entity_type. Today only 'incident' is written (PR2); Phase-2
    entity types (claim, packet) add a branch here without touching callers."""
    if run.entity_type == "incident" and run.entity_id:
        inc = session.get(IncidentRecord, run.entity_id)
        return inc.venue_id if inc else None
    return None


def _accessible_incident_ids(venue_ids: set[str], session: Session) -> set[str]:
    rows = session.exec(
        select(IncidentRecord.id).where(IncidentRecord.venue_id.in_(venue_ids))
    ).all()
    return set(rows)


def _scoped_query(user: dict | None, session: Session):
    """Base select(AgentRun) with venue scope applied, or None if the caller
    can see nothing. Broker/admin (scope None) get an unrestricted query."""
    scope = accessible_venue_ids(user, session)
    stmt = select(AgentRun)
    if scope is None:
        return stmt
    if not scope:
        return None
    inc_ids = _accessible_incident_ids(scope, session)
    if not inc_ids:
        return None
    return stmt.where(
        AgentRun.entity_type == "incident", AgentRun.entity_id.in_(inc_ids)
    )


def list_runs(
    user: dict | None,
    session: Session,
    *,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    agent_kind: Optional[str] = None,
    outcome: Optional[str] = None,
    limit: int = 50,
) -> list[AgentRun]:
    limit = max(1, min(limit, 200))
    stmt = _scoped_query(user, session)
    if stmt is None:
        return []
    if entity_type is not None:
        stmt = stmt.where(AgentRun.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(AgentRun.entity_id == entity_id)
    if agent_kind is not None:
        stmt = stmt.where(AgentRun.agent_kind == agent_kind)
    if outcome is not None:
        stmt = stmt.where(AgentRun.outcome == outcome)
    stmt = stmt.order_by(AgentRun.created_at.desc()).limit(limit)
    return list(session.exec(stmt).all())
