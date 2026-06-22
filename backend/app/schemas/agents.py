from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class AgentRunOut(BaseModel):
    id: str
    agent_name: str
    agent_kind: str
    provider: str
    model: str
    entity_type: str | None = None
    entity_id: str | None = None
    status: str
    outcome: str | None = None
    fallback_reason: str | None = None
    confidence: str | None = None
    cost_usd: str
    latency_ms: int
    auto_completed: bool
    created_at: datetime


class AgentRunsResponse(BaseModel):
    runs: list[AgentRunOut]


class AgentRollupRowOut(BaseModel):
    agent_name: str
    run_count: int
    total_cost_usd: str
    fallback_rate: str
    auto_count: int
    escalated_count: int


class AgentRollupResponse(BaseModel):
    window: str
    generated_at: datetime
    agents: list[AgentRollupRowOut]
