"""The broker finding: an in-force policy that excludes the venue's actual top
loss exposure is direct E&O exposure — surfaced, severity-ranked, clause-cited.
Sibling of coverage_gap_eo (missing line) — this is the *exclusion* variant."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.models import IncidentRecord, Policy, SourceRecord
from app.knowledge_sources import INGESTED_ORIGIN
from app.intelligence.finding import FindingScope
from app.intelligence.findings import coverage_exclusion_review

NOW = datetime(2026, 6, 12, tzinfo=timezone.utc)


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _broker_scope(session: Session) -> FindingScope:
    return FindingScope(
        persona="broker", user={"sub": "b1", "role": "broker", "tenant_id": None},
        venue_ids=None, session=session, now=NOW,
    )


def _policy(pid: str, venue_id: str, status: str = "active") -> Policy:
    return Policy(
        id=pid, submission_id="s1", bound_quote_id="q1", venue_id=venue_id,
        carrier_id="c1", status=status,
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("0"), commission_amount=Decimal("0"),
        commission_rate=Decimal("0"), coverage_lines=["gl"],
    )


def _incident(iid: str, venue_id: str, summary: str) -> IncidentRecord:
    return IncidentRecord(
        id=iid, venue_id=venue_id, occurred_at="2026-05-01", location="x",
        summary=summary, reported_by="s", injury_observed=False,
        police_called=False, ems_called=False, status="open",
    )


def _exclusion(sid: str, venue_id: str, text: str, node_id: str) -> SourceRecord:
    return SourceRecord(
        id=sid, venue_id=venue_id, source_type="policy_exclusion",
        origin_system=INGESTED_ORIGIN, external_ref="master.md", excerpt=text,
        content_hash=sid, source_metadata={"node_id": node_id, "doc_id": "policy-abc",
                                            "clause_id": "9.1", "path": "Exclusions > 9.1"},
    )


def test_high_severity_when_top_exposure_is_excluded():
    s = _fresh_session()
    s.add(_policy("pol-1", "v1"))
    s.add(_incident("inc-1", "v1", "Brawl at the bar"))
    s.add(_incident("inc-2", "v1", "altercation by the door"))
    s.add(_exclusion("ingested-1", "v1",
                     "Claims arising from assault and battery are excluded.", "node-ab"))
    s.commit()

    findings = coverage_exclusion_review.find(_broker_scope(s))
    assert len(findings) == 1
    f = findings[0]
    assert f.kind == "coverage_exclusion_review"
    assert f.persona == "broker"
    assert f.id == "coverage_exclusion_review:policy:pol-1"
    assert f.severity == "high"  # the venue's #1 loss is excluded
    assert f.subject.entity_id == "pol-1"
    assert f.subject.href == "/policies/pol-1/gaps"
    assert f.venue_id == "v1"
    assert any(c.node_id == "node-ab" for c in f.why)
    assert f.prediction.falsifiable_by == "claim_outcome"


def test_medium_severity_when_only_a_secondary_exposure_is_excluded():
    """Liquor is the venue's #1 exposure (2) and A&B #2 (1). Only A&B is
    excluded — a real gap, but not the dominant loss → medium."""
    s = _fresh_session()
    s.add(_policy("pol-1", "v1"))
    s.add(_incident("inc-1", "v1", "intoxicated guest over-served"))
    s.add(_incident("inc-2", "v1", "drunk patron refused service"))
    s.add(_incident("inc-3", "v1", "a fight broke out"))
    s.add(_exclusion("ingested-1", "v1",
                     "Assault and battery claims are excluded.", "node-ab"))
    s.commit()

    findings = coverage_exclusion_review.find(_broker_scope(s))
    assert len(findings) == 1
    assert findings[0].severity == "medium"


def test_no_finding_when_no_exclusion_matches_exposure():
    s = _fresh_session()
    s.add(_policy("pol-1", "v1"))
    s.add(_incident("inc-1", "v1", "Brawl at the bar"))
    s.add(_exclusion("ingested-1", "v1",
                     "Discharge of any firearm is excluded.", "node-gun"))
    s.commit()

    assert coverage_exclusion_review.find(_broker_scope(s)) == []


def test_ignores_non_in_force_policy():
    s = _fresh_session()
    s.add(_policy("pol-1", "v1", status="expired"))
    s.add(_incident("inc-1", "v1", "Brawl at the bar"))
    s.add(_exclusion("ingested-1", "v1",
                     "Assault and battery claims are excluded.", "node-ab"))
    s.commit()

    assert coverage_exclusion_review.find(_broker_scope(s)) == []
