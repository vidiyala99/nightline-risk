from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, CitationRecord, ReviewDecision, SourceRecord, UnderwritingPacket
from app.packet_core import (
    PacketCitationValidationError,
    create_packet_snapshot,
    record_review_decision,
)
from app.schemas import Citation, IncidentCreate


DEMO_INCIDENT = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z",
    location="rear bar",
    summary="Two patrons began fighting near the rear bar during a sold-out DJ event.",
    reported_by="shift-lead",
    injury_observed=False,
    police_called=False,
    ems_called=False,
)


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_create_packet_snapshot_persists_sources_citations_packet_and_audit_event():
    with make_session() as session:
        packet = create_packet_snapshot(
            session=session,
            venue_id="elsewhere-brooklyn",
            incident_id="inc-1",
            incident=DEMO_INCIDENT,
            risk_signal={
                "type": "altercation_event",
                "severity": "medium",
                "confidence": 0.78,
                "explanation": "Documented altercation requires review.",
                "review_status": "needs_review",
            },
            action_plan=[],
            claims_timeline=[],
            underwriting_memo={
                "summary": "Requires review.",
                "open_questions": [],
                "review_status": "draft",
            },
            citations=[
                Citation(
                    source_id="policy-2026-liquor-liability",
                    source_type="policy",
                    excerpt="Liquor liability policy requires documented security response.",
                )
            ],
            rubric_version="demo-rubric-v1",
        )

        persisted_packet = session.get(UnderwritingPacket, packet.id)
        assert persisted_packet is not None
        assert persisted_packet.status == "needs_review"
        assert persisted_packet.snapshot_hash

        sources = session.exec(select(SourceRecord)).all()
        citation_records = session.exec(select(CitationRecord)).all()
        audit_events = session.exec(select(AuditEvent)).all()

        assert [source.id for source in sources] == ["policy-2026-liquor-liability"]
        assert len(citation_records) == 1
        assert citation_records[0].validation_status == "valid"
        assert citation_records[0].packet_id == packet.id
        assert [event.event_type for event in audit_events] == ["packet.generated"]


def test_create_packet_snapshot_rejects_citation_from_different_venue():
    with make_session() as session:
        session.add(
            SourceRecord(
                id="policy-2026-liquor-liability",
                venue_id="other-venue",
                incident_id="inc-1",
                source_type="policy",
                excerpt="Existing source belongs to a different venue.",
            )
        )
        session.commit()

        try:
            create_packet_snapshot(
                session=session,
                venue_id="elsewhere-brooklyn",
                incident_id="inc-1",
                incident=DEMO_INCIDENT,
                risk_signal={"type": "altercation_event", "review_status": "needs_review"},
                action_plan=[],
                claims_timeline=[],
                underwriting_memo={"summary": "Requires review.", "review_status": "draft"},
                citations=[
                    Citation(
                        source_id="policy-2026-liquor-liability",
                        source_type="policy",
                        excerpt="Liquor liability policy requires documented security response.",
                    )
                ],
                rubric_version="demo-rubric-v1",
            )
        except PacketCitationValidationError as error:
            assert "does not belong to venue elsewhere-brooklyn" in str(error)
        else:
            raise AssertionError("Expected cross-venue citation validation to fail")


def test_record_review_decision_requires_override_reason_for_reject_and_emits_audit_event():
    with make_session() as session:
        packet = create_packet_snapshot(
            session=session,
            venue_id="elsewhere-brooklyn",
            incident_id="inc-1",
            incident=DEMO_INCIDENT,
            risk_signal={"type": "altercation_event", "review_status": "needs_review"},
            action_plan=[],
            claims_timeline=[],
            underwriting_memo={"summary": "Requires review.", "review_status": "draft"},
            citations=[
                Citation(source_id="source-1", source_type="policy", excerpt="Policy excerpt")
            ],
            rubric_version="demo-rubric-v1",
        )

        try:
            record_review_decision(
                session=session,
                packet_id=packet.id,
                reviewer_id="uw-1",
                decision="rejected",
                override_reason=None,
                notes=None,
            )
        except ValueError as error:
            assert "override_reason is required" in str(error)
        else:
            raise AssertionError("Expected rejected packet without override reason to fail")

        decision = record_review_decision(
            session=session,
            packet_id=packet.id,
            reviewer_id="uw-1",
            decision="rejected",
            override_reason="Camera evidence missing.",
            notes="Need venue follow-up.",
        )

        persisted_packet = session.get(UnderwritingPacket, packet.id)
        audit_events = session.exec(select(AuditEvent).where(AuditEvent.entity_id == packet.id)).all()

        assert isinstance(decision, ReviewDecision)
        assert persisted_packet is not None
        assert persisted_packet.status == "rejected"
        assert [event.event_type for event in audit_events] == [
            "packet.generated",
            "packet.review_decision_recorded",
        ]
