# Carrier Claims Adjudication (carrier persona, Phase 2)

**Status:** approved (brainstorm 2026-06-02) · **Track:** 9 (carrier persona), Phase 2
**Predecessors:** carrier underwriting desk (Phase 1) + desk v2 (Phase 1.5, decision-first reframe).

---

## 1. Problem

A carrier has **two** core jobs: **underwrite** (price risk — built) and **adjudicate claims** (decide whether/what it owes on a loss — *missing*). Today every claim action is `require_broker`: the broker *relays* "the carrier set a reserve / made a payment." Nothing is carrier-**owned**, and there is no **coverage decision** (the adjuster's "do we owe?" determination) — only a `closed_denied` disposition at the very end. So the app can't actually *bear the risk*; it only records what some external carrier supposedly did. This spec gives the carrier an **adjuster desk that owns adjudication** on top of the existing claim machinery.

This is also the missing link in the through-line `underwrite → bear → adjudicate → loss experience → re-rate at renewal`: carrier-*owned* reserves/payments are the real incurred losses that future Book (C5) and Renewals re-rating (C4) consume.

## 2. Scope

**In:**
1. **Coverage decision** — an adjuster action recording `coverage_decision ∈ {covered, denied, reservation_of_rights}` + rationale; gates indemnity payment; `denied` closes the claim.
2. **Carrier-owned adjudication with provenance** — carrier-gated reserve/payment/close stamped `decision_source="carrier_desk"`; the broker relay path (`broker_relay`) is preserved unchanged.
3. **Adjuster queue + carrier Claims desk** (web + mobile); carrier nav gains a **Claims** destination.
4. **Operator visibility** — the insured sees the coverage outcome + rationale (esp. on denial).
5. **Lightweight reserve/severity hint (advisory)** — a deterministic reserve-*range* + severity-band
   suggestion shown next to the Set-reserve action, derived from data Nightline already owns (the
   venue's loss-run history for the coverage line + the linked incident's severity). Advisory only —
   never gates or auto-sets the reserve. A first taste of the claims-intelligence layer; the full
   version (trained reserve model + severity/litigation prediction + coverage-analysis assist + fraud
   flags) is a **follow-on spec**, not this one.

**Out (deferred):**
- Settlement-authority limits + escalation (claims analog of underwriting authority C8) — later refinement.
- Book / Renewals dashboards (C5/C4) — separate specs (the management layer above this).
- Reinsurance/bordereaux, own-paper issuance (Phase 3).
- No change to the broker's existing `/api/claims/*` routes or UI.

## 3. Design (Approach A — thread `decision_source` + a thin adjuster layer)

Reuses ALL existing claim machinery (`Claim`/`ClaimPayment`/`ReserveChange`, the 9-state lifecycle, `file_fnol`/`record_carrier_reserve`/`record_payment`/`close_claim`/`reopen_claim`, the `_transition_claim` audit helper, and the claim-detail UI). Mirrors the proven underwriting `decision_source` split.

### 3.1 Claim model additions

New nullable columns on `Claim` (+ `_COLUMN_MIGRATIONS` rows for table `claim`, all `TEXT`, Postgres-safe):
- `coverage_decision: Optional[str]` — `null | "covered" | "denied" | "reservation_of_rights"`
- `coverage_rationale: Optional[str]`
- `coverage_decided_by: Optional[str]`
- `coverage_decided_at: Optional[str]` — ISO string (not `datetime`; the migration adds a TEXT column, so a datetime would mismatch on Postgres — same choice as the quote `info_requested_at`).

### 3.2 `decision_source` threading (existing services)

`record_carrier_reserve`, `record_payment`, `close_claim` gain a `decision_source: str = "broker_relay"` param, stamped into each action's audit-event metadata (`claim.reserve_recorded` / `claim.payment_recorded` / the close event). **Default preserves existing broker behavior** — broker routes pass nothing. The adjuster layer passes `"carrier_desk"`.

### 3.3 Adjuster layer — `app/services/adjusting.py` (new, thin)

- `decide_coverage(session, claim_id, *, decision, rationale, adjuster_id) -> Claim`
  - Validates `decision` enum; `rationale` required (non-empty).
  - Auto-advances a `notified` claim into `under_investigation` (via `_transition_claim`: `notified→acknowledged→under_investigation`) so a coverage call is made from a legitimate state.
  - Sets `coverage_decision`/`coverage_rationale`/`coverage_decided_by`/`coverage_decided_at`; emits `claim.coverage_decided` audit (`carrier_desk`); re-hashes `snapshot_hash` (reuse the claim's hash routine).
  - `denied` → `close_claim(disposition="denied", decision_source="carrier_desk")` (no payment).
  - `covered` / `reservation_of_rights` → leaves the claim open for reserve/payment.
- `adjust_reserve(...)`, `approve_payment(...)`, `close_claim_as_carrier(...)` — thin wrappers calling the existing services with `decision_source="carrier_desk"`.
- **Payment gating lives here** (not in the core service): carrier **indemnity** requires `coverage_decision ∈ {covered, reservation_of_rights}` → else `ClaimsError`; carrier **expense** allowed regardless. (A `denied` claim is already `closed_denied`, which the core `record_payment` rejects.)
- `adjuster_queue(session) -> list[dict]` — open (non-closed) claims awaiting carrier action, enriched: claim_id, carrier_claim_number, venue_id/name, coverage_line, status, `coverage_decision`, current_reserve, total_paid. Reuses `list_claims(open_only=True)`.

### 3.4 API — `app/api/v1/adjusting.py` (new, all `require_carrier`)

- `GET  /api/adjusting/queue` → `adjuster_queue`.
- `GET  /api/adjusting/claims/{cid}` → claim dossier (reuses the existing claim-detail + payments + reserve-history **service** functions; carrier-gated).
- `POST /api/adjusting/claims/{cid}/decide-coverage` `{decision, rationale}`.
- `POST /api/adjusting/claims/{cid}/reserve` `{new_reserve, change_reason}`.
- `POST /api/adjusting/claims/{cid}/payment` `{amount, payment_type, paid_on, description}`.
- `POST /api/adjusting/claims/{cid}/close` `{disposition, final_indemnity?}`.

Error mapping: `ClaimsError → 400`, `InvalidTransitionError → 422` via `error_response`. The broker's `/api/claims/*` routes are untouched.

### 3.5a Reserve/severity hint (advisory, deterministic)

`reserve_hint(session, claim) -> dict | None` in `adjusting.py`:
- Pulls the venue's prior losses for this coverage line via `venue_loss_run(...)`'s
  `by_coverage_line` (mean/range of `incurred`), and the linked incident's severity (from the
  claim's `incident_id` / defense packet `risk_signals.severity` when present).
- Returns `{ "low": str, "high": str, "severity_band": "low|moderate|elevated|severe", "basis": str }`
  — e.g. `{low:"15000", high:"40000", severity_band:"elevated", basis:"3 prior A&B losses; injury observed"}`.
- **Failure-isolated**: no history / no incident → `None` (UI shows "no comparable history"); never raises.
- **Advisory only**: surfaced next to the Set-reserve action and in the adjuster dossier; it does NOT
  prefill, gate, or auto-set the reserve. Deterministic (no keys); an eval scorer can measure its
  calibration vs realized incurred later — the upgrade path to the full claims-intelligence spec.

### 3.5 Operator visibility

Include `coverage_decision` + `coverage_rationale` in the venue-scoped claim reads — `GET /api/venues/{id}/claims` (already `require_venue_access`) and the claim detail the operator can see. The operator claim tracker (web `OperatorClaimsTracker`; mobile operator tracker) renders a **coverage badge** (Covered / Denied / Reservation of rights — color + text) + the **rationale**, surfaced especially on denial so the insured learns *why*.

### 3.6 UI (web + mobile) — runs through `ui-ux-pro-max`

- **Nav:** carrier role gains **Claims** (`/adjusting`) alongside **Underwriting Desk** (`/underwriting`). Mobile `CarrierTabs` → 2 tabs (Desk · Claims).
- **Web carrier Claims desk** (dedicated surface, reuses `claim-tokens`, lifecycle strip, money tiles, ledgers):
  - `/adjusting` — adjuster queue: claim# · venue · coverage · status chip · **coverage chip** · reserve · paid.
  - `/adjusting/[cid]` — carrier claim detail, carrier-framed, calling `/api/adjusting/*`: a prominent **Decide coverage** action (hero when `coverage_decision` is null) then reserve / payment (indemnity coverage-gated) / close.
- Status + coverage chips follow **color-not-only** (label + tone). Money via `fmtMoney`/tabular. 44px targets. Decision-first hierarchy (lead with the act, not a form), consistent with the reframed underwriting desk.

## 4. Testing

TDD, RED→GREEN; full backend suite stays green (the `broker_relay` default is an explicit regression guard for existing broker-claims tests).
- `decide_coverage`: enum + rationale required; auto-advance `notified→under_investigation`; covered/RoR open, **denied → closed_denied**; audit `carrier_desk`.
- Payment gating (adjuster wrapper): indemnity blocked unless covered/RoR; expense allowed; broker relay `record_payment` still works with no coverage (regression).
- Provenance: carrier actions stamp `carrier_desk`; broker path stamps `broker_relay`.
- Adjuster queue + `/api/adjusting/*`: carrier-only (403 broker/operator, 401 anon); decide→reserve→pay→close round-trip; coverage gate → 400.
- Operator visibility: venue-scoped claim reads include the coverage fields; owner can read, non-owner can't.
- Reserve hint: `reserve_hint` returns a range + severity band from loss-run history; degrades to `None` with no history (no raise); advisory — never mutates reserve state.
- Migrations: new `claim` columns registered in `_COLUMN_MIGRATIONS`.
- Frontend/mobile: `tsc` clean both.

## 5. Build sequence (for the plan)

1. Backend: `Claim` coverage columns + `_COLUMN_MIGRATIONS` (TDD).
2. Backend: `decision_source` threaded through reserve/payment/close (default `broker_relay`) + audit metadata (TDD; regression-guard existing claims tests).
3. Backend: `app/services/adjusting.py` — `decide_coverage` (+ auto-advance + denial-closes), adjuster wrappers, indemnity gate, `adjuster_queue` (TDD).
4. Backend: `reserve_hint` (deterministic, from `venue_loss_run` + incident severity; failure-isolated) (TDD).
5. Backend: `app/api/v1/adjusting.py` carrier-gated routes (TDD) + include coverage fields in venue-scoped claim reads + `reserve_hint` in the adjuster dossier.
6. Web: carrier Claims nav item; `/adjusting` queue; `/adjusting/[cid]` detail (decide-coverage-first, with the advisory reserve hint next to Set-reserve); operator coverage badge/rationale in `OperatorClaimsTracker`.
7. Mobile: `CarrierTabs` Claims tab; adjuster queue + detail screens (incl. the advisory reserve hint); operator coverage badge/rationale.
8. Verify: full suite green, tsc clean both, manual loop (FNOL → carrier adjudicates coverage→reserve→pay→close → operator sees outcome).

## 6. Landmines (pre-noted)
- New `claim` columns need `_COLUMN_MIGRATIONS` allowlist rows or existing-table SELECTs fail "no such column" on Postgres.
- `coverage_decided_at` is an ISO **string** (TEXT column), not a datetime.
- Every status mutation goes through `_transition_claim` (never set `claim.status` ad-hoc); reuse the claim `snapshot_hash` routine on every money/status/coverage mutation.
- Neon `Column(JSON)` returns strings — not relevant to the scalar coverage fields, but coverage reads must coerce any JSON they touch at the read boundary.
- The coverage indemnity gate lives in the **adjuster wrapper**, NOT `record_payment`, to avoid regressing the broker relay path.
