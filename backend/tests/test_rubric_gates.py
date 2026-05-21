"""RubricVersion.rules must actually enforce gates on the packet.

Before this work, every RubricVersion was seeded as
  {"mode": "deterministic", "requires_citations": true}
but no code path read it. The packet was written with rubric_version_id
set on the FK, but the rule body was inert — implying a governance layer
that wasn't real.

After this work, _apply_rubric_gates() reads rubric.rules during packet
creation and surfaces failures into packet.validation.rubric_failures.
A failed gate downgrades the packet status to at least 'needs_review'
and emits a 'packet.rubric_gate_failed' audit event.

Supported rules:
  - requires_citations: bool          — fail if no citations
  - min_citations: int                 — fail if fewer than N citations
  - reject_invalid_citations: bool     — fail if any invalid citation
  - prohibited_fields: [str]           — fail if any banned key appears in
                                          the packet body (defense-in-depth)
"""

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, RubricVersion, SourceRecord, UnderwritingPacket
from app.packet_core import create_packet_snapshot
from app.schemas import Citation, IncidentCreate


DEMO_INCIDENT = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z",
    location="rear bar",
    summary="Two patrons began fighting near the rear bar.",
    reported_by="shift-lead",
    injury_observed=False,
    police_called=False,
    ems_called=False,
)

VALID_CITATION = Citation(
    source_id="policy-2026-liquor-liability",
    source_type="policy",
    excerpt="Liquor liability policy requires documented security response.",
)

DEFAULT_RISK = {
    "type": "altercation_event",
    "severity": "medium",
    "confidence": 0.78,
    "explanation": "Documented altercation.",
    "review_status": "needs_review",
}

DEFAULT_MEMO = {"summary": "Requires review.", "open_questions": [], "review_status": "draft"}


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed_rubric(session: Session, rubric_id: str, *, rules: dict, prohibited_fields: list | None = None) -> str:
    """Pre-create a RubricVersion so _ensure_rubric_version returns it
    instead of the default-seeded one."""
    rubric = RubricVersion(
        id=rubric_id,
        name="test rubric",
        version=rubric_id,
        rules=rules,
        prohibited_fields=prohibited_fields or [],
    )
    session.add(rubric)
    session.flush()
    return rubric_id


def _make_packet(session: Session, rubric_id: str = "demo-rubric-v1", citations: list[Citation] | None = None):
    return create_packet_snapshot(
        session=session,
        venue_id="elsewhere-brooklyn",
        incident_id="inc-1",
        incident=DEMO_INCIDENT,
        risk_signal=DEFAULT_RISK,
        action_plan=[],
        claims_timeline=[],
        underwriting_memo=DEFAULT_MEMO,
        citations=citations if citations is not None else [VALID_CITATION],
        rubric_version=rubric_id,
    )


# ─── Default rubric: requires_citations only ─────────────────────────────

def test_packet_with_citations_passes_default_rubric():
    """{'requires_citations': True} + a citation → no rubric failures."""
    with _session() as session:
        packet = _make_packet(session)
        failures = packet.validation.get("rubric_failures", [])
        assert failures == [], f"unexpected gate failures: {failures}"


def test_packet_with_no_citations_fails_requires_citations_gate():
    """{'requires_citations': True} + no citations → gate fires."""
    with _session() as session:
        packet = _make_packet(session, citations=[])
        failures = packet.validation.get("rubric_failures", [])
        assert any("requires_citations" in f.lower() or "citation" in f.lower() for f in failures), failures


# ─── min_citations rule ──────────────────────────────────────────────────

def test_min_citations_fails_when_count_below_threshold():
    with _session() as session:
        _seed_rubric(session, "strict-rubric", rules={"min_citations": 3})
        packet = _make_packet(session, rubric_id="strict-rubric", citations=[VALID_CITATION])
        failures = packet.validation.get("rubric_failures", [])
        joined = " ".join(failures).lower()
        assert "min_citations" in joined or "fewer than" in joined or "below" in joined, failures


def test_min_citations_passes_when_count_meets_threshold():
    with _session() as session:
        _seed_rubric(session, "easy-rubric", rules={"min_citations": 1})
        packet = _make_packet(session, rubric_id="easy-rubric", citations=[VALID_CITATION])
        assert packet.validation.get("rubric_failures", []) == []


