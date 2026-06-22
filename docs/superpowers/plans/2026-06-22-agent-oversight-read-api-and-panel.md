# Agent-Oversight Read API + Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the write-only `AgentRun` ledger through a scoped read API (`/api/agents/runs` + `/api/agents/rollup`) and surface it as an `AgentActivityPanel` on the broker and operator dashboards (web + mobile).

**Architecture:** A pure read service (`app/services/agent_runs.py`) resolves each run's venue at query time (today `incident → IncidentRecord.venue_id`) and filters by `accessible_venue_ids` — broker/admin see all, operators see only own-venue runs, null-entity runs are operator-invisible. A thin router (`app/api/v1/agents.py`) mirrors `intelligence.py`. The frontend polls the feed every 30s (no SSE) and renders a fallback-chip oversight panel beside `ExposurePanel`.

**Tech Stack:** FastAPI + SQLModel (backend), Pydantic schemas, Next.js/React + Vitest (web), React Native/Expo (mobile). Money is `Decimal` → string.

## Global Constraints

- Money is `Decimal` internally, serialized as **strings** at the JSON boundary (`app.money.usd_to_json`); never `float`.
- Venue scoping uses `app.auth.accessible_venue_ids` — **never persona-gated**. Returns `None` (broker/admin = unrestricted), a `set` (operator's venues), or empty `set` (anon).
- Services raise typed errors (`AgentRunsError`); the router translates `AgentRunsError → 400`. Auth failures → 401 in the router.
- Read-only over the existing `AgentRun` table — **no new columns**, no `_COLUMN_MIGRATIONS` entry.
- `input_hash` / `snapshot_hash` are internal provenance — **never** in the API payload.
- Timestamps via `app.time.now_utc`; never `datetime.utcnow`.
- Web/mobile parity for the new panel (`feedback_web_mobile_consistency`).
- Run backend tests from `backend/`: `python -m pytest`. Web from `frontend/`: `npx vitest run`.

---

### Task 1: Service scaffolding — `AgentRunsError` + `resolve_run_venue`

**Files:**
- Create: `backend/app/services/agent_runs.py`
- Test: `backend/tests/test_agent_runs_service.py`

**Interfaces:**
- Produces: `AgentRunsError(Exception)`; `resolve_run_venue(run: AgentRun, session: Session) -> str | None` (incident → `IncidentRecord.venue_id`, else `None`).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_agent_runs_service.py
from __future__ import annotations

from sqlmodel import Session, SQLModel, create_engine

from app.models import AgentRun, IncidentRecord
from app.services.agent_runs import resolve_run_venue


def _session() -> Session:
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _incident(session: Session, *, id: str, venue_id: str) -> IncidentRecord:
    inc = IncidentRecord(
        id=id, venue_id=venue_id, occurred_at="2026-06-01T00:00:00Z",
        location="floor", summary="s", reported_by="r",
        injury_observed=False, police_called=False, ems_called=False,
    )
    session.add(inc)
    session.flush()
    return inc


def _run(session: Session, *, entity_type=None, entity_id=None) -> AgentRun:
    run = AgentRun(
        id=f"arun-{entity_id or 'none'}", agent_name="risk_evaluator_agent",
        agent_kind="pipeline", contract_version="v1", provider="groq",
        model="m", input_hash="h", entity_type=entity_type, entity_id=entity_id,
        status="succeeded", outcome="success",
    )
    session.add(run)
    session.flush()
    return run


def test_resolve_run_venue_incident_returns_its_venue():
    s = _session()
    _incident(s, id="inc-1", venue_id="venue-A")
    run = _run(s, entity_type="incident", entity_id="inc-1")
    assert resolve_run_venue(run, s) == "venue-A"


def test_resolve_run_venue_null_entity_returns_none():
    s = _session()
    run = _run(s, entity_type=None, entity_id=None)
    assert resolve_run_venue(run, s) is None


def test_resolve_run_venue_missing_incident_returns_none():
    s = _session()
    run = _run(s, entity_type="incident", entity_id="inc-gone")
    assert resolve_run_venue(run, s) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_runs_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.agent_runs'` (or `ImportError` for `resolve_run_venue`).

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/agent_runs.py
"""Read service over the AgentRun oversight ledger.

Read-only: never commits. Venue scope is resolved at query time (no venue_id
column on AgentRun) and enforced via app.auth.accessible_venue_ids — broker/admin
see all runs; operators see only runs whose entity resolves to one of their
venues; null-entity (unattributable) runs are operator-invisible.
"""
from __future__ import annotations

from typing import Optional

from sqlmodel import Session

from app.models import AgentRun, IncidentRecord


class AgentRunsError(Exception):
    """Typed service error — the router maps it to HTTP 400."""


def resolve_run_venue(run: AgentRun, session: Session) -> Optional[str]:
    """Resolve the venue a run is attributable to, or None if unattributable.

    Dispatch on entity_type. Today only 'incident' is written (PR2); Phase-2
    entity types (claim, packet) add a branch here without touching callers."""
    if run.entity_type == "incident" and run.entity_id:
        inc = session.get(IncidentRecord, run.entity_id)
        return inc.venue_id if inc else None
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_runs_service.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/agent_runs.py backend/tests/test_agent_runs_service.py
git commit -F - <<'EOF'
feat(agents): agent-runs read service scaffold + venue resolver

- AgentRunsError typed error (router -> 400)
- resolve_run_venue: incident -> IncidentRecord.venue_id, else None

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `list_runs` — scoped reverse-chron feed + per-entity history

**Files:**
- Modify: `backend/app/services/agent_runs.py`
- Test: `backend/tests/test_agent_runs_service.py`

**Interfaces:**
- Consumes: `resolve_run_venue`, `app.auth.accessible_venue_ids`.
- Produces: `_scoped_query(user, session) -> Select | None` (None ⇒ caller sees nothing); `list_runs(user, session, *, entity_type=None, entity_id=None, agent_kind=None, outcome=None, limit=50) -> list[AgentRun]` (ordered `created_at` desc, limit clamped 1..200).

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_agent_runs_service.py
from app.services.agent_runs import list_runs

BROKER = {"role": "broker", "sub": "u-broker"}


def _op(venue_id: str) -> dict:
    return {"role": "venue_operator", "sub": f"u-{venue_id}", "tenant_id": venue_id}


def _seed_two_venues(s: Session) -> None:
    _incident(s, id="inc-A", venue_id="venue-A")
    _incident(s, id="inc-B", venue_id="venue-B")
    _run(s, entity_type="incident", entity_id="inc-A")
    _run(s, entity_type="incident", entity_id="inc-B")
    _run(s, entity_type=None, entity_id=None)  # null-entity run


def test_broker_sees_all_runs_including_null_entity():
    s = _session()
    _seed_two_venues(s)
    runs = list_runs(BROKER, s)
    assert len(runs) == 3


def test_operator_sees_only_own_venue_and_not_null_entity():
    s = _session()
    _seed_two_venues(s)
    runs = list_runs(_op("venue-A"), s)
    ids = {r.entity_id for r in runs}
    assert ids == {"inc-A"}  # not inc-B, not the null-entity run


def test_per_entity_history_filters_to_that_entity():
    s = _session()
    _seed_two_venues(s)
    runs = list_runs(BROKER, s, entity_type="incident", entity_id="inc-B")
    assert [r.entity_id for r in runs] == ["inc-B"]


def test_limit_is_clamped_and_applied():
    s = _session()
    _incident(s, id="inc-A", venue_id="venue-A")
    for i in range(5):
        r = _run(s, entity_type="incident", entity_id="inc-A")
        r.id = f"arun-{i}"
        s.add(r)
    s.flush()
    assert len(list_runs(BROKER, s, limit=2)) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_runs_service.py -k "list_runs or sees or history or limit" -v`
Expected: FAIL — `ImportError: cannot import name 'list_runs'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add imports at top of backend/app/services/agent_runs.py
from sqlmodel import Session, select

from app.auth import accessible_venue_ids
```

```python
# append to backend/app/services/agent_runs.py
def _accessible_incident_ids(venue_ids: set[str], session: Session) -> set[str]:
    rows = session.exec(
        select(IncidentRecord.id).where(IncidentRecord.venue_id.in_(venue_ids))
    ).all()
    return set(rows)


def _scoped_query(user: dict | None, session: Session):
    """Base select(AgentRun) with venue scope applied, or None if the caller
    can see nothing. Broker/admin (scope None) get an unrestricted query."""
    scope = accessible_venue_ids(user, session)
    stmt = select(AgentRun)
    if scope is None:
        return stmt
    if not scope:
        return None
    inc_ids = _accessible_incident_ids(scope, session)
    if not inc_ids:
        return None
    return stmt.where(
        AgentRun.entity_type == "incident", AgentRun.entity_id.in_(inc_ids)
    )


def list_runs(
    user: dict | None,
    session: Session,
    *,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    agent_kind: Optional[str] = None,
    outcome: Optional[str] = None,
    limit: int = 50,
) -> list[AgentRun]:
    limit = max(1, min(limit, 200))
    stmt = _scoped_query(user, session)
    if stmt is None:
        return []
    if entity_type is not None:
        stmt = stmt.where(AgentRun.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(AgentRun.entity_id == entity_id)
    if agent_kind is not None:
        stmt = stmt.where(AgentRun.agent_kind == agent_kind)
    if outcome is not None:
        stmt = stmt.where(AgentRun.outcome == outcome)
    stmt = stmt.order_by(AgentRun.created_at.desc()).limit(limit)
    return list(session.exec(stmt).all())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_runs_service.py -v`
Expected: PASS (all, including Task 1's 3).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/agent_runs.py backend/tests/test_agent_runs_service.py
git commit -F - <<'EOF'
feat(agents): list_runs scoped feed + per-entity history

- accessible_venue_ids scoping; operators excluded from null-entity runs
- reverse-chron, optional agent_kind/outcome filters, limit clamped 1..200

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `rollup` — cost / fallback-rate / auto-vs-escalated by agent

**Files:**
- Modify: `backend/app/services/agent_runs.py`
- Test: `backend/tests/test_agent_runs_service.py`

**Interfaces:**
- Consumes: `_scoped_query`, `app.time.now_utc`.
- Produces: `@dataclass AgentRollupRow(agent_name: str, run_count: int, total_cost_usd: Decimal, fallback_count: int, auto_count: int, escalated_count: int)`; `rollup(user, session, *, window_days: int | None = 7) -> list[AgentRollupRow]` sorted by `agent_name`.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_agent_runs_service.py
from datetime import timedelta
from decimal import Decimal

from app.time import now_utc
from app.services.agent_runs import rollup


def _run_full(s, *, agent, entity_id, outcome, auto, cost, age_days=0):
    r = _run(s, entity_type="incident", entity_id=entity_id)
    r.id = f"arun-{agent}-{entity_id}-{outcome}-{auto}-{age_days}"
    r.agent_name = agent
    r.outcome = outcome
    r.status = "fell_back" if outcome == "fallback" else "succeeded"
    r.auto_completed = auto
    r.cost_usd = Decimal(cost)
    r.created_at = now_utc() - timedelta(days=age_days)
    s.add(r)
    s.flush()
    return r


def test_rollup_groups_by_agent_with_cost_and_rates():
    s = _session()
    _incident(s, id="inc-A", venue_id="venue-A")
    _run_full(s, agent="risk", entity_id="inc-A", outcome="success", auto=True, cost="0.001000")
    _run_full(s, agent="risk", entity_id="inc-A", outcome="fallback", auto=False, cost="0.002000")
    rows = rollup(BROKER, s)
    assert len(rows) == 1
    row = rows[0]
    assert row.agent_name == "risk"
    assert row.run_count == 2
    assert row.total_cost_usd == Decimal("0.003000")
    assert row.fallback_count == 1
    assert row.auto_count == 1
    assert row.escalated_count == 1


def test_rollup_default_window_excludes_old_runs():
    s = _session()
    _incident(s, id="inc-A", venue_id="venue-A")
    _run_full(s, agent="risk", entity_id="inc-A", outcome="success", auto=True, cost="0.001", age_days=1)
    _run_full(s, agent="risk", entity_id="inc-A", outcome="success", auto=True, cost="0.001", age_days=30)
    rows = rollup(BROKER, s, window_days=7)
    assert rows[0].run_count == 1  # the 30-day-old run is excluded
    rows_all = rollup(BROKER, s, window_days=None)
    assert rows_all[0].run_count == 2


def test_rollup_zero_runs_returns_empty_list():
    s = _session()
    assert rollup(BROKER, s) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_runs_service.py -k rollup -v`
Expected: FAIL — `ImportError: cannot import name 'rollup'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add imports at top of backend/app/services/agent_runs.py
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from app.time import now_utc
```

```python
# append to backend/app/services/agent_runs.py
@dataclass
class AgentRollupRow:
    agent_name: str
    run_count: int = 0
    total_cost_usd: Decimal = field(default_factory=lambda: Decimal("0"))
    fallback_count: int = 0
    auto_count: int = 0
    escalated_count: int = 0


def rollup(
    user: dict | None, session: Session, *, window_days: Optional[int] = 7
) -> list[AgentRollupRow]:
    stmt = _scoped_query(user, session)
    if stmt is None:
        return []
    if window_days is not None:
        cutoff = now_utc() - timedelta(days=window_days)
        stmt = stmt.where(AgentRun.created_at >= cutoff)
    rows: dict[str, AgentRollupRow] = {}
    for run in session.exec(stmt).all():
        row = rows.setdefault(run.agent_name, AgentRollupRow(agent_name=run.agent_name))
        row.run_count += 1
        row.total_cost_usd += run.cost_usd or Decimal("0")
        if run.outcome == "fallback":
            row.fallback_count += 1
        if run.auto_completed:
            row.auto_count += 1
        else:
            row.escalated_count += 1
    return [rows[name] for name in sorted(rows)]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_runs_service.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/agent_runs.py backend/tests/test_agent_runs_service.py
git commit -F - <<'EOF'
feat(agents): rollup by agent (cost, fallback, auto-vs-escalated)

- rolling 7-day default window; window_days=None -> all-time
- zero runs -> empty list (router renders neutral 200)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Schemas + router + registration

**Files:**
- Create: `backend/app/schemas/agents.py`
- Create: `backend/app/api/v1/agents.py`
- Modify: `backend/app/main.py` (register router near the other v1 includes, e.g. after the `intelligence_router` block ~line 469)
- Test: `backend/tests/test_agents_api.py`

**Interfaces:**
- Consumes: `list_runs`, `rollup`, `AgentRunsError` (service); `verify_token` (auth).
- Produces: `GET /api/agents/runs` → `AgentRunsResponse`; `GET /api/agents/rollup` → `AgentRollupResponse`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_agents_api.py
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_runs_requires_auth():
    assert client.get("/api/agents/runs").status_code == 401


def test_rollup_requires_auth():
    assert client.get("/api/agents/rollup").status_code == 401


def _broker_token() -> str:
    # Mirror the project's auth-test helper: log in the seeded broker demo user.
    resp = client.post(
        "/api/auth/login",
        json={"email": "broker@nightline.risk", "password": "demo"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def test_runs_returns_shape_for_broker():
    token = _broker_token()
    resp = client.get("/api/agents/runs", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert "runs" in body and isinstance(body["runs"], list)
    if body["runs"]:
        run = body["runs"][0]
        assert isinstance(run["cost_usd"], str)  # money is a string
        assert "input_hash" not in run and "snapshot_hash" not in run


def test_rollup_returns_shape_for_broker():
    token = _broker_token()
    resp = client.get("/api/agents/rollup", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["window"] == "7d"
    assert "agents" in body and isinstance(body["agents"], list)
    for row in body["agents"]:
        assert isinstance(row["total_cost_usd"], str)
        assert isinstance(row["fallback_rate"], str)
```

> NOTE for the implementer: confirm the seeded broker login (email/password) the
> other API tests use — grep `tests/` for `auth/login` and copy that exact
> credential helper if it differs from `broker@nightline.risk`/`demo`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agents_api.py -v`
Expected: FAIL — both auth tests 404 (route not registered) instead of 401.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/schemas/agents.py
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
```

```python
# backend/app/api/v1/agents.py
"""Agent-oversight read API — surfaces the AgentRun ledger.

Mirrors intelligence.py: Bearer-token gate, typed service errors → 400."""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlmodel import Session

from app.auth import verify_token
from app.database import get_session
from app.money import usd_to_json
from app.services.agent_runs import AgentRunsError, list_runs, rollup
from app.schemas.agents import (
    AgentRollupResponse,
    AgentRollupRowOut,
    AgentRunOut,
    AgentRunsResponse,
)
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
                cost_usd=usd_to_json(r.cost_usd or Decimal("0")),
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
                total_cost_usd=usd_to_json(row.total_cost_usd),
                fallback_rate=_fallback_rate(row.fallback_count, row.run_count),
                auto_count=row.auto_count, escalated_count=row.escalated_count,
            )
            for row in rows
        ],
    )
```

```python
# backend/app/main.py — add near the intelligence_router include (~line 469)
from app.api.v1.agents import router as agents_router  # noqa: E402
app.include_router(agents_router, prefix="/api", tags=["agents"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agents_api.py -v`
Expected: PASS (4 passed). If the broker credential differs, fix the helper per the NOTE and re-run.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/agents.py backend/app/api/v1/agents.py backend/app/main.py backend/tests/test_agents_api.py
git commit -F - <<'EOF'
feat(agents): read API routes for runs feed + rollup

- GET /api/agents/runs and /api/agents/rollup, Bearer-gated
- money as strings; provenance hashes omitted from payload
- AgentRunsError -> 400

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: Full backend suite green**

Run: `cd backend && python -m pytest -q`
Expected: prior green count + new tests pass (lone known red = the pre-existing `test_evals_baseline` order flake, passes in isolation).

---

### Task 5: Web — `lib/agents.ts` + `AgentActivityPanel` (PR4 starts)

**Files:**
- Create: `frontend/src/lib/agents.ts`
- Create: `frontend/src/components/intelligence/AgentActivityPanel.tsx`
- Test: `frontend/src/components/intelligence/AgentActivityPanel.test.tsx`

**Interfaces:**
- Produces: `fetchAgentRuns(): Promise<AgentRunsResponse>`; `AgentRun`/`AgentRunsResponse` types; `<AgentActivityPanel />` (no props; self-fetches + 30s poll; self-hides on empty/error).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/intelligence/AgentActivityPanel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentActivityPanel } from "./AgentActivityPanel";

afterEach(() => vi.restoreAllMocks());

function mockRuns(runs: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ runs }),
  })) as unknown as typeof fetch);
}

