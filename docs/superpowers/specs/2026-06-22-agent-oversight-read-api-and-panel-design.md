# Agent-Oversight Read API + Panel — Design (Track 17, PR3 + PR4)

**Date:** 2026-06-22
**Track:** 17 (Agent-oversight ledger — `AgentRun`)
**Depends on:** PR1 (`2ac0f9f`, ledger primitive) + PR2 (`0e435b3`, live-pipeline instrumentation), both shipped.
**Status:** Design approved; implementation pending (two PRs from one spec).

## 1. Problem & intent

The "Agentic Insurance Enterprise" thesis names three shifts; our weakest is **agent
oversight**. PR1/PR2 gave us the persisted `AgentRun` ledger and now write a run per
agent per incident (5 per incident; risk/memo emit `fell_back`). But those rows are
**write-only** — nothing reads them. PR3 adds the read API; PR4 surfaces it as an
oversight panel on the dashboards. Together they turn the silent `fallback_reason`
and the `auto_completed` flag into visible operator/broker signals.

Non-goals (explicitly deferred to Track 17 Phase 2/3): unifying cost/rate-limit
metering, instrumenting fraud/vision/copilot, the human approve/abort escalation
edge. This spec is read + display only.

## 2. Backend read service — `app/services/agent_runs.py`

Pure service layer. Raises typed `AgentRunsError` (router maps → 400). Never commits
(read-only anyway, but follows the house rule). Money is `Decimal` internally,
serialized as **strings** at the schema boundary.

### 2.1 Entity → venue resolution

`AgentRun` carries `entity_type`/`entity_id` but **no `venue_id`** (intentional — no
schema change in this PR). Operator scoping resolves the venue at query time:

```
def resolve_run_venue(run, session) -> str | None
```

A dispatch keyed on `entity_type`:
- `"incident"` → `session.get(Incident, entity_id).venue_id` (the only mapping live today).
- unknown / `None` / missing row → `None` ("not venue-attributable").

Extensible: Phase-2 entity types (`"claim"`, `"packet"`) add a dispatch entry without
touching callers. The resolver is the single chokepoint for the scoping rule.

### 2.2 `list_runs` — reverse-chron feed + per-entity history

```
list_runs(user, session, *, entity_type=None, entity_id=None,
          agent_kind=None, outcome=None, limit=50) -> list[AgentRun]
```

1. Resolve `accessible_venue_ids(user, session)` (existing `app.auth` helper):
   - `None` → broker/admin: **no venue filter** (sees all rows, including null-entity).
   - a `set` → operator: keep only runs whose `resolve_run_venue` ∈ the set.
     **Null-entity / unresolvable runs are excluded** — an operator can't see a run
     that can't be attributed to one of their venues.
   - empty `set` → anonymous/unknown: returns `[]` (router already 401s first).
2. Apply optional `agent_kind` / `outcome` filters.
3. When both `entity_type` and `entity_id` are given → per-entity history (same
   scope check still applies).
4. Order by `created_at` desc; cap at `limit` (default 50, clamp to a sane max e.g. 200).

To keep scoping efficient, the query pre-filters to the candidate set in SQL where
possible (e.g. for operators, restrict `entity_type="incident"` + a sub-select of
incident ids in the accessible venues), then the resolver double-checks in memory.
Broker path is a straight `created_at`-desc select.

### 2.3 `rollup` — cost / fallback-rate / auto-vs-escalated by agent

```
rollup(user, session, *, window_days: int | None = 7) -> AgentRollup
```

Over the same scoped row set, restricted to `created_at >= now - window_days`
(`window_days=None` → all-time), grouped by `agent_name`:
- `run_count`
- `total_cost_usd` (summed `Decimal` → string)
- `fallback_rate` = `fell_back` count ÷ `run_count` (serialized as a string, 4dp)
- `auto_count` (`auto_completed=True`) vs `escalated_count` (`auto_completed=False`)

