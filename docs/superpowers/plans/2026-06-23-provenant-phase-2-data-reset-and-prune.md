# Provenant Phase 2 — Data Reset & Prune (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the nightlife-only subsystems (live floor/occupancy, the 4 operational connectors, the NYC market map + prospects) and wipe all demo data, leaving the broker/MGA platform booting clean and the test suite green — with no new domain logic yet.

**Architecture:** Pure subtraction. Work leaf→root (UI → tests → boot wiring → routes → modules → data) so no module is ever left importing a deleted symbol. Each task removes one subsystem end-to-end (web + mobile + backend + its tests), keeps the suite green, and commits. The loss-run subsystem, the ingestion push path + spine (`base.py`/`webhook.py`/`api/v1/ingestion.py`), carriers/users seeds, and the pricing/appetite engine are explicitly KEPT.

**Tech Stack:** FastAPI + SQLModel (backend, `python -m pytest`), Next.js + TypeScript (web), React Native (mobile), SQLite local / Neon Postgres prod.

## Global Constraints

- Solo repo: commit + push directly to `main`, no PRs. Clean commit messages (short subject + 2–4 bullets); use `git commit -F` (apostrophes break `-m`).
- **Clean-DB gate:** the shared `test_run.db` produces false-greens. After each task run the backend suite, and before the Phase-2 sign-off (Task 6) run it on a FRESH database. Postgres + clean-DB is the real gate.
- Money = `Decimal` via `app.money`; timestamps = `DateTimeUTC`; status changes via `_transition_<entity>` + `assert_valid_transition`; audit via `_add_audit_event`; snapshot hashes = SHA-256 of canonical JSON with sorted list contents. (No new money/status code in this phase, but keep these intact while editing.)
- **Do NOT touch:** loss-run (`app/services/loss_run.py`, `app/api/v1/loss_run.py`, `test_loss_run*.py`); ingestion spine `app/ingestion/base.py`, `webhook.py`, `api/v1/ingestion.py` (push path); `app/seed_carriers.py`, `app/seed_users.py`, `scripts/seed_demo_users.py`; the eval harness, agent-run ledger, and loss-run extraction logic; the real-competitor mention in `docs/research/insurtech-ai-native-landscape.md`; historical `thirdspacerisk-production` hostname literals.
- Run backend commands from `backend/`. Run the full suite with `python -m pytest -q`.

---

### Task 1: Remove the live floor/occupancy subsystem

**Files:**
- Delete: `backend/app/live_state.py`; `backend/app/api/v1/operations.py`
- Modify: `backend/app/main.py` (import 14, 37; usages 836, 981, 987; router mount 423-424; `_ingest_tick`/seed wiring is Task 2/3), `backend/app/api/v1/venues.py` (import 28 & 35; lines 372, 379, 390), `backend/app/auth.py` (delete `can_read_venue_floor`, 423-449), `backend/app/services/compliance_signals.py` (line 53 import), `backend/app/underwriting/scoring.py:382`, `backend/app/underwriting/pricing.py:256`
- Web: `frontend/src/app/dashboard/page.tsx`, `frontend/src/components/mobile/DashboardMobile.tsx`, `frontend/src/app/compliance/page.tsx`, `frontend/src/app/compliance/[venueId]/[itemId]/page.tsx`, `frontend/src/app/terminal/page.tsx`, `frontend/src/app/terminal/[venueId]/page.tsx`; regenerate API client (`frontend/src/api/models/LiveVenueState.ts`, `InfrastructureItem.ts`, `services/DefaultService.ts`, `index.ts`)
- Mobile: delete `mobile/src/screens/LiveTerminalScreen.tsx`, `mobile/src/navigation/LiveStack.tsx`; edit `mobile/src/screens/DashboardScreen.tsx` (381), `BrokerVenueDetailScreen.tsx`, `RiskProfileDetailScreen.tsx`, `OperatorComplianceScreen.tsx`, `ComplianceItemDetailScreen.tsx`, `BrokerPortfolioScreen.tsx`, `BrokerComplianceScreen.tsx`, `mobile/src/lib/triage.ts`
- Test: trim `backend/tests/test_risk_score_live_delta.py` (delete — it asserts the live-state→score delta), `backend/tests/test_compliance_citation_linkage.py` (drop `live_state` import, line 20), and any `can_read_venue_floor` assertions in `test_auth.py`/`test_tenant_isolation.py`/`test_operator_write_gating.py`/`test_portfolio.py`/`test_frontend_api_contract.py`.

