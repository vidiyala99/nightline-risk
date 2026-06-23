# Provenant — Commercial Insurance Platform Rebrand (Design)

**Date:** 2026-06-23
**Status:** Design — pending user review
**Owner:** Aakash (solo)

## 1. Objective

Convert the existing nightlife-venue insurance app ("Nightline") into **Provenant**, a
generic **commercial insurance** broker/MGA platform whose deep, defensible workflow is
**General Liability (GL)**. The north star is **legibility to an insurance-space viewer**:
someone in commercial insurance lands on it and immediately recognizes a real, coherent
Insured → Broker → Carrier workflow, and can click a single GL line end-to-end without
hitting anything that reads as "this is actually a nightlife app." It is a portfolio/pitch
artifact for the job hunt, not a product launch.

Three coupled operations: (1) wipe all existing data, (2) remove the `elsewhere-brooklyn`
demo tenant, (3) rebrand + prune nightlife machinery + **deepen the GL line** across
backend (FastAPI/SQLModel), web (Next.js), mobile (React Native), and the Claude memory store.

## 2. Personas (carry over, remapped)

| Today (nightlife) | Provenant (commercial) | Role |
|---|---|---|
| Operator (venue owner) | **Client / Insured** | the commercial business buying coverage |
| Broker | **Broker** | places & manages submissions, renewals, COIs, book of business |
| Carrier desk | **Carrier** | underwrites, rates, binds, adjudicates claims |

The standard commercial distribution chain. No persona is added or removed; only the
"Operator" label/vocabulary changes.

## 3. Scope decision (locked)

**Option (c): reskin + prune nightlife-only subsystems + deepen the GL line end-to-end.**
- (a) relabel everything, (b) remove nightlife-only subsystems, AND
- (c) make one line (**GL**) realistic enough to defend on substance under a 5-minute
  interviewer poke ("how is this premium calculated?").

The evidence/claims-defense engine is **kept and generalized** (Section 6), not pruned —
it is the platform's differentiator and GL liability is its textbook home.

## 4. Vocabulary & model remap

| Current | New | Notes |
|---|---|---|
| `Venue` | `Account` | the insured commercial business; primary entity |
| `tenant_id == venue_id` | `tenant_id == account_id` | tenancy coupling follows the rename |
| Operator persona | Client / Insured | persona label + copy only |
| `Incident` / incident taxonomy | `LossEvent` (GL taxonomy) | premises bodily injury / property damage / products-completed-ops / slip-and-fall |
| `ClaimProposal` | `ClaimProposal` (unchanged) | keep the ADR-0004 split; it's already generic ("internal recommendation a loss should be filed") |
| `Claim` | `Claim` (unchanged) | carrier-side reported GL loss with reserves/payments |
| `/api/venues` | `/api/accounts` | route rename; venue-scoped list views → account-scoped |
| Nightlife "tiers" (occupancy heat ramp) | `risk_tier` (low/med/high) on Account | reframed as an underwriting risk tier, decoupled from live occupancy |

Venue-uniqueness logic (normalized name+address in `create_venue`) carries over to
`create_account`. The `Venue→Account` rename is the highest-blast-radius change and is
covered by the existing test suite as its safety net.

## 5. Prune list (remove — nightlife-only, not generalizable)

- **Live floor/occupancy state** — `app/live_state.py` and the operator-only live-occupancy
  surfaces; the floor-data invariant (`can_read_venue_floor`) is removed, not generalized.
- **Operational connectors** — `app/ingestion/connectors.py`: remove `PosConnector`,
  `IdScanConnector`, `StaffingConnector`, `NycOpenDataConnector` and their feed wiring.
  **Keep** the loss-run ingestion path and the generic `run_connector` spine (retries,
  watermarks) since loss-run import depends on it; only the four nightlife connectors go.
- **NYC nightlife market map** — `/market` public static map, `app/data/nyc_market.json`,
  `frontend/public/nyc_market.json`, `backend/scripts/build_nyc_market.py`,
  `nyc_market_lib.py`, `seed_prospects` (286 prospects), and the `prospect-${id}` prefix path.
  **Replace** with a generic broker **"Book of Business"** view (the broker's own accounts +
  policies + open submissions), reusing existing list/table components.
