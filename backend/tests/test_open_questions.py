"""Tests for the open-questions answer/resolve loop.

AI-generated underwriting memos carry `open_questions: List[str]`. This layer
lets an operator ANSWER a question (persisted, attributed) and a broker mark it
RESOLVED — closing the loop the read-only memo never had. Logic-level tests
against `app.open_questions`; route/auth tests live in test_open_questions_api.py.

One response row per (packet_id, question_index): answering or resolving the
same question upserts rather than duplicating.
"""

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import OpenQuestionResponse, UnderwritingPacket
from app.open_questions import (
    OpenQuestionError,
    list_responses,
    resolve_question,
    submit_answer,
)
from app.packet_core import create_packet_snapshot
from app.schemas import Citation, IncidentCreate


DEMO_INCIDENT = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z",
    location="rear bar",
    summary="Patron required EMS after altercation; police on scene.",
    reported_by="shift-lead",
    injury_observed=True,
    police_called=True,
    ems_called=True,
)

QUESTIONS = [
    "Was the rear camera operational at the time of the incident?",
    "Did the injured patron sign an incident acknowledgment?",
]


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed_packet(session: Session, venue_id: str = "elsewhere-brooklyn") -> UnderwritingPacket:
    return create_packet_snapshot(
        session=session,
        venue_id=venue_id,
        incident_id="inc-oq-1",
        incident=DEMO_INCIDENT,
        risk_signal={"type": "altercation_event", "severity": "high", "confidence": 0.85, "review_status": "needs_review"},
        action_plan=[],
        claims_timeline=[],
        underwriting_memo={"summary": "Severe altercation.", "review_status": "draft", "open_questions": QUESTIONS},
        citations=[
            Citation(source_id="policy-x", source_type="policy", excerpt="Altercation triggers carrier notification."),
        ],
        rubric_version="demo-rubric-v1",
    )


# ---------- submit_answer ----------


def test_submit_answer_persists_with_operator_and_timestamp():
    with make_session() as session:
        packet = _seed_packet(session)
        row = submit_answer(
            session=session, packet_id=packet.id, question_index=0,
            question_text=QUESTIONS[0], answer="Yes — rear cam was up; footage attached.",
            operator_id="op-1",
        )
        assert row.packet_id == packet.id
        assert row.question_index == 0
        assert row.answer.startswith("Yes")
        assert row.answered_by == "op-1"
        assert row.answered_at is not None
        assert row.resolved is False


def test_resubmitting_answer_upserts_same_row():
    with make_session() as session:
        packet = _seed_packet(session)
        submit_answer(session=session, packet_id=packet.id, question_index=0,
                      question_text=QUESTIONS[0], answer="first", operator_id="op-1")
        submit_answer(session=session, packet_id=packet.id, question_index=0,
                      question_text=QUESTIONS[0], answer="second", operator_id="op-1")
        rows = session.exec(
            select(OpenQuestionResponse).where(OpenQuestionResponse.packet_id == packet.id)
        ).all()
        assert len(rows) == 1
        assert rows[0].answer == "second"


def test_submit_answer_rejects_out_of_range_index():
    with make_session() as session:
        packet = _seed_packet(session)
        try:
            submit_answer(session=session, packet_id=packet.id, question_index=9,
                          question_text="ghost", answer="x", operator_id="op-1")
            assert False, "expected OpenQuestionError"
        except OpenQuestionError:
            pass


def test_submit_answer_rejects_unknown_packet():
    with make_session() as session:
        try:
            submit_answer(session=session, packet_id="nope", question_index=0,
                          question_text="x", answer="y", operator_id="op-1")
            assert False, "expected OpenQuestionError"
        except OpenQuestionError:
            pass


# ---------- resolve_question ----------


def test_resolve_marks_resolved_with_reviewer():
    with make_session() as session:
        packet = _seed_packet(session)
        submit_answer(session=session, packet_id=packet.id, question_index=1,
                      question_text=QUESTIONS[1], answer="Yes, signed.", operator_id="op-1")
        row = resolve_question(session=session, packet_id=packet.id, question_index=1, reviewer_id="brk-1")
        assert row.resolved is True
        assert row.resolved_by == "brk-1"
        assert row.resolved_at is not None
        # answer is preserved through resolution
        assert row.answer == "Yes, signed."


def test_resolve_before_answer_creates_resolved_row():
    """Broker can resolve a question even if the operator never typed an answer
    (e.g. resolved out-of-band) — the row is created and flagged resolved."""
    with make_session() as session:
        packet = _seed_packet(session)
        row = resolve_question(session=session, packet_id=packet.id, question_index=0,
                               question_text=QUESTIONS[0], reviewer_id="brk-1")
        assert row.resolved is True
        assert row.answer == ""


# ---------- list_responses ----------


def test_list_responses_returns_all_for_packet():
    with make_session() as session:
        packet = _seed_packet(session)
        submit_answer(session=session, packet_id=packet.id, question_index=0,
                      question_text=QUESTIONS[0], answer="a0", operator_id="op-1")
        submit_answer(session=session, packet_id=packet.id, question_index=1,
                      question_text=QUESTIONS[1], answer="a1", operator_id="op-1")
        rows = list_responses(session=session, packet_id=packet.id)
        assert {r.question_index for r in rows} == {0, 1}