test("renders a fallback chip for a fell-back run", async () => {
  mockRuns([{
    id: "arun-1", agent_name: "risk", agent_kind: "pipeline", provider: "groq",
    model: "m", entity_type: "incident", entity_id: "inc-A", status: "fell_back",
    outcome: "fallback", fallback_reason: "groq_timeout", confidence: null,
    cost_usd: "0.0020", latency_ms: 12, auto_completed: false,
    created_at: "2026-06-22T00:00:00Z",
  }]);
  render(<AgentActivityPanel />);
  expect(await screen.findByText(/fallback/i)).toBeInTheDocument();
});

test("self-hides when there are no runs", async () => {
  mockRuns([]);
  const { container } = render(<AgentActivityPanel />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/intelligence/AgentActivityPanel.test.tsx`
Expected: FAIL — cannot resolve `./AgentActivityPanel`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/agents.ts
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface AgentRun {
  id: string;
  agent_name: string;
  agent_kind: string;
  provider: string;
  model: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  outcome: string | null;
  fallback_reason: string | null;
  confidence: string | null;
  cost_usd: string;
  latency_ms: number;
  auto_completed: boolean;
  created_at: string;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
}

export async function fetchAgentRuns(): Promise<AgentRunsResponse> {
  const res = await fetch(`${API_URL}/api/agents/runs`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`agents/runs ${res.status}`);
  return res.json();
}
```

```tsx
// frontend/src/components/intelligence/AgentActivityPanel.tsx
"use client";

import React, { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { fetchAgentRuns, type AgentRun } from "@/lib/agents";

const POLL_MS = 30_000;

/**
 * Agent-oversight panel — reverse-chron feed of recent AgentRuns with the
 * fallback chip as the headline signal. Scope is enforced by the API, so this
 * component carries no persona logic. Self-hides on empty/error (mirrors
 * ExposurePanel) so it never blocks the dashboard.
 */
export function AgentActivityPanel() {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAgentRuns()
        .then((r) => active && setRuns(r.runs))
        .catch(() => active && setError(true));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  if (error || runs === null || runs.length === 0) return null;

  return (
    <section aria-label="Agent activity" className="lc-exposure">
      <div className="lc-exposure__head">
        <h2 className="lc-exposure__title">
          <Bot size={18} aria-hidden /> Agent activity
        </h2>
        <span className="lc-exposure__kpi">
          <b data-testid="agent-runs-count">{runs.length}</b> recent runs
        </span>
      </div>
      <ul className="lc-exposure__list">
        {runs.map((r) => (
          <li key={r.id} className="lc-exposure__row">
            <div className="lc-exposure__row-main">
              <span className="lc-exposure__sev" style={{ color: "var(--text-secondary)" }}>
                {r.agent_name}
              </span>
              <p className="lc-exposure__why" style={{ color: "var(--text-tertiary)" }}>
                {r.entity_type ?? "—"}{r.entity_id ? ` · ${r.entity_id}` : ""} · {r.latency_ms}ms · ${r.cost_usd}
              </p>
            </div>
            <div className="lc-exposure__row-aside" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {r.outcome === "fallback" ? (
                <span
                  title={r.fallback_reason ?? "fallback"}
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.7rem", padding: "2px 8px",
                    borderRadius: "var(--radius-sm)", color: "var(--state-warning)",
                    border: "1px solid var(--state-warning)",
                  }}
                >
                  fallback
                </span>
              ) : (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--state-success)" }}>
                  {r.outcome ?? r.status}
                </span>
              )}
              <span
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-tertiary)" }}
              >
                {r.auto_completed ? "auto" : "escalated"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/intelligence/AgentActivityPanel.test.tsx`
Expected: PASS (2 passed).

- [ ] **Step 5: tsc + commit**

Run: `cd frontend && npx tsc --noEmit` → exit 0.

```bash
git add frontend/src/lib/agents.ts frontend/src/components/intelligence/AgentActivityPanel.tsx frontend/src/components/intelligence/AgentActivityPanel.test.tsx
git commit -F - <<'EOF'
feat(web): AgentActivityPanel — 30s-poll agent-oversight feed

- fetchAgentRuns (authHeaders); fallback chip as the headline signal
- self-hides on empty/error; scope enforced by the API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Web — mount the panel on both dashboards

**Files:**
- Modify: `frontend/src/app/dashboard/page.tsx` (mount `<AgentActivityPanel />` immediately after each `<ExposurePanel ... />` render — both the broker and the operator branches)

**Interfaces:**
- Consumes: `<AgentActivityPanel />` from Task 5.

- [ ] **Step 1: Locate the ExposurePanel mounts**

Run: `cd frontend && npx rg -n "ExposurePanel" src/app/dashboard/page.tsx`
Expected: one or more JSX usages (broker + operator branches).

- [ ] **Step 2: Add the import**

At the top of `frontend/src/app/dashboard/page.tsx`, beside the existing ExposurePanel import:

```tsx
import { AgentActivityPanel } from "@/components/intelligence/AgentActivityPanel";
```

- [ ] **Step 3: Render the panel after each ExposurePanel**

For **each** `<ExposurePanel ... />` JSX site in the file, add immediately after it:

```tsx
<AgentActivityPanel />
```

(The panel self-hides when empty, so it's safe on every persona branch.)

- [ ] **Step 4: Verify build + tsc**

Run: `cd frontend && npx tsc --noEmit && npx next build`
Expected: tsc exit 0; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/dashboard/page.tsx
git commit -F - <<'EOF'
feat(web): mount AgentActivityPanel on broker + operator dashboards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Mobile — `api/agents.ts` + `AgentActivityCard` + mount

**Files:**
- Create: `mobile/src/api/agents.ts`
- Create: `mobile/src/components/AgentActivityCard.tsx`
- Modify: `mobile/src/screens/DashboardScreen.tsx` (render `<AgentActivityCard />` near the existing `<ExposureCard ... />`)

**Interfaces:**
- Consumes: `api.request` (`mobile/src/api/client.ts`), `Colors` (`mobile/src/theme/colors`).
- Produces: `fetchAgentRuns(): Promise<AgentRunsResponse>`; `<AgentActivityCard />` (self-fetch + 30s poll, self-hides on empty/error, RN-token styled to mirror `ExposureCard`).

- [ ] **Step 1: Create the API client**

```ts
// mobile/src/api/agents.ts
// Agent-oversight feed — mirrors web frontend/src/lib/agents.ts over the RN api client.
import { api } from './client';

export interface AgentRun {
  id: string;
  agent_name: string;
  agent_kind: string;
  provider: string;
  model: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  outcome: string | null;
  fallback_reason: string | null;
  confidence: string | null;
  cost_usd: string;
  latency_ms: number;
  auto_completed: boolean;
  created_at: string;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
}

export async function fetchAgentRuns(): Promise<AgentRunsResponse> {
  return api.request<AgentRunsResponse>('/api/agents/runs');
}
```

- [ ] **Step 2: Create the card (mirror ExposureCard structure + styles)**

```tsx
// mobile/src/components/AgentActivityCard.tsx
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Colors } from '../theme/colors';
import { fetchAgentRuns, type AgentRun } from '../api/agents';

const POLL_MS = 30_000;
const MAX_ROWS = 8;

/**
 * Agent-oversight feed for the RN dashboard (parity with the web
 * AgentActivityPanel). Self-fetches, polls every 30s, self-hides on
 * empty/error. Scope is enforced by the API.
 */
export function AgentActivityCard() {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAgentRuns()
        .then((r) => active && setRuns(r.runs))
        .catch(() => active && setError(true));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  if (error || runs === null || runs.length === 0) return null;
  const rows = runs.slice(0, MAX_ROWS);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>AGENT ACTIVITY</Text>
        <Text style={styles.kpi}>{runs.length} recent runs</Text>
      </View>
      <View>
        {rows.map((r) => {
          const fellBack = r.outcome === 'fallback';
          const color = fellBack ? Colors.warning : Colors.textSecondary;
          return (
            <View key={r.id} style={[styles.row, { borderLeftColor: color }]}>
              <Text style={[styles.rowAgent, { color }]}>{r.agent_name}</Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {(r.entity_type ?? '—')}{r.entity_id ? ` · ${r.entity_id}` : ''} · {r.latency_ms}ms · ${r.cost_usd}
              </Text>
              <Text style={[styles.rowOutcome, { color }]}>
                {fellBack ? `fallback${r.fallback_reason ? ` · ${r.fallback_reason}` : ''}` : (r.outcome ?? r.status)}
                {r.auto_completed ? ' · auto' : ' · escalated'}
              </Text>
            </View>
          );
        })}
      </View>
      {runs.length > MAX_ROWS && <Text style={styles.more}>+{runs.length - MAX_ROWS} more</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 16, padding: 20, marginBottom: 12,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  kpi: { color: Colors.textSecondary, fontSize: 11, letterSpacing: 0.4, fontFamily: 'SpaceMono_400Regular' },
  row: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSubtle },
  rowAgent: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },
  rowMeta: { color: Colors.textSecondary, fontSize: 12, marginTop: 3, fontFamily: 'HankenGrotesk_400Regular' },
  rowOutcome: { fontSize: 11, marginTop: 4, fontFamily: 'HankenGrotesk_600SemiBold' },
  more: { color: Colors.textMuted, fontSize: 12, marginTop: 12, fontFamily: 'SpaceMono_400Regular' },
});
```

- [ ] **Step 3: Mount on the dashboard**

Run: `cd mobile && npx rg -n "ExposureCard" src/screens/DashboardScreen.tsx` to find the render site, add the import:

```tsx
import { AgentActivityCard } from '../components/AgentActivityCard';
```

and render `<AgentActivityCard />` immediately after the `<ExposureCard ... />` element.

- [ ] **Step 4: Verify tsc**

Run: `cd mobile && npx tsc --noEmit`
Expected: exit 0 (no Expo render test — the project relies on tsc for RN per the backlog).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/api/agents.ts mobile/src/components/AgentActivityCard.tsx mobile/src/screens/DashboardScreen.tsx
git commit -F - <<'EOF'
feat(mobile): AgentActivityCard on the RN dashboard (web parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage:**
- §2.1 resolver → Task 1. §2.2 list_runs → Task 2. §2.3 rollup → Task 3. §3 schemas/router/registration → Task 4. §4 web panel → Tasks 5–6; mobile → Task 7. §5 testing → tests in every task. §6 conventions → Global Constraints. §7 PR split → Tasks 1–4 (PR3), Tasks 5–7 (PR4). No gaps.

**Placeholder scan:** No TBD/TODO; every code/test step shows real content. The two `rg`-to-locate steps (Tasks 6, 7) are unavoidable (the exact dashboard JSX line isn't knowable from here) but each names the exact file, import, and component to add — not a vague instruction. The Task 4 broker-credential NOTE is a verification instruction, not a placeholder.

**Type consistency:** `AgentRollupRow` (service dataclass: `fallback_count`) vs `AgentRollupRowOut` (schema: `fallback_rate` computed in the router via `_fallback_rate`) — intentionally different; the router maps count→rate. `AgentRun`/`AgentRunsResponse` field names match across `lib/agents.ts`, `api/agents.ts`, and `schemas/agents.py`. `list_runs`/`rollup`/`_scoped_query` signatures match between definition (Tasks 2–3) and consumption (Task 4).

## Execution Handoff

PR3 = Tasks 1–4 (backend, independently shippable). PR4 = Tasks 5–7 (web + mobile).
