"""Defense-package assembly + PDF rendering."""
import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.defense_package import (
    DefensePackageError,
    build_defense_sections,
    render_defense_pdf,
)
from app.models import EvidenceFile, IncidentRecord
from app.packet_core import create_packet_snapshot
from app.schemas import Citation, IncidentCreate

INC = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z", location="rear bar", summary="brawl near rear bar",
    reported_by="shift-lead", injury_observed=True, police_called=True, ems_called=False,
    incident_category="assault_battery", weapon_involved=False,
    security_response=[{"action": "ejected", "at": "23:14"}],
)
RISK = {"type": "altercation_event", "severity": "medium", "confidence": 0.8, "review_status": "needs_review"}


def _session() -> Session:
    e = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(e)
    return Session(e)


def _make_packet(session, *, with_evidence=False, with_incident=True):
    if with_incident:
        session.add(IncidentRecord(
            id="inc-dp", venue_id="elsewhere-brooklyn", occurred_at=INC.occurred_at,
            location=INC.location, summary=INC.summary, reported_by=INC.reported_by,
            injury_observed=True, police_called=True, ems_called=False,
            incident_category="assault_battery", weapon_involved=False,
            security_response=[{"action": "ejected", "at": "23:14"}],
        ))
        session.commit()
    packet = create_packet_snapshot(
        session=session, venue_id="elsewhere-brooklyn", incident_id="inc-dp", incident=INC,
        risk_signal=RISK, action_plan=[],
        claims_timeline=[{"at": "2026-05-02T23:13:00Z", "label": "Altercation reported", "source": "operator"}],
        underwriting_memo={"summary": "m", "open_questions": [], "review_status": "draft"},
        citations=[Citation(source_id="policy-x", source_type="policy", excerpt="Security response required.")],
        rubric_version="demo-rubric-v1",
    )
    if with_evidence:
        session.add(EvidenceFile(
            id="ev-dp", incident_id="inc-dp", filename="clip.mp4", content_type="video/mp4",
            file_path="/tmp/x", file_size=10, content_hash="abc123", captured_at="2026-05-02T23:12:00Z",
        ))
        session.commit()
    return packet


def test_build_sections_and_render():
    with _session() as s:
        packet = _make_packet(s, with_evidence=True)
        sections = build_defense_sections(s, packet.id)
        assert sections["cover"]["snapshot_hash"] == packet.snapshot_hash
        assert sections["incident"]["incident_category"] == "assault_battery"
        assert sections["incident"]["security_response"][0]["at"] == "23:14"
        assert any(e["content_hash"] == "abc123" for e in sections["evidence"])
        assert sections["citations"][0]["excerpt"] == "Security response required."
        assert any(a["event_type"] == "packet.generated" for a in sections["audit"])

        pdf = render_defense_pdf(sections)
        assert pdf[:4] == b"%PDF"
        assert len(pdf) > 800


def test_render_handles_no_evidence_no_claim_no_incident():
    with _session() as s:
        packet = _make_packet(s, with_evidence=False, with_incident=False)
        sections = build_defense_sections(s, packet.id)
        assert sections["evidence"] == []
        assert sections["cover"]["claim_ref"] is None
        assert render_defense_pdf(sections)[:4] == b"%PDF"


def test_unknown_packet_raises():
    with _session() as s:
        with pytest.raises(DefensePackageError):
            build_defense_sections(s, "pkt-nope")
