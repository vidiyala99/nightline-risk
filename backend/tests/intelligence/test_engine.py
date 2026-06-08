from datetime import datetime, timezone

from app.intelligence.engine import compute_exposure
from app.models import IncidentRecord, RiskFindingRecord

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _open_incident(vid="v1", iid="inc-1"):
    return IncidentRecord(id=iid, venue_id=vid, occurred_at="2026-06-01",
                          location="x", summary="Brawl", reported_by="s",
                          injury_observed=True, police_called=False, ems_called=False,
                          status="open")


def test_operator_gets_only_operator_findings_in_their_scope(session):
    session.add(_open_incident("v1", "inc-1"))
    session.add(_open_incident("OTHER", "inc-2"))
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    findings = compute_exposure(user, session, now=NOW)
    assert {f.subject.entity_id for f in findings} == {"inc-1"}
    assert all(f.persona == "venue_operator" for f in findings)


def test_findings_sorted_by_severity_desc(session):
    session.add(_open_incident("v1", "inc-high"))
    session.add(IncidentRecord(id="inc-med", venue_id="v1", occurred_at="2026-06-01",
                               location="x", summary="minor", reported_by="s",
                               injury_observed=False, police_called=False,
                               ems_called=False, status="open"))
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    findings = compute_exposure(user, session, now=NOW)
    assert [f.severity for f in findings][0] == "high"
    assert findings[0].severity_rank >= findings[-1].severity_rank


def test_persists_findings_as_records(session):
    session.add(_open_incident("v1", "inc-1"))
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    compute_exposure(user, session, now=NOW)
    from sqlmodel import select
    rows = session.exec(select(RiskFindingRecord)).all()
    assert any(r.id == "evidence_gap:incident:inc-1" and r.status == "open" for r in rows)


def test_resolved_when_condition_clears(session):
    inc = _open_incident("v1", "inc-1")
    session.add(inc)
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    compute_exposure(user, session, now=NOW)
    inc.status = "closed"
    session.add(inc)
    session.commit()
    compute_exposure(user, session, now=NOW)
    rec = session.get(RiskFindingRecord, "evidence_gap:incident:inc-1")
    assert rec.status == "resolved"
    assert rec.resolved_at is not None


def test_failing_module_does_not_abort_others(session, monkeypatch):
    session.add(_open_incident("v1", "inc-1"))
    session.commit()

    def boom(scope):
        raise RuntimeError("module exploded")

    import app.intelligence.engine as eng
    monkeypatch.setitem(eng.REGISTRY, "compliance_overdue", boom)
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    findings = compute_exposure(user, session, now=NOW)  # must not raise
    assert any(f.kind == "evidence_gap" for f in findings)
