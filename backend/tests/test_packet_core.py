from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, CitationRecord, ReviewDecision, SourceRecord, UnderwritingPacket
from app.packet_core import (
    PacketCitationValidationError,
    create_packet_snapshot,
    record_review_decision,
    regenerate_packet_with_corroboration,
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


def test_regenerate_packet_with_corroboration_preserves_v1_and_links_v2():
    with make_session() as session:
        v1 = create_packet_snapshot(
            session=session,
            venue_id="elsewhere-brooklyn",
            incident_id="inc-1",
            incident=DEMO_INCIDENT,
            risk_signal={
                "type": "altercation_event",
                "severity": "medium",
                "confidence": 0.78,
                "review_status": "needs_review",
            },
            action_plan=[],
            claims_timeline=[],
            underwriting_memo={
                "summary": "Original memo body.",
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
        v1_hash = v1.snapshot_hash
        v1_memo = dict(v1.memo)
        v1_confidence = v1.risk_signals.get("confidence")

        v2 = regenerate_packet_with_corroboration(
            session=session,
            prior_packet=v1,
            incident=DEMO_INCIDENT,
            corroboration_summary="Visual evidence consistent.",
            corroboration_status="CONSISTENT",
            corroboration_flags=["Timestamp matches", "Injury visible"],
            confidence_adjustment=0.07,
            evidence_analysis_ids=["ea-1", "ea-2"],
        )

        # v1 must remain untouched
        persisted_v1 = session.get(UnderwritingPacket, v1.id)
        assert persisted_v1.snapshot_hash == v1_hash
        assert persisted_v1.memo == v1_memo
        assert persisted_v1.risk_signals.get("confidence") == v1_confidence

        # v2 carries the corroborated payload
        assert v2.id != v1.id
        assert v2.snapshot_hash and v2.snapshot_hash != v1_hash
        assert "Visual Evidence Analysis" in v2.memo["summary"]
        assert v2.risk_signals["confidence"] == round(v1_confidence + 0.07, 2)

        # Audit chain: v1 generated, v2 generated, v2 regenerated_with_vision
        v2_events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == v2.id)
        ).all()
        event_types = [e.event_type for e in v2_events]
        assert "packet.generated" in event_types
        assert "packet.regenerated_with_vision" in event_types
        link_event = next(e for e in v2_events if e.event_type == "packet.regenerated_with_vision")
        assert link_event.event_metadata["parent_packet_id"] == v1.id
        assert link_event.event_metadata["evidence_analysis_ids"] == ["ea-1", "ea-2"]


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
