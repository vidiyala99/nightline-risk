from datetime import datetime, timezone

from app.intelligence.finding import FindingScope
from app.intelligence.findings.evidence_gap import find
from app.models import IncidentRecord, EvidenceFile


def _scope(session):
    return FindingScope(
        persona="venue_operator", user={"sub": "u1", "role": "venue_operator"},
        venue_ids={"v1"}, session=session, now=datetime(2026, 6, 8, tzinfo=timezone.utc),
    )


def test_flags_open_incident_with_no_evidence(session):
    session.add(IncidentRecord(
        id="inc-1", venue_id="v1", occurred_at="2026-06-01", location="entrance",
        summary="Brawl at the door", reported_by="staff",
        injury_observed=True, police_called=True, ems_called=False, status="open",
    ))
    session.commit()
    findings = find(_scope(session))
    assert len(findings) == 1
    f = findings[0]
    assert f.kind == "evidence_gap"
    assert f.subject.entity_id == "inc-1"
    assert f.severity == "high"  # injury + police escalate
    assert f.why and f.why[0].source_id == "inc-1"
    assert f.id == "evidence_gap:incident:inc-1"


def test_does_not_flag_incident_with_evidence(session):
    session.add(IncidentRecord(
        id="inc-2", venue_id="v1", occurred_at="2026-06-01", location="bar",
        summary="Minor", reported_by="staff",
        injury_observed=False, police_called=False, ems_called=False, status="open",
    ))
    session.add(EvidenceFile(
        id="ev-1", incident_id="inc-2", filename="clip.mp4",
        content_type="video/mp4", file_path="/x",
    ))
    session.commit()
    assert find(_scope(session)) == []


def test_ignores_incidents_outside_scope(session):
    session.add(IncidentRecord(
        id="inc-3", venue_id="OTHER", occurred_at="2026-06-01", location="bar",
        summary="x", reported_by="s", injury_observed=False,
        police_called=False, ems_called=False, status="open",
    ))
    session.commit()
    assert find(_scope(session)) == []