**Interfaces:**
- Consumes: nothing from prior tasks (first task).
- Produces: `get_risk_score(venue_id, venues, session=None, delta_tracker=None, now=None)` and `get_premium_quote(venue_id, venues, billing="annual", session=None)` — both with the `live_state_manager` parameter REMOVED. No `/api/venues/{id}/live`, `/events/stream`, `/events/inject` routes. No `can_read_venue_floor` symbol.

- [ ] **Step 1: Drop the dead `live_state_manager` parameter from the underwriting functions**

In `backend/app/underwriting/scoring.py`, delete line 382 (`live_state_manager: Any | None = None,  # legacy ...`). In `backend/app/underwriting/pricing.py`, delete line 256 (`live_state_manager=None,`) and remove any `live_state_manager=live_state_manager` pass-through inside `get_premium_quote`'s body (it calls `get_risk_score` at ~263).

- [ ] **Step 2: Delete the live routes + module**

Delete `backend/app/api/v1/operations.py` and `backend/app/live_state.py`. In `backend/app/main.py`: remove the `live_state_manager` import (line 37), the operations router import + mount (lines 423-424), the `can_read_venue_floor` re-export (line 14), and the in-memory live usages at 836 (`simulate_event_queue` helper), 981, 987 (`_find_compliance_item` fallback). In `backend/app/api/v1/venues.py`: remove the `can_read_venue_floor` import (28) and `live_state_manager` import (35), and at line 379 stop calling `live_state_manager.get_state` (portfolio occupancy) and at 390 remove the `can_read_venue_floor`-gated capacity-nulling (the column is going away with the live feed).

- [ ] **Step 3: Remove the gate and the stray constant importer**

In `backend/app/auth.py` delete `can_read_venue_floor` (lines 423-449); KEEP `can_access_venue`, `accessible_venue_ids`, `require_venue_access`. In `backend/app/services/compliance_signals.py` (line ~53) replace the `from app.live_state import MAX_AUTO_GENERATED_COMPLIANCE_ITEMS` local import by inlining the literal: `MAX_AUTO_GENERATED_COMPLIANCE_ITEMS = 10` as a module constant in `compliance_signals.py`.

- [ ] **Step 4: Remove web + mobile live consumers and regenerate the API client**

