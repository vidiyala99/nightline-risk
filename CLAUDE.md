<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes � gives risk-scored analysis |
| `get_review_context` | Need source snippets for review � token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

---

## Codebase orientation

Two parallel data layers live in `backend/app/`:

| Layer | Domain | Entry points |
|---|---|---|
| Evidence | Incidents → packets → claim proposals (operator/broker review surface) | `app/incident_flow.py`, `app/packet_core.py`, `app/claim_proposals.py`, `app/agents/`, `app/api/v1/ingestion.py` |
| Broker platform | Submissions → quotes → policies → carrier-side claims | `app/services/{submissions,policies,claims}.py`, `app/api/v1/{placement,policies,claims}.py`, `app/lifecycles.py`, `app/underwriting/pricing.py` |

Architecture references: [`docs/superpowers/specs/2026-05-07-architecture-v2.md`](docs/superpowers/specs/2026-05-07-architecture-v2.md) (evidence), [`docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md`](docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md) (broker), [`docs/adr/0004-broker-platform-and-claim-vocabulary-split.md`](docs/adr/0004-broker-platform-and-claim-vocabulary-split.md) (Claim ≠ ClaimProposal).

## Conventions for new broker-platform code

These are enforced across `app/services/`, `app/api/v1/`, and any new schema in `app/models.py`. The spec at `docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md` §2 has the canonical examples.

- **Money:** `Decimal`, never `float`. Use `app.money` helpers (`usd`, `usd_to_json`, `json_to_usd`). SQL columns: `Numeric(12, 2)`. JSON columns store money as **strings**.
- **Timestamps:** new tables use `default_factory=now_utc` from `app.time`. Don't touch legacy `datetime.utcnow` warnings — out of scope.
- **Lifecycles:** typed `Literal[...]` + `TRANSITIONS: dict[str, set[str]]` in `app/lifecycles.py`. Every status mutation goes through a `_transition_<entity>(session, row, *, to, actor_id, metadata)` helper that calls `assert_valid_transition(...)`.
- **Audit events:** every state transition emits `app.packet_core._add_audit_event` with `event_type=f"{entity}.{to_state}"`. Lifecycle helpers do this; ad-hoc service code emitting business events should follow the same shape.
- **Snapshot hashes:** SHA-256 of canonical JSON. **Sort list contents** before hashing (e.g. `sorted(policy.coverage_lines)`) — `json.dumps(sort_keys=True)` only sorts dict keys, list order drift is a real risk on Postgres upgrades. `Policy.snapshot_hash` re-computes on bind/endorsement/policy-number assignment **only**, not on status changes. `Claim.snapshot_hash` re-computes on every money/status mutation.
- **Atomic operations:** wrap multi-step mutations as a single function (e.g. `bind_quote`'s 6 effects). Don't commit inside services — the API layer or test fixture owns commit/rollback. `session.flush()` parents before children when you'll FK to them immediately, especially with column-level FKs declared via `sa_column=Column(ForeignKey(...))`.
- **Error mapping:** services raise typed errors (`SubmissionsError`, `PoliciesError`, `ClaimsError`, `InvalidTransitionError`, etc.); routers catch and translate. The pattern is `ClaimsError → 400`, `InvalidTransitionError → 422` with structured `{error, message}` detail. See `_map_service_error` in each `app/api/v1/*.py` router.

## Vocabulary

- **`ClaimProposal`** = operator's internal recommendation that an incident should be filed (the evidence layer). Routed for broker decision. Routes: `/api/claim-proposals/*`.
- **`Claim`** = carrier-side row representing a real reported loss with reserves and payments (the broker platform layer). Routes: `/api/claims/*`.
- They link via `Claim.proposal_id` (optional) when a proposal eventually becomes a real FNOL. Most claims will *not* have a proposal.
- The legacy `/api/claims` and `/api/claims/{packet_id}` endpoints (which returned `ClaimProposal` rows) were renamed in 2026-05-21 to `/api/claim-proposals` and `/api/claim-proposals/by-packet/{packet_id}`. Don't reintroduce the old paths.

## Demo data

All idempotent. Run from `backend/`:

```powershell
python -m scripts.seed_demo_placements   # 4 submissions (one per non-terminal state) + 1 bound policy
python -m scripts.seed_prospects         # ~286 NYC nightlife prospects from the cleaned market snapshot
python -m scripts.seed_defense_demo      # incident → hashed evidence → packet → claim w/ defense_package_id (PDF exportable)
python -m scripts.dedupe_venues          # dry-run merge of duplicate venues; --apply to execute
```

Run seed scripts against prod (Railway) with the Postgres **public** URL:
`DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.<name>` (railway run injects the internal host, which won't resolve locally).

## Conventions (data integrity)

- **Venue uniqueness:** keyed on normalized **(name, address)** in `create_venue` (`app/api/v1/venues.py`) — same name at a different address is allowed and gets a suffixed slug. `tenant_id == venue_id` for operators, so merges must repoint operator links too (see `scripts/dedupe_venues.py`).
- **JSON list columns on Postgres:** `Column(JSON)` list fields (e.g. `IncidentRecord.parties/witnesses`, `packet.claims_timeline`) round-trip as parsed lists on SQLite but as **JSON strings** on Postgres — coerce at the read boundary (`_as_list` in `app/defense_package.py`) before iterating, or `list(value)` silently iterates characters.
- **File storage:** route all uploaded bytes through `app/storage.py` `get_storage()` (`LocalStorage` today, `STORAGE_BACKEND=s3` is a future one-class swap). Don't write/read evidence files with raw `open()`/`write_bytes`. Local storage is **ephemeral on Railway** — real persistence needs the S3 backend (see `docs/go-live-readiness.md`).
- **Config / secrets:** `app/config.py` `validate_startup_env()` runs first in the lifespan and **refuses to boot in prod without `APP_SECRET`**. Env detection: `is_production()` keys off `RAILWAY_ENVIRONMENT`/`APP_ENV`. Document new env vars in `backend/.env.example`.
- **Account self-service:** `PATCH /api/auth/me` (name/email), `POST /api/auth/me/change-password`, and `POST /api/auth/forgot-password` + `/reset-password` (purpose-scoped reset tokens; email via the env-gated `app/services/email.py`, which logs the reset URL when `RESEND_API_KEY` is unset).
- **Venue-scoped list views:** any list screen that accepts a `venueId` route param (mobile) or `?venue=` query param (web) MUST honor it for **both** brokers and operators. Use the venue-scoped endpoint (`/api/venues/{id}/incidents`, `/api/venues/{id}/live`, etc.) when the param is present — never gate scoping on persona. Render a visible scope indicator (header + clear affordance) so the user can see and undo the filter. Reference patterns: `frontend/src/app/incidents/page.tsx` (filter chip w/ ×), `mobile/src/screens/BrokerComplianceScreen.tsx` (scoped header w/ back link), `mobile/src/screens/IncidentListScreen.tsx` (scope pill w/ CLEAR).

## Testing

- Full backend: `cd backend && python -m pytest -q` (740 tests as of 2026-05-27).
- The 62 `test_phase_1.py` characterization tests pin every `(venue × tier × billing)` cell of `pricing.py`. New pricing work must keep them green.