# ─── reject_invalid_citations rule ───────────────────────────────────────

def test_reject_invalid_citations_fires_when_source_has_no_excerpt():
    """A pre-seeded SourceRecord with empty stored excerpt makes the
    citation validate as 'invalid' (without raising). With the gate on,
    that becomes a rubric failure."""
    with _session() as session:
        session.add(SourceRecord(
            id="policy-emptyexcerpt",
            venue_id="elsewhere-brooklyn",
            source_type="policy",
            excerpt="",  # empty -> validator returns "invalid"
        ))
        session.flush()
        _seed_rubric(session, "strict-citations", rules={"reject_invalid_citations": True})
        packet = _make_packet(
            session,
            rubric_id="strict-citations",
            citations=[Citation(
                source_id="policy-emptyexcerpt",
                source_type="policy",
                excerpt="claim text",
            )],
        )
        failures = packet.validation.get("rubric_failures", [])
        joined = " ".join(failures).lower()
        assert "invalid" in joined, failures


# ─── prohibited_fields rule ──────────────────────────────────────────────

def test_prohibited_fields_blocks_disallowed_keys():
    """If the rubric forbids a field name from appearing anywhere in the
    packet body, that's a hard fail."""
    with _session() as session:
        _seed_rubric(
            session,
            "no-pii",
            rules={},
            prohibited_fields=["ssn"],
        )
        # Inject an "ssn" field via the memo dict, which is part of the
        # packet body that gets hashed.
        memo_with_pii = {**DEFAULT_MEMO, "ssn": "123-45-6789"}
        packet = create_packet_snapshot(
            session=session,
            venue_id="elsewhere-brooklyn",
            incident_id="inc-1",
            incident=DEMO_INCIDENT,
            risk_signal=DEFAULT_RISK,
            action_plan=[],
            claims_timeline=[],
            underwriting_memo=memo_with_pii,
            citations=[VALID_CITATION],
            rubric_version="no-pii",
        )
        failures = packet.validation.get("rubric_failures", [])
        joined = " ".join(failures).lower()
        assert "ssn" in joined or "prohibited" in joined, failures


# ─── Status + audit event side effects ───────────────────────────────────

def test_failed_gate_downgrades_status_to_needs_review():
    """A packet that would otherwise have been 'approved' must drop to
    'needs_review' when a gate fires."""
    with _session() as session:
        # Build an otherwise-approved packet by giving both risk_signal and
        # memo an approved review_status, then trip the requires_citations
        # gate.
        approved_packet = create_packet_snapshot(
            session=session,
            venue_id="elsewhere-brooklyn",
            incident_id="inc-2",
            incident=DEMO_INCIDENT,
            risk_signal={**DEFAULT_RISK, "review_status": "approved"},
            action_plan=[],
            claims_timeline=[],
            underwriting_memo={**DEFAULT_MEMO, "review_status": "approved"},
            citations=[],
            rubric_version="demo-rubric-v1",
        )
        assert approved_packet.status == "needs_review", approved_packet.status


def test_failed_gate_emits_audit_event():
    with _session() as session:
        packet = _make_packet(session, citations=[])
        events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == packet.id)
        ).all()
        types = {e.event_type for e in events}
        assert "packet.rubric_gate_failed" in types, types


def test_clean_packet_emits_no_rubric_gate_failure_event():
    with _session() as session:
        packet = _make_packet(session)
        events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == packet.id)
        ).all()
        types = {e.event_type for e in events}
        assert "packet.rubric_gate_failed" not in types


# ─── Persistence sanity ──────────────────────────────────────────────────

def test_rubric_failures_persist_on_packet_validation():
    """validation.rubric_failures must round-trip through SQLite so the
    underwriter UI can render it later."""
    with _session() as session:
        packet = _make_packet(session, citations=[])
        session.commit()
        reread = session.get(UnderwritingPacket, packet.id)
        assert reread is not None
        assert "rubric_failures" in reread.validation
        assert len(reread.validation["rubric_failures"]) >= 1