Delete the live-telemetry UI: in each listed web page remove the `/api/venues/{id}/live` fetch + `LiveVenueState`/occupancy rendering; delete `mobile/src/screens/LiveTerminalScreen.tsx` and `mobile/src/navigation/LiveStack.tsx` and remove their nav registration; strip the `can_read_venue_floor`/live-capacity references in the listed mobile screens and `mobile/src/lib/triage.ts`. Regenerate the OpenAPI client (the repo's existing generation command) so `LiveVenueState.ts`/`InfrastructureItem.ts` and the `/live` service methods drop out.

- [ ] **Step 5: Trim the tests for the removed surface**

Delete `backend/tests/test_risk_score_live_delta.py`. In `backend/tests/test_compliance_citation_linkage.py` remove the `live_state` import (20) and any assertion depending on it. Grep `backend/tests` for `can_read_venue_floor`, `live_state`, `/live`, `events/inject`, `events/stream` and delete/adjust the asserting cases.

- [ ] **Step 6: Verify the suite is green**

Run from `backend/`: `python -m pytest -q`
Expected: PASS (no collection errors from deleted imports). Then `grep -rn "live_state\|can_read_venue_floor" backend/app` → expect zero hits.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -F - <<'EOF'
chore(prune): remove live floor/occupancy subsystem

- delete live_state.py, api/v1/operations.py, can_read_venue_floor gate
- drop dead live_state_manager param from scoring/pricing
- remove web/mobile live-telemetry consumers + regen client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Remove the 4 nightlife operational connectors

**Files:**
- Modify/Delete: `backend/app/ingestion/connectors.py` (delete the 4 classes `PosConnector` 32-71, `IdScanConnector` 74-116, `StaffingConnector` 119-155, `NycOpenDataConnector` 158-212 — delete the file if nothing remains), `backend/app/ingestion/registry.py` (remove the imports 9-14, `SOURCES` 18, `_OPERATIONAL` 21-25, `build_connector` 28-35), `backend/app/ingestion/runner.py` (remove `run`/`run_one` operational-pull, 30-66), `backend/app/main.py` (remove the `_ingest_tick` block 360-384 and the ingestion-history seed 342-358)
- Test: delete `backend/tests/test_ingestion_connectors.py`; in `backend/tests/test_ingestion_runner.py` delete the `run("all")` source assertions (53-63). KEEP `test_ingestion_push_api.py`, `test_ingestion_spine.py`, and verify `test_operational_scoring.py`/`test_ingestion_rollup.py`/`test_ingestion_quality.py`/`test_ingestion_models.py` don't import `connectors` (adjust if they do).

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no `connectors.py`, no `registry.build_connector`, no operational-pull `runner.run`. The push path (`api/v1/ingestion.py` → `webhook.py` → `base.py`) is untouched and still importable.

- [ ] **Step 1: Remove the connector classes and their registration**

Delete the 4 classes in `backend/app/ingestion/connectors.py` (and the file if it is now empty). In `backend/app/ingestion/registry.py` remove the 4 imports and the `SOURCES`/`_OPERATIONAL`/`build_connector` definitions. In `backend/app/ingestion/runner.py` remove the operational-pull `run`/`run_one`. NOTE: `connectors.py:27,29` import `app.prospects` and `nyc_market_lib` — those go away with the file, unblocking Task 3's deletion of those modules.

- [ ] **Step 2: Remove the boot wiring in main.py**

In `backend/app/main.py` delete the `_ingest_tick` background loop (360-384, the `INGEST_TICK_SECONDS` opt-in) and the ingestion-history seed call (342-358, `_seed_ingest` via `runner.run`).

- [ ] **Step 3: Trim the tests**

Delete `backend/tests/test_ingestion_connectors.py`. In `backend/tests/test_ingestion_runner.py` remove `test_run_all_executes_every_registered_source` and the `run("all")` assertions (53-63). Grep `backend/tests` for `PosConnector|IdScanConnector|StaffingConnector|NycOpenDataConnector|build_connector` and remove remaining references.

- [ ] **Step 4: Verify green**

Run from `backend/`: `python -m pytest -q` → PASS. `grep -rn "PosConnector\|build_connector" backend/app` → zero hits. Confirm the push path still imports: `python -c "import app.api.v1.ingestion"`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -F - <<'EOF'
chore(prune): remove nightlife operational connectors

- delete Pos/IdScan/Staffing/NycOpenData connectors + registry/runner pull
- remove _ingest_tick loop and ingestion-history seed from boot
- keep ingestion push path + spine intact

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Remove the NYC market map + prospects

**Files:**
- Delete: `backend/scripts/build_nyc_market.py`, `backend/scripts/seed_prospects.py`, `backend/scripts/nyc_market_lib.py`, `backend/app/prospects.py`, `backend/app/data/nyc_market.json`, `frontend/public/nyc_market.json`, `frontend/src/app/market/page.tsx`, `frontend/src/app/market/MarketBrokerView.tsx`, `frontend/src/app/market/MarketMap.tsx`, `frontend/src/lib/market.ts`, `frontend/src/lib/market.test.ts`, `mobile/src/screens/MarketScreen.tsx`
- Modify: `backend/app/api/v1/venues.py` (remove the `?source=prospect` portfolio branch — lines 116-118 and 350-410, esp. the `source` filter at 372), `backend/app/main.py` (remove the prospect seed call 337-338), `frontend/src/components/layout/MobileMoreSheet.tsx` (remove the `/market` nav entry, line 56), `mobile/src/navigation/MoreStack.tsx` (remove MarketScreen registration, 16 & 61), `mobile/src/screens/MoreScreen.tsx` (remove `Market` route, 28), `mobile/src/screens/NewSubmissionScreen.tsx` (remove the market drill-in handoff, 58), `frontend/src/app/submissions/new/page.tsx` and `frontend/src/app/risk-profile/[venueId]/page.tsx` (remove prospect-seeded entry points if present)
- Test: delete `backend/tests/test_build_nyc_market.py`, `backend/tests/test_prospects.py`, `frontend/e2e/prospects.spec.ts`; update `backend/tests/test_portfolio.py` (drop the `?source=prospect` cases).

**Interfaces:**
- Consumes: Task 2 (the connector that imported `prospects`/`nyc_market_lib` is gone, so those modules now have no backend importer).
- Produces: no `/market` UI, no `prospect-*` Venue rows, no `?source=prospect` portfolio filter, no `app.prospects`/`nyc_market_lib` modules.

- [ ] **Step 1: Remove the web + mobile market UI and nav**

Delete the listed `frontend/src/app/market/*` and `frontend/src/lib/market.ts(+test)` files and `mobile/src/screens/MarketScreen.tsx`. Remove the nav entries: `MobileMoreSheet.tsx:56`, `mobile MoreStack.tsx:16,61`, `MoreScreen.tsx:28`. In `mobile NewSubmissionScreen.tsx:58` and the two web entry points, remove the market→submission prospect handoff (leave a plain "new submission" entry).

- [ ] **Step 2: Remove the backend prospect/market modules and the portfolio branch**

Delete `backend/app/prospects.py`, `backend/scripts/seed_prospects.py`, `backend/scripts/build_nyc_market.py`, `backend/scripts/nyc_market_lib.py`, `backend/app/data/nyc_market.json`, `frontend/public/nyc_market.json`. In `backend/app/api/v1/venues.py` remove the `?source=prospect` branch (116-118, 350-410, filter at 372) — the portfolio endpoint now returns on-book accounts only. In `backend/app/main.py` remove the prospect seed call (337-338).

- [ ] **Step 3: Trim the tests**

Delete `backend/tests/test_build_nyc_market.py`, `backend/tests/test_prospects.py`, `frontend/e2e/prospects.spec.ts`. In `backend/tests/test_portfolio.py` remove the prospect-source cases. Grep `backend/tests` for `prospect-\|nyc_market\|market_venue_to_venue_data` and remove remaining references.

- [ ] **Step 4: Verify green**

Run from `backend/`: `python -m pytest -q` → PASS. `grep -rn "prospect-\|nyc_market\|app.prospects" backend/app backend/scripts` → zero hits (excluding historical docs).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -F - <<'EOF'
chore(prune): remove NYC nightlife market map + prospects

- delete market UI (web+mobile), prospects.py, nyc_market scripts + data
- drop ?source=prospect portfolio branch and prospect seed
- portfolio now returns on-book accounts only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Wipe data and prune nightlife seeds

**Files:**
- Delete: `backend/scripts/seed_prospects.py` (already gone in Task 3 — skip if absent), `scripts/seed_demo_data.py` (repo-root), `backend/scripts/seed_renewal_demo.py`, `backend/scripts/seed_demo_placements.py`, `backend/scripts/seed_verify_exclusion.py`
- Modify: `backend/app/seed_data.py` (empty the nightlife `VENUES` dict to `{}` and remove `elsewhere-brooklyn` infrastructure/compliance fixtures — keep the module + `VENUES` symbol so importers don't break), `backend/app/main.py` (remove any remaining boot calls to the deleted seeds; keep `seed_users`/`seed_carriers`/`seed_demo_users`), CLAUDE.md "Demo data" section (delete the removed seed commands — leave only surviving ones)
- Test: `backend/tests/test_seed_broker_platform.py` (drop cases for deleted seeds; keep carrier/user seed coverage). Grep tests for `elsewhere-brooklyn` and replace fixtures with a neutral id `demo-account` where a tenant id is needed.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `app.seed_data.VENUES == {}`; app boots with only carriers + demo users seeded; no `elsewhere-brooklyn` anywhere in code; local DB wipe procedure documented. (The NEW commercial seed is Phase 7, not here.)

- [ ] **Step 1: Empty the nightlife venue book**

In `backend/app/seed_data.py` set `VENUES = {}` and delete the `elsewhere-brooklyn` (and any sibling) venue definitions, infrastructure, and compliance fixtures. Keep the module and the `VENUES` name exported (the runner/db-backfill/operations/venues importers must still resolve it).

- [ ] **Step 2: Delete the nightlife seed scripts and their wiring**

Delete `scripts/seed_demo_data.py`, `backend/scripts/seed_renewal_demo.py`, `backend/scripts/seed_demo_placements.py`, `backend/scripts/seed_verify_exclusion.py`. In `backend/app/main.py` remove any remaining boot invocations of these. KEEP `backend/scripts/seed_demo_users.py`, `backend/app/seed_users.py`, `backend/app/seed_carriers.py`. Update the CLAUDE.md "Demo data" section to drop the deleted commands.

- [ ] **Step 3: Replace `elsewhere-brooklyn` test fixtures**

Grep `backend/tests` for `elsewhere-brooklyn`; where a test needs a tenant/account id, substitute a neutral literal `demo-account` (Phase 7 will introduce the real seed). Drop tests that exclusively assert nightlife seed content.

- [ ] **Step 4: Document + perform the local DB wipe**

Local reset: stop the server, delete `backend/database.db` (the default SQLite file), restart — the lifespan re-creates the schema (additive `_COLUMN_MIGRATIONS`, no edits needed) and re-seeds carriers/users only. For Neon/Postgres prod, the reset is a table truncate on the remote `DATABASE_URL` (do NOT run against prod until Phase 8 sign-off).

- [ ] **Step 5: Verify green on a clean DB**

From `backend/`: `rm -f database.db && python -m pytest -q` → PASS. `grep -rn "elsewhere-brooklyn" backend frontend mobile scripts` → zero hits (docs/openapi excluded; openapi regenerates). Boot check: `python -c "import app.main"` → OK.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -F - <<'EOF'
chore(reset): wipe demo data, prune nightlife seeds

- empty VENUES, delete elsewhere-brooklyn + nightlife seed scripts
- keep carriers/users seeds; document local DB wipe
- replace elsewhere-brooklyn test fixtures with neutral demo-account

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Phase-2 clean-DB verification gate

**Files:** none (verification + push only).

**Interfaces:** Consumes Tasks 1-4. Produces a green, pushed `main` at the end of Phase 2.

- [ ] **Step 1: Full backend suite on a fresh database**

From `backend/`: `rm -f database.db && python -m pytest -q`. Expected: all green, no collection errors. (If a Postgres lane is configured, run it too — it is the real gate per the shared-DB false-green note.)

- [ ] **Step 2: Frontend typecheck + e2e**

From `frontend/`: run the project's typecheck/build and the e2e suite (minus the deleted `prospects.spec.ts`). Expected: green; no references to deleted `/market` or `/live` routes.

- [ ] **Step 3: Boot + health smoke**

Start the backend; hit `/health`. Expected: 200, app boots with empty data (no nightlife seed).

- [ ] **Step 4: Push Phase 2 to main**

```bash
git push
```

---

## Self-Review

**Spec coverage (spec §5 prune list, §7 data reset):** live floor/occupancy → Task 1 ✓; 4 connectors → Task 2 ✓; NYC market map + prospects + `/market`→Book-of-Business (Book-of-Business view itself is branding Phase 6; here we only remove the nightlife map) ✓; nightlife loss-event fields → deferred to Phase 3/5 (vocabulary/taxonomy), not a Phase-2 prune target ✓; data wipe + `elsewhere-brooklyn` removal + DB reset → Task 4 ✓; keep loss-run/spine/carriers/users → enforced in Global Constraints ✓; clean-DB gate → Task 5 ✓.

**Placeholder scan:** no TBD/TODO; every deletion has exact file+line targets from the verified surface map; the two genuine rewrites (drop `live_state_manager` param; inline `MAX_AUTO_GENERATED_COMPLIANCE_ITEMS = 10`) show the actual change.

**Type consistency:** the produced `get_risk_score`/`get_premium_quote` signatures in Task 1's Interfaces match the param-drop in Step 1; `VENUES` stays exported (Task 4) so Task 1-3 importers remain valid.

**Open verification (carry into execution):** confirm no caller outside `operations.py` still passes `live_state_manager` (grep after Task 1 Step 2); confirm `test_operational_scoring.py`/`test_ingestion_rollup.py` don't import `connectors` before trusting them green in Task 2.