Zero runs in window → **neutral empty rollup** (200, `agents: []`), never an error.

## 3. Router + schemas — `app/api/v1/agents.py`, `app/schemas/agents.py`

Mirrors `intelligence.py`: `Authorization: Bearer` gate (401 on missing/invalid via
`verify_token`), `_map_service_error` translating `AgentRunsError → 400`. Registered in
`main.py` as `app.include_router(agents_router, prefix="/api", tags=["agents"])`.

### Endpoints
- `GET /api/agents/runs` — query params `entity_type`, `entity_id`, `agent_kind`,
  `outcome`, `limit`. Returns `AgentRunsResponse { runs: [AgentRunOut] }`.
- `GET /api/agents/rollup` — query param `window` (`"7d"` default | `"all"`; parsed to
  `window_days=7` | `None`). Returns
  `AgentRollupResponse { window, generated_at, agents: [AgentRollupRow] }`.

### `AgentRunOut` (oversight payload — provenance hashes intentionally omitted)
`id, agent_name, agent_kind, provider, model, entity_type, entity_id, status,
outcome, fallback_reason, confidence (str|null), cost_usd (str), latency_ms,
auto_completed, created_at`.

`input_hash` and `snapshot_hash` are **not** exposed — they're internal provenance,
not oversight UI.

### `AgentRollupRow`
`agent_name, run_count, total_cost_usd (str), fallback_rate (str), auto_count,
escalated_count`.

## 4. Frontend panel (PR4) — web + mobile

Scope is enforced entirely by the API; the components carry **no persona logic**.

### Web — `components/intelligence/AgentActivityPanel.tsx`
Mounted beside `ExposurePanel` on **both** the broker and operator dashboards. 30s
`setInterval` poll of `/api/agents/runs` (reuse the `alerts/page.tsx` poll pattern —
SSE is over-scope), with `authHeaders()` on the fetch (raw fetch 401s silently
without it — see `project_web_upload_auth_pattern`). Built on `ds/` primitives (Paper
& Ink), explicit text colors on every element.

Per-row columns: **agent** · **entity** (type + short id) · **outcome** (success vs a
**fallback chip** — the headline oversight signal) · **cost** · **latency** ·
**auto-vs-escalated** badge. Self-hides on empty/error (mirror `ExposurePanel`).

### Mobile — `mobile/src/components/AgentActivityCard.tsx` + `mobile/src/api/agents.ts`
Inserted on the RN dashboard near `ExposureCard`, same poll + scope, RN-token styled
to mirror `ExposureCard` (keep web/mobile parity per `feedback_web_mobile_consistency`).

## 5. Testing

- **Service:** in-memory session; seed `AgentRun`s + incidents across two venues.
  Assert broker-sees-all (incl. null-entity); operator-sees-own-venue-only and
  excludes null-entity/foreign; per-entity history filter; rollup math (count, summed
  cost-as-string, fallback_rate, auto-vs-escalated) and the 7-day window boundary;
  zero-runs → neutral 200.
- **Router:** 401 missing/invalid token; 200 shapes; `AgentRunsError → 400`; money
  fields are strings.
- **Frontend (Vitest):** panel renders rows, shows the fallback chip on
  `outcome="fallback"`, self-hides on empty/error. No new E2E (poll-only,
  non-mutating).

## 6. Conventions honored

- Money `Decimal` → string at the JSON boundary (`app.money`); no `float`.
- Venue scoping via `accessible_venue_ids` — **never persona-gated**.
- Read service raises typed errors; router translates (`AgentRunsError → 400`).
- New table column? **No** — read-only over the existing `AgentRun`; no
  `_COLUMN_MIGRATIONS` entry needed.
- Web/mobile parity for the new panel.

## 7. PR split

- **PR3:** §2 + §3 (service, schemas, router, backend tests). Independently shippable
  and testable.
- **PR4:** §4 (web + mobile panel, Vitest), consuming PR3's API.