- **Nightlife loss-event fields** — `weapon_involved`, `security_response`, and nightlife-
  specific `parties/witnesses` framing are generalized to GL loss-event fields
  (claimant, injury/damage type, premises-vs-operations, third-party indicator).

## 6. Deep GL workflow (the substance)

A single GL line made realistic end-to-end. Most of the spine exists
(`app/services/{submissions,policies,claims}.py`, `app/lifecycles.py`, COI/defense PDF,
loss-run import); the work is making it commercially credible, not building from scratch.

### 6.1 Submission (ACORD-style GL application)
Fields: named insured (Account) + FEIN, mailing/risk address, **ISO-style GL class code**,
**exposure base + amount** (per $1k payroll / per $1k gross receipts / per 1,000 sq-ft /
per unit), requested limits (per-occurrence, general aggregate, products-completed-ops
aggregate), and prior **loss history** (loss runs feed the experience modifier).

### 6.2 Rating (the defensible part — replaces `venue×tier×billing`)
A **pure, well-bounded rater module** (`app/underwriting/gl_rating.py`): inputs = rating
inputs; output = an **inspectable premium build-up** (line items). Model:

```
manual_premium = base_rate[class] × (exposure_amount ÷ exposure_unit)
quoted_premium = manual_premium × ILF[requested_limit]
               × experience_mod(loss_history) × schedule_mod(bounded)
total_premium  = quoted_premium + state_taxes_fees(state)
```

- Curated **class-code table** (~8–12 plausible small-commercial GL classes: retail,
  restaurant, office, light contractor, etc.) with base rate + exposure base type.
- **ILF** (increased-limit factor) table for common per-occurrence/aggregate limits.
- **Experience mod** from loss history (bounded), **schedule mod** judgmental (bounded).
- **State taxes/fees** via existing `app.money` Decimal helpers. Admitted GL spine; the
  existing surplus-lines module stays available for the E&S path but is not the GL default.

Credible, **not** the full ISO manual. The build-up is line-item inspectable so an
underwriter recognizes the math.

### 6.3 Quote → Bind → Issuance
Quote carries real coverage **terms**: per-occurrence limit, general aggregate,
products-completed-ops aggregate, deductible, and 2–3 standard endorsements (additional
insured, waiver of subrogation, primary & non-contributory). Bind → policy number →
**dec page / COI** (reuse existing PDF generation). Mid-term endorsement supported via the
existing endorsement path.

### 6.4 GL claim with evidence/defense (generalized engine)
The kept evidence engine, taxonomy swapped to GL: Insured reports a **loss event**
(premises BI/PD, products-completed-ops, slip-and-fall) → AI assembles a **loss/evidence
packet** (citations, audit trail, agents) → `ClaimProposal` (FNOL recommendation) routed to
broker → carrier `Claim` with reserves → payments → close → feeds the loss run that ties
back to the policy. Engine internals (`packet_core`, `agents/`, eval harness) are unchanged;
only the loss taxonomy and copy change.

## 7. Data reset

- **Wipe** Neon prod data + local `database.db`. New/renamed columns go through the
  schema self-healing allowlist (`_COLUMN_MIGRATIONS` in `database.py`) so existing-table
  SELECTs don't fail.
- **Delete** nightlife seed scripts (`seed_prospects`, `seed_defense_demo`, `dedupe_venues`,
  nightlife paths in `seed_demo_data`).
- **New idempotent seed**: `seed_demo_accounts` (≥3 Accounts), `seed_gl_placements`
  (submission → rated quote → ≥1 bound GL policy w/ dec page), `seed_gl_claim_demo`
  (loss event → evidence packet → ClaimProposal → carrier Claim w/ reserves/payment → loss run).
  Replaces `elsewhere-brooklyn` with a generic demo tenant (e.g. `demo-acme-co`).

## 8. Branding

- **Backend**: FastAPI title `"Nightline Risk OS"` → `"Provenant"`.
- **Web** (`frontend/src/app`): wordmark, landing copy, `styles.css` brand-language comment,
  remove nightlife framing; `/market` → Book of Business.
- **Mobile** (`mobile/src`): brand, rename nightlife screens (`VenueSetupScreen` →
  `AccountSetupScreen`, etc.), copy; prune nightlife-only screens; keep web/mobile parity.
