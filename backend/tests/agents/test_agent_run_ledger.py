"""PR1 — the AgentRun ledger primitive.

A single durable record per agent execution: who acted, on what entity, with
which provider/model/contract, what it cost, and whether it succeeded, fell
back, or errored. This is the keystone the agent-oversight surfaces hang off.

These tests pin the contract:
  - the lifecycle matrix rejects illegal jumps (TDD discipline #5),
  - `record_agent_run` writes ONE row, finalizes its terminal state, stamps a
    snapshot hash + input fingerprint, and emits an `actor_type="agent"` audit
    event (the value that makes AI actions queryable vs generic "system" ones),
  - the seam FLUSHES but never COMMITS (the caller owns the transaction).

Each test uses an isolated in-memory engine, so a stray row from a sibling
test can never produce a false green (the shared-test-DB gotcha).
"""
from decimal import Decimal

import pytest
from sqlmodel import SQLModel, Session, create_engine, select

from app.lifecycles import (
    AGENT_RUN_TRANSITIONS,
    InvalidTransitionError,
    assert_valid_transition,
)
from app.models import AgentRun, AuditEvent
from app.agents.ledger import record_agent_run


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


# ─── Lifecycle matrix ─────────────────────────────────────────────────────

def test_agent_run_transition_allows_started_to_succeeded():
    # Should not raise.
    assert_valid_transition(
        AGENT_RUN_TRANSITIONS, "started", "succeeded", entity_name="agent_run"
    )


def test_agent_run_transition_rejects_started_to_approved():
    # A human can only approve a run that ESCALATED first — not a fresh run.
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(
            AGENT_RUN_TRANSITIONS, "started", "approved", entity_name="agent_run"
        )


# ─── record_agent_run: success path ───────────────────────────────────────

def test_record_agent_run_writes_succeeded_row_with_provenance():
    session = _session()
    with record_agent_run(
        session,
        agent_name="risk_evaluator_agent",
        agent_kind="pipeline",
        entity_type="incident",
        entity_id="inc-1",
        provider="groq",
        model="llama-3.3-70b-versatile",
        contract_version="risk-eval-v3",
        inputs={"summary": "brawl", "tags": ["injury", "police"]},
    ) as handle:
        handle.meter(prompt_tokens=1200, completion_tokens=300, cost_usd=Decimal("0.0007"))
        handle.confidence(Decimal("0.91"))
        run_id = handle.run.id

    run = session.get(AgentRun, run_id)
    assert run is not None
    assert run.status == "succeeded"
    assert run.outcome == "success"
    assert run.agent_kind == "pipeline"
    assert run.prompt_tokens == 1200
    assert run.completion_tokens == 300
    assert run.cost_usd == Decimal("0.0007")
    assert run.confidence == Decimal("0.91")
    assert run.latency_ms >= 0
    assert run.completed_at is not None
    # input fingerprint is the order-insensitive house hash (16 hex chars)
    assert len(run.input_hash) == 16
    # snapshot hash is the full SHA-256 (64 hex chars), per house discipline
    assert len(run.snapshot_hash) == 64
    assert run.auto_completed is True


def test_record_agent_run_emits_agent_actor_audit_event():
    session = _session()
    with record_agent_run(
        session,
        agent_name="risk_evaluator_agent",
        agent_kind="pipeline",
        entity_type="incident",
        entity_id="inc-1",
        provider="groq",
        model="llama-3.3-70b-versatile",
        contract_version="risk-eval-v3",
        inputs={"summary": "brawl"},
    ) as handle:
        run_id = handle.run.id

    events = session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == run_id)
    ).all()
    assert len(events) == 1
    ev = events[0]
    assert ev.actor_type == "agent"          # the new, queryable AI-action value
    assert ev.entity_type == "agent_run"
    assert ev.event_type == "agent_run.succeeded"
    assert ev.event_metadata["from"] == "started"
    assert ev.event_metadata["to"] == "succeeded"


# ─── record_agent_run: fallback path ──────────────────────────────────────

def test_record_agent_run_fallback_marks_fell_back():
    session = _session()
    with record_agent_run(
        session,
        agent_name="underwriter_memo_agent",
        agent_kind="pipeline",
        entity_type="incident",
        entity_id="inc-2",
        provider="groq",
        model="llama-3.3-70b-versatile",
        contract_version="memo-v2",
        inputs={"summary": "slip and fall"},
    ) as handle:
        handle.fell_back("groq_timeout")
        run_id = handle.run.id

    run = session.get(AgentRun, run_id)
    assert run.status == "fell_back"
    assert run.outcome == "fallback"
    assert run.fallback_reason == "groq_timeout"

    ev = session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == run_id)
    ).one()
    assert ev.event_type == "agent_run.fell_back"


# ─── record_agent_run: error path ─────────────────────────────────────────

def test_record_agent_run_error_marks_errored_and_reraises():
    session = _session()
    with pytest.raises(ValueError, match="boom"):
        with record_agent_run(
            session,
            agent_name="risk_evaluator_agent",
            agent_kind="pipeline",
            entity_type="incident",
            entity_id="inc-3",
            provider="groq",
            model="llama-3.3-70b-versatile",
            contract_version="risk-eval-v3",
            inputs={"summary": "x"},
        ) as handle:
            run_id = handle.run.id
            raise ValueError("boom")

    run = session.get(AgentRun, run_id)
    assert run.status == "errored"
    assert run.outcome == "error"


# ─── record_agent_run: never commits ──────────────────────────────────────

def test_record_agent_run_flushes_but_does_not_commit():
    session = _session()
    with record_agent_run(
        session,
        agent_name="risk_evaluator_agent",
        agent_kind="pipeline",
        entity_type="incident",
        entity_id="inc-4",
        provider="deterministic",
        model="rules-v1",
        contract_version="risk-eval-v3",
        inputs={"summary": "y"},
    ) as handle:
        run_id = handle.run.id

    # Visible within the session (it was flushed)...
    assert session.get(AgentRun, run_id) is not None
    # ...but rolling back discards it, proving the seam never committed.
    session.rollback()
    assert session.get(AgentRun, run_id) is None
