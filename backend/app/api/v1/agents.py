"""Agent-oversight read API — surfaces the AgentRun ledger.

Mirrors intelligence.py: Bearer-token gate, typed service errors → 400."""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlmodel import Session

from app.auth import verify_token
from app.database import get_session
from app.schemas.agents import (
    AgentRollupResponse,
    AgentRollupRowOut,
    AgentRunOut,
    AgentRunsResponse,
)
from app.services.agent_runs import AgentRunsError, list_runs, rollup
from app.time import now_utc

router = APIRouter()


def _require_user(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    user = verify_token(authorization.split(" ")[1])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


def _fallback_rate(fallback: int, total: int) -> str:
    if total == 0:
        return "0.0000"
    return str((Decimal(fallback) / Decimal(total)).quantize(Decimal("0.0001")))


@router.get("/agents/runs", response_model=AgentRunsResponse)
def get_runs(
    authorization: str = Header(None),
    entity_type: str | None = Query(None),
    entity_id: str | None = Query(None),
    agent_kind: str | None = Query(None),
    outcome: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
) -> AgentRunsResponse:
    user = _require_user(authorization)
    try:
        runs = list_runs(
            user, session, entity_type=entity_type, entity_id=entity_id,
            agent_kind=agent_kind, outcome=outcome, limit=limit,
        )
    except AgentRunsError as exc:
        raise HTTPException(status_code=400, detail={"error": "agent_runs", "message": str(exc)})
    return AgentRunsResponse(
        runs=[
            AgentRunOut(
                id=r.id, agent_name=r.agent_name, agent_kind=r.agent_kind,
                provider=r.provider, model=r.model, entity_type=r.entity_type,
                entity_id=r.entity_id, status=r.status, outcome=r.outcome,
                fallback_reason=r.fallback_reason,
                confidence=str(r.confidence) if r.confidence is not None else None,
                cost_usd=str(r.cost_usd or Decimal("0")),
                latency_ms=r.latency_ms, auto_completed=r.auto_completed,
                created_at=r.created_at,
            )
            for r in runs
        ]
    )


@router.get("/agents/rollup", response_model=AgentRollupResponse)
def get_rollup(
    authorization: str = Header(None),
    window: str = Query("7d"),
    session: Session = Depends(get_session),
) -> AgentRollupResponse:
    user = _require_user(authorization)
    if window not in {"7d", "all"}:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "agent_runs",
                "message": f"invalid window: {window!r} (expected '7d' or 'all')",
            },
        )
    window_days = None if window == "all" else 7
    try:
        rows = rollup(user, session, window_days=window_days)
    except AgentRunsError as exc:
        raise HTTPException(status_code=400, detail={"error": "agent_runs", "message": str(exc)})
    return AgentRollupResponse(
        window=window,
        generated_at=now_utc(),
        agents=[
            AgentRollupRowOut(
                agent_name=row.agent_name, run_count=row.run_count,
                total_cost_usd=str(row.total_cost_usd),
                fallback_rate=_fallback_rate(row.fallback_count, row.run_count),
                auto_count=row.auto_count, escalated_count=row.escalated_count,
            )
            for row in rows
        ],
    )
