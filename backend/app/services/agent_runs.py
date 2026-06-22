"""Read service over the AgentRun oversight ledger.

Read-only: never commits. Venue scope is resolved at query time (no venue_id
column on AgentRun) and enforced via app.auth.accessible_venue_ids — broker/admin
see all runs; operators see only runs whose entity resolves to one of their
venues; null-entity (unattributable) runs are operator-invisible.
"""
from __future__ import annotations

from typing import Optional

from sqlmodel import Session

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
