"""The agent-run recording seam.

`record_agent_run` is the ONE place every agent surface (pipeline step,
fraud/vision screen, copilot tool, orchestrator worker) opens and finalizes an
`AgentRun`. Call sites stay three lines:

    with record_agent_run(session, agent_name="risk_evaluator_agent",
                          agent_kind="pipeline", entity_type="incident",
                          entity_id=incident.id, provider="groq", model=model,
                          contract_version="risk-eval-v3", inputs=payload) as run:
        result = do_work()
        run.meter(prompt_tokens=p, completion_tokens=c, cost_usd=cost)
        run.confidence(classification.confidence)
        # on a degraded primary path:  run.fell_back("groq_timeout")

On normal exit the run finalizes to `succeeded` (outcome "success"); if
`fell_back(reason)` was called it finalizes to `fell_back` (outcome "fallback");
if the block raises it finalizes to `errored` (outcome "error") and re-raises.

The seam FLUSHES its parent before emitting the audit child (so the column-level
FK is satisfied on Postgres) but NEVER COMMITS — the caller (incident_flow,
router, or test fixture) owns commit/rollback, per the services-don't-commit rule.
"""
from __future__ import annotations

import hashlib
import json
import time
from contextlib import contextmanager
from decimal import Decimal
from typing import Any, Iterator, Optional
from uuid import uuid4

from sqlmodel import Session

from app.ai_provenance import _canonicalize, canonical_input_hash
from app.lifecycles import AGENT_RUN_TRANSITIONS, assert_valid_transition
from app.models import AgentRun
from app.packet_core import _add_audit_event
from app.time import now_utc

# terminal status → the coarse `outcome` label the dashboards group on
_OUTCOME_FOR = {"succeeded": "success", "fell_back": "fallback", "errored": "error"}


class _RunHandle:
    """The mutable handle yielded inside the `with` block. Lets the call site
    record token/cost usage, confidence, and a fallback, without exposing the
    finalization machinery."""

    def __init__(self, run: AgentRun) -> None:
        self.run = run
        self._terminal = "succeeded"  # default unless fell_back() is called

    def meter(
        self,
        *,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        cost_usd: Decimal = Decimal("0"),
    ) -> None:
        self.run.prompt_tokens = prompt_tokens
        self.run.completion_tokens = completion_tokens
        self.run.cost_usd = cost_usd

    def confidence(self, value: Decimal) -> None:
        self.run.confidence = value

    def fell_back(self, reason: str) -> None:
        """Mark that the primary (LLM) path degraded and a deterministic
        fallback produced the result. Finalizes the run to `fell_back`."""
        self._terminal = "fell_back"
        self.run.fallback_reason = reason


def _run_snapshot_hash(run: AgentRun) -> str:
    """Full SHA-256 of the run's canonical record (lists canonicalized for
    order-insensitivity, per the house snapshot-hash discipline)."""
    payload = {
        "agent_name": run.agent_name,
        "agent_kind": run.agent_kind,
        "contract_version": run.contract_version,
        "provider": run.provider,
        "model": run.model,
        "input_hash": run.input_hash,
        "entity_type": run.entity_type,
        "entity_id": run.entity_id,
        "status": run.status,
        "outcome": run.outcome,
        "fallback_reason": run.fallback_reason,
        "cost_usd": str(run.cost_usd),
        "auto_completed": run.auto_completed,
    }
    canonical = json.dumps(
        _canonicalize(payload), sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _transition_agent_run(
    session: Session,
    run: AgentRun,
    *,
    to: str,
    actor_id: str,
    actor_type: str = "agent",
    metadata: Optional[dict] = None,
) -> None:
    """Move a run to a terminal state, stamping the snapshot hash and emitting
    an audit event. `actor_type` defaults to "agent" — the value that makes AI
    actions queryable vs generic "system" ones — but the human approve/abort
    edge (Phase 3) passes actor_type="user"."""
    from_status = run.status
    assert_valid_transition(
        AGENT_RUN_TRANSITIONS, from_status, to, entity_name="agent_run"
    )
    run.status = to
    run.outcome = _OUTCOME_FOR.get(to, run.outcome)
    run.completed_at = now_utc()
    run.snapshot_hash = _run_snapshot_hash(run)
    session.add(run)
    _add_audit_event(
        session=session,
        actor_id=actor_id,
        actor_type=actor_type,
        entity_type="agent_run",
        entity_id=run.id,
        event_type=f"agent_run.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )


@contextmanager
def record_agent_run(
    session: Session,
    *,
    agent_name: str,
    agent_kind: str,
    provider: str,
    model: str,
    contract_version: str,
    inputs: Any,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
) -> Iterator[_RunHandle]:
    run = AgentRun(
        id=f"arun-{uuid4().hex[:12]}",
        agent_name=agent_name,
        agent_kind=agent_kind,
        contract_version=contract_version,
        provider=provider,
        model=model,
        input_hash=canonical_input_hash(inputs),
        entity_type=entity_type,
        entity_id=entity_id,
        status="started",
    )
    session.add(run)
    session.flush()  # parent before the audit child references run.id (Postgres FK order)
    handle = _RunHandle(run)
    t0 = time.monotonic()
    try:
        yield handle
    except Exception:
        run.latency_ms = int((time.monotonic() - t0) * 1000)
        _transition_agent_run(
            session, run, to="errored", actor_id=f"agent:{agent_name}"
        )
        raise
    run.latency_ms = int((time.monotonic() - t0) * 1000)
    _transition_agent_run(
        session, run, to=handle._terminal, actor_id=f"agent:{agent_name}"
    )
