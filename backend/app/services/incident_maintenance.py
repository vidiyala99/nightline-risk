"""Incident-bloat control — keep the Safety Record honest without manual ops.

A long-running demo accumulates app-generated (`inc-…`) incidents through
triage / ingestion that are never closed, dragging the live incident load —
and the Safety Record factor — toward the floor. Two mechanisms address this,
both archiving to 'closed_archived' (NEVER deleting), preserving history +
audit trail:

  - `enforce_open_incident_cap`: bounds the number of OPEN app-generated
    incidents per venue. Invoked on every new filing
    (see app.incident_flow.create_brawl_incident_flow), so growth is bounded
    at write time rather than relying on a scheduled cleanup.
  - `archive_stale_incidents` / `find_stale_incidents`: age-based remediation.
    The callable core that `scripts/cleanup_stale_incidents.py` delegates to.

Seed rows (`seed-…`) are always preserved so re-seeding stays the source of
truth. Lifecycle transitions go through `assert_valid_transition` and emit an
`incident.closed_archived` audit event, matching the project's conventions.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from app.lifecycles import INCIDENT_TRANSITIONS, assert_valid_transition
from app.models import IncidentRecord
from app.packet_core import _add_audit_event
from app.time import as_utc, now_utc

# Generous enough that no normal demo session or test hits it through real
# filing, but low enough that runaway triage/ingestion can't accumulate an
# unbounded open backlog. Mirrors the MAX_AUTO_GENERATED_COMPLIANCE_ITEMS cap.
MAX_OPEN_APP_INCIDENTS = 25

_OPEN_STATUSES = {"open", "under_review"}


def _is_app_generated(row: IncidentRecord) -> bool:
    """App-generated rows are archivable; curated `seed-…` rows are never."""
    return not (row.id or "").startswith("seed-")


def _parse_dt(value) -> Optional[datetime]:
    """Parse an occurred_at that may be a str (the model's type) or datetime.
    Mirrors scripts/cleanup_stale_incidents._parse_dt."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return as_utc(value)
    s = str(value).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return as_utc(datetime.fromisoformat(s))
    except ValueError:
        return None


def _age_days(occurred_at, now: datetime) -> Optional[float]:
    when = _parse_dt(occurred_at)
    if when is None:
        return None
    return max(0.0, (now - when).total_seconds() / 86400.0)


def _archive(
    session: Session, row: IncidentRecord, *, actor_id: str, reason: str,
    extra_metadata: Optional[dict] = None,
) -> None:
    """Transition one incident to 'closed_archived' with audit (validated)."""
    assert_valid_transition(
        INCIDENT_TRANSITIONS, row.status, "closed_archived", entity_name="incident",
    )
    from_status = row.status
    row.status = "closed_archived"
    session.add(row)
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="system",
        entity_type="incident", entity_id=row.id,
        event_type="incident.closed_archived",
        event_metadata={
            "from": from_status, "reason": reason, "venue_id": row.venue_id,
            **(extra_metadata or {}),
        },
    )


def enforce_open_incident_cap(
    session: Session, venue_id: str, *,
    cap: int = MAX_OPEN_APP_INCIDENTS,
    now: Optional[datetime] = None,
    actor_id: str = "incident_cap",
    protect_ids: Optional[set[str]] = None,
) -> list[IncidentRecord]:
    """Archive the OLDEST app-generated open incidents beyond `cap` for a venue.

    `protect_ids` are never archived (e.g. the incident just filed in this
    request — bounding the backlog must not clobber the operator's new entry,
    whose occurred_at may legitimately predate existing rows). Returns the
    archived rows (empty when under the cap). Caller owns commit.
    """
    now = now or now_utc()
    protect = protect_ids or set()
    rows = session.exec(
        select(IncidentRecord)
        .where(IncidentRecord.venue_id == venue_id)
        .where(IncidentRecord.status.in_(_OPEN_STATUSES))  # type: ignore[attr-defined]
    ).all()
    candidates = [r for r in rows if _is_app_generated(r)]
    if len(candidates) <= cap:
        return []
    num_to_archive = len(candidates) - cap
    # Oldest first (largest age) — undated rows sort oldest so they're pruned.
    archivable = [r for r in candidates if r.id not in protect]
    archivable.sort(key=lambda r: (_age_days(r.occurred_at, now) or float("inf")), reverse=True)
    to_archive = archivable[:num_to_archive]
    for r in to_archive:
        _archive(session, r, actor_id=actor_id, reason="open_incident_cap",
                 extra_metadata={"cap": cap})
    return to_archive


def find_stale_incidents(
    session: Session, *,
    venue_id: Optional[str] = None,
    older_than_days: int = 60,
    now: Optional[datetime] = None,
) -> list[tuple[IncidentRecord, float]]:
    """App-generated open incidents older than `older_than_days` by occurred_at.
    Read-only — used by the cleanup script's dry-run. Returns (row, age_days)."""
    now = now or now_utc()
    stmt = select(IncidentRecord).where(
        IncidentRecord.status.in_(_OPEN_STATUSES)  # type: ignore[attr-defined]
    )
    if venue_id:
        stmt = stmt.where(IncidentRecord.venue_id == venue_id)
    out: list[tuple[IncidentRecord, float]] = []
    for r in session.exec(stmt).all():
        if not _is_app_generated(r):
            continue
        age = _age_days(r.occurred_at, now)
        if age is None or age <= older_than_days:
            continue
        out.append((r, age))
    return out


def archive_stale_incidents(
    session: Session, *,
    venue_id: Optional[str] = None,
    older_than_days: int = 60,
    now: Optional[datetime] = None,
    actor_id: str = "cleanup_stale_incidents",
) -> list[IncidentRecord]:
    """Archive every stale app-generated open incident (age-based). Returns the
    archived rows. Caller owns commit."""
    now = now or now_utc()
    targets = find_stale_incidents(
        session, venue_id=venue_id, older_than_days=older_than_days, now=now,
    )
    for row, age in targets:
        _archive(session, row, actor_id=actor_id, reason="stale_auto_archive",
                 extra_metadata={"age_days": round(age, 1), "threshold_days": older_than_days})
    return [row for row, _ in targets]
