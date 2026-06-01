"""Open-questions answer/resolve loop.

AI underwriting memos carry ``open_questions: List[str]`` — clarifications the
agent wants before underwriting. Historically these were read-only on every
surface with no reply channel. This module closes the loop:

    operator answers a question (persisted, attributed)
        → broker sees the answer on the underwriting view
        → broker marks it resolved

One row per ``(packet_id, question_index)``: answering or resolving the same
question upserts rather than duplicating. Evidence-layer convention (mirrors
``claim_proposals``): the service commits.
"""
from __future__ import annotations

import json
from uuid import uuid4

from sqlmodel import Session, select

from app.models import OpenQuestionResponse, UnderwritingPacket
from app.packet_core import _add_audit_event
from app.time import now_utc


class OpenQuestionError(ValueError):
    """Unknown packet, or a question index outside the memo's open_questions."""


def _memo_questions(packet: UnderwritingPacket) -> list:
    """The memo's open_questions, coercing the JSON column at the read boundary.
    Column(JSON) round-trips as a STRING on Postgres but a dict on SQLite."""
    memo = packet.memo
    if isinstance(memo, str):
        try:
            memo = json.loads(memo)
        except (ValueError, TypeError):
            memo = {}
    if not isinstance(memo, dict):
        memo = {}
    qs = memo.get("open_questions") or []
    return list(qs) if isinstance(qs, (list, tuple)) else []


def _require_packet(session: Session, packet_id: str) -> UnderwritingPacket:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise OpenQuestionError(f"Packet {packet_id!r} not found")
    return packet


def _validate_index(packet: UnderwritingPacket, question_index: int) -> list:
    questions = _memo_questions(packet)
    if question_index < 0 or question_index >= len(questions):
        raise OpenQuestionError(
            f"Question index {question_index} out of range for packet {packet.id!r}"
        )
    return questions


def _get_row(session: Session, packet_id: str, question_index: int) -> OpenQuestionResponse | None:
    return session.exec(
        select(OpenQuestionResponse)
        .where(OpenQuestionResponse.packet_id == packet_id)
        .where(OpenQuestionResponse.question_index == question_index)
    ).first()


def _upsert_row(
    session: Session, packet_id: str, question_index: int, question_text: str, fallback_text: str
) -> OpenQuestionResponse:
    row = _get_row(session, packet_id, question_index)
    if row is None:
        row = OpenQuestionResponse(
            id=f"oqr-{uuid4().hex[:12]}",
            packet_id=packet_id,
            question_index=question_index,
            question_text=question_text or fallback_text,
        )
        session.add(row)
    elif question_text:
        row.question_text = question_text
    return row


def submit_answer(
    *,
    session: Session,
    packet_id: str,
    question_index: int,
    question_text: str,
    answer: str,
    operator_id: str,
) -> OpenQuestionResponse:
    """Operator answers an open question. Upserts the (packet, index) row."""
    packet = _require_packet(session, packet_id)
    questions = _validate_index(packet, question_index)
    row = _upsert_row(session, packet_id, question_index, question_text, questions[question_index])
    row.answer = answer
    row.answered_by = operator_id
    row.answered_at = now_utc()
    _add_audit_event(
        session=session,
        actor_id=operator_id,
        actor_type="venue_operator",
        entity_type="underwriting_packet",
        entity_id=packet_id,
        event_type="open_question.answered",
        event_metadata={"question_index": question_index},
    )
    session.commit()
    session.refresh(row)
    return row


def resolve_question(
    *,
    session: Session,
    packet_id: str,
    question_index: int,
    reviewer_id: str,
    question_text: str = "",
    resolved: bool = True,
) -> OpenQuestionResponse:
    """Broker marks an open question resolved (or reopens it). Upserts the row so
    a question can be resolved even if the operator never typed an answer."""
    packet = _require_packet(session, packet_id)
    questions = _validate_index(packet, question_index)
    row = _upsert_row(session, packet_id, question_index, question_text, questions[question_index])
    row.resolved = resolved
    row.resolved_by = reviewer_id if resolved else None
    row.resolved_at = now_utc() if resolved else None
    _add_audit_event(
        session=session,
        actor_id=reviewer_id,
        actor_type="broker",
        entity_type="underwriting_packet",
        entity_id=packet_id,
        event_type="open_question.resolved" if resolved else "open_question.reopened",
        event_metadata={"question_index": question_index},
    )
    session.commit()
    session.refresh(row)
    return row


def list_responses(*, session: Session, packet_id: str) -> list[OpenQuestionResponse]:
    rows = session.exec(
        select(OpenQuestionResponse).where(OpenQuestionResponse.packet_id == packet_id)
    ).all()
    return sorted(rows, key=lambda r: r.question_index)


def response_to_dict(row: OpenQuestionResponse) -> dict:
    """Wire shape for the answer/resolve routes and the packet payload."""
    return {
        "id": row.id,
        "packet_id": row.packet_id,
        "question_index": row.question_index,
        "question_text": row.question_text,
        "answer": row.answer,
        "answered_by": row.answered_by,
        "answered_at": row.answered_at.isoformat() if row.answered_at else None,
        "resolved": row.resolved,
        "resolved_by": row.resolved_by,
        "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
    }