- **Memory store**: rewrite positioning memories to commercial-general — `project_nightline_context`
  (retire the nightlife-hook guidance; reframe as commercial), `project_market_architecture`,
  `project_floor_data_and_tier_invariants` (prune/replace), `project_surplus_lines_pitch_artifact`,
  and the `project_clearform_pivot` cross-reference. (Renaming these `project_nightline_*` files
  to `project_provenant_*` is optional follow-up, not required for this pass.)

## 9. Conventions (must follow — from CLAUDE.md)

- **Money**: `Decimal` via `app.money`; `Numeric(12,2)` columns; JSON money as strings.
- **Timestamps**: `Field(default_factory=now_utc, sa_type=DateTimeUTC)`.
- **Lifecycles**: typed `Literal` + `TRANSITIONS`; every status change via
  `_transition_<entity>(... assert_valid_transition ...)`.
- **Audit events**: `_add_audit_event` with `event_type=f"{entity}.{to_state}"`.
- **Snapshot hashes**: SHA-256 of canonical JSON; **sort list contents** before hashing.
- **Atomic ops**: wrap multi-step mutations; commit owned by API/test layer, not services.
- **Error mapping**: typed service errors → `ClaimsError→400`, `InvalidTransitionError→422`.

## 10. Non-goals

- No new AI features this pass (rebrand + reset + GL deepening only).
- Do not alter eval-harness, loss-run-extraction, or agent-run-ledger **logic** beyond
  vocabulary renames.
- Do not rename the real-competitor mention in `docs/research/insurtech-ai-native-landscape.md`.
- Keep the `ClaimProposal` vs `Claim` vocabulary split (ADR-0004).
- Do not touch the historical `thirdspacerisk-production` Railway hostname literals.

## 11. Test strategy

- **Rewrite `test_phase_1.py`** (62 characterization cells) → GL rating characterization
  tests pinning every `(class × exposure base × requested limit × state)` cell. Keep the
  pin-every-cell discipline; write these **first** (TDD) before the rater.
- Update `Venue→Account`, `incident→loss event`, pricing/placement/claims tests to the new
  vocabulary; rename `frontend/e2e/venues.spec.ts` → accounts and update brand assertions.
- **Clean-DB gate**: full backend `pytest` on a **fresh** database (the shared `test_run.db`
  false-green is a known trap); the Postgres + clean-DB lane is the real gate.

## 12. Acceptance criteria

1. Grep shows **zero** `elsewhere-brooklyn`, **zero** "Nightline", and zero nightlife
   vocabulary (`venue` / `floor` / `occupancy` / `brawl` / `third space`) in code and
   user-facing copy — excluding explicitly whitelisted historical doc/hostname literals.
2. Full backend test suite green on a **clean** database; frontend/e2e green.
3. `python -m scripts.<new_seed>` produces a working GL demo end-to-end (Account →
   submission → rated quote with inspectable build-up → bound GL policy w/ dec page →
   GL claim with evidence packet → reserves/payment → loss run).
4. API exposes `/api/accounts` (not `/api/venues`); app boots; `/health` green; deploy succeeds.
5. The GL rater is a pure, isolated module with a line-item-inspectable premium build-up,
   and the new characterization tests pin every rating cell.

## 13. Sequencing (phases — each is its own plan/PR-equivalent commit)

1. Spec → implementation plan (writing-plans).
2. **Data reset + prune** (wipe data, delete nightlife seeds, remove operational/market layer).
3. **`Venue→Account` rename** across BE/FE/mobile/tests (tests as safety net).
4. **GL submission + rating + quote** deepening (TDD: characterization tests → rater → quote).
5. **GL claim + evidence** taxonomy reskin (engine unchanged).
6. **Branding** BE/FE/mobile + Book-of-Business view.
7. **New commercial seed**.
8. **Clean-DB verification** (backend pytest + e2e on fresh DB) → push to main.
9. **Memory update** to commercial-general positioning.

## 14. Risks

- **Rename blast radius** (`Venue→Account`): pervasive across BE/FE/mobile/tests; mitigated
  by doing it as one coordinated phase with the suite green before/after.
- **Rating rewrite** is the highest-substance, highest-risk change; isolate behind the
  `gl_rating` module interface and write characterization tests first.
- **Shared-test-DB false-green**: enforce the clean-DB gate before declaring done.
- **Scope creep into a full multi-line carrier**: GL only; other lines are explicitly out.
