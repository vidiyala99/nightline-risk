"""The Risk Intelligence engine: resolve persona scope, run the persona's
allowed judgment modules (isolating failures), rank by severity, persist
findings as predictions, and return them ranked.

Deterministic — no LLM, no retrieval. This is the trustworthy foundation the
copilot and the calibration loop are surfaces of."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from app.auth import accessible_venue_ids
from app.intelligence.finding import Finding, FindingScope, PERSONA_KINDS
from app.intelligence.findings import REGISTRY
from app.models import RiskFindingRecord
from app.time import now_utc

logger = logging.getLogger(__name__)


def compute_exposure(
    user: dict, session: Session, *, now: Optional[datetime] = None
) -> list[Finding]:
    """Compute, persist, and return the ranked findings for a persona."""
    now = now or now_utc()
    persona = user.get("role", "")
    kinds = PERSONA_KINDS.get(persona, [])
    venue_ids = accessible_venue_ids(user, session)  # None for broker/admin
    scope = FindingScope(
        persona=persona, user=user, venue_ids=venue_ids, session=session, now=now,
    )

    findings: list[Finding] = []
    for kind in kinds:
        fn = REGISTRY.get(kind)
        if fn is None:
            continue
        try:
            findings.extend(fn(scope))
        except Exception:  # one bad module must not blank the whole panel
            logger.exception("intelligence finding %s failed", kind)

    findings.sort(key=lambda f: (f.severity_rank, f.id), reverse=True)
    _persist(findings, persona, kinds, session, now)
    return findings


def _persist(
    findings: list[Finding], persona: str, kinds: list[str],
    session: Session, now: datetime,
) -> None:
    """Upsert current findings as open records; mark previously-open records of
    this persona's kinds that no longer fire as resolved (the outcome-capture
    seam — predictions persist for the calibration loop)."""
    current_ids = {f.id for f in findings}

    stale = session.exec(
        select(RiskFindingRecord).where(
            RiskFindingRecord.persona == persona,
            RiskFindingRecord.kind.in_(kinds),
            RiskFindingRecord.status == "open",
        )
    ).all()
    for rec in stale:
        if rec.id not in current_ids:
            rec.status = "resolved"
            rec.resolved_at = now
            session.add(rec)

    for f in findings:
        rec = session.get(RiskFindingRecord, f.id)
        why = [c.model_dump() for c in f.why]
        if rec is None:
            rec = RiskFindingRecord(
                id=f.id, persona=f.persona, kind=f.kind,
                subject_type=f.subject.entity_type, subject_id=f.subject.entity_id,
                subject_label=f.subject.label, subject_href=f.subject.href,
                severity=f.severity, severity_rank=f.severity_rank,
                why=why, recommended_action=f.recommended_action.model_dump(),
                prediction=f.prediction.model_dump(), status="open",
                venue_id=f.venue_id, computed_at=now,
            )
        else:
            rec.severity = f.severity
            rec.severity_rank = f.severity_rank
            rec.subject_label = f.subject.label
            rec.subject_href = f.subject.href
            rec.why = why
            rec.recommended_action = f.recommended_action.model_dump()
            rec.prediction = f.prediction.model_dump()
            rec.status = "open"
            rec.resolved_at = None
            rec.computed_at = now
        session.add(rec)

    session.commit()


# re-export so tests can monkeypatch REGISTRY on the engine module
REGISTRY = REGISTRY
