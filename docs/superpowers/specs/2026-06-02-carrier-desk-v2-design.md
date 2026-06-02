# Carrier Desk v2 — enriched decision, structured terms, request-info

**Status:** approved (brainstorm 2026-06-02) · **Track:** 9 (carrier persona), Phase 1.5
**Predecessor:** carrier Phase 1 UI (`586339f`) — queue + quote/decline + audit provenance.

---

## 1. Problem

Phase 1 shipped a carrier "underwriting desk", but a gap review (2026-06-02) found it models
underwriting as *"quote-or-decline a submission the broker already priced."* Real underwriting —
and the 2026 E&S market — is much more. Two concrete shortfalls drive this spec:

- **The decision is blind.** The form shows only tier + score + a suggested price. An underwriter
  can't responsibly price without the loss history, exposure, incident record, and compliance
  posture — all of which already exist per-venue but aren't surfaced at the decision point.
- **A "decision" isn't a quote.** The carrier can only set one blended total or decline. A real
  quote carries terms & conditions — limits, deductibles, **subjectivities**, exclusions,
  endorsements, expiry — and the workflow includes asking the broker for missing information.

Market context (2026, grounds the priorities): E&S rates are softening and capacity is more
selective on **terms and conditions** — so the lever is terms, not just price. Casualty/liability
is the strained line, with **social inflation / nuclear verdicts** concentrated in
hospitality premises + **assault & battery** + liquor liability — exactly Nightline's book — making
loss-driven pricing and security/inspection **subjectivities** the place a nightlife carrier wins
or loses. (Sources in the gap-analysis thread: AM Best E&S outlook; Insurance Journal Jan 2026;
Send/InsureTech 2026 underwriting trends.)

## 2. Scope

**In scope (this spec):**
1. Decision-dossier endpoint (aggregate existing signals).
2. Full structured terms on a quote.
3. Request-info loop (carrier ⇄ broker).
4. "B" decision-page layout (decision-hero + KPI band + accordion dossier), web + mobile.
5. Scoped design pass (richer queue rows, back-home fix, queue-derived desk KPI strip).

**Out of scope (deferred to their own specs):**
- **C5 carrier portfolio / book** (written/earned premium underwritten, loss ratio vs target, hit
  ratio, mix) — next spec. The real loss-ratio/hit-ratio KPIs and the fuller carrier nav/mobile-tabs
  ride with it.
- **C4 renewal underwriting** — next spec (engine exists; needs surfacing).
- Generated **AI underwriting memo** (gated Worker + eval scorer) — strong follow-on, Track-8-shaped.
- Formal **refer-to-senior / authority limits** (C8), appetite/eligibility/clearance (C6), decline
  taxonomy + quote history (C7), bind/own-paper (C10, Phase 2/3), compliance/inspections/reinsurance
  (C11–C13).
- No refactor of the broker's older `/underwriter` page (unrelated; carrier-internal consistency only).

## 3. Design

### 3.1 Decision-dossier endpoint (Approach B — backend composes)

`GET /api/underwriting/quotes/{qid}` — carrier-gated (`require_carrier`). Composes everything
server-side so web + mobile each make **one** call; each section is **failure-isolated** (degrade to
`null`/empty, never 500), mirroring `get_review_context` and the Phase-1 `_suggested_breakdown`
discipline. Reuses shipped services: `get_risk_score` (factors), `loss_run` service, incident +
`ComplianceSignal` reads, `build_quote_for_carrier` (suggested premium).

```jsonc
{
  "quote":      { "id", "status", "premium_breakdown", "coverage_terms", "decline_reason", "underwriter_name" },
  "submission": { "id", "venue_id", "effective_date", "coverage_lines", "requested_limits", "status" },
  "venue":      { "id", "name", "venue_type" },
  "risk":       { "tier", "total_score", "factors": { "<name>": { "score", "weight", "explanation" } } },
  "loss_run":   { "claims_count", "total_reserves", "total_paid", "by_line": [ ... ] } /* | null */,
  "incidents":  { "open_count", "recent": [ ... ] },
  "compliance": { "status", "open_items": [ ... ] },
  "suggested_premium_breakdown": { ... },          // engine, same shape as the queue
  "decidable":  true                               // status ∈ awaiting → render the decision form
}
```

The queue payload stays lean (no dossier per row). This endpoint also **replaces the Phase-1
"fetch the whole queue and find the qid" hack** in the decision page → real deep-linking.

Money everywhere remains **strings** (broker-platform JSON convention); coerce at the read boundary.

### 3.2 Structured terms (`CarrierQuote.coverage_terms`)

Stored in the existing `coverage_terms` JSON column. Shape + a `validate_coverage_terms(...)` helper:

```jsonc
{
  "lines":          { "<lineId>": { "limit": "1000000", "deductible": "2500", "sublimit": "100000" /* |null */ } },
  "subjectivities": [ { "text": "Proof of licensed security staffing", "status": "open" } ],  // open|met|waived
  "exclusions":     [ "Assault & battery sublimit applies", ... ],   // free-text labels
  "endorsements":   [ "<endorsement label>", ... ],                  // free-text labels in v1 (curated catalog is a later nice-to-have)
  "schedule_mods":  [ { "category": "Loss experience", "kind": "debit", "pct": "10" } ],  // credit|debit
  "valid_until":    "2026-07-15"
}
```

**Pricing source of truth:** `schedule_mods` are **documentation / justification** of the
underwriter's price in this spec — they do **not** drive the premium. The premium **total stays the
editable figure** that proportionally rescales the line premiums (the Phase-1 `rescaleBreakdownToTotal`
behavior, kept) so `premium_breakdown` still passes the backend sum-check. Schedule-rating math that
*computes* the premium is a future pricing-engine enhancement, explicitly out of scope.

Validation rules: known `status`/`kind` enums; `pct` numeric ≥ 0; `valid_until` ISO date ≥ today;
line ids ⊆ submission `coverage_lines`. A malformed terms object is a 422 (typed error → router
maps), never persisted.

### 3.3 Request-info loop

Add status **`info_requested`** to `CarrierQuote` plus fields `info_request_note`,
`info_response_note`, `info_requested_by`, `info_requested_at`. Wire the new state into the quote
lifecycle in `app/lifecycles.py` and route every transition through the existing
`_transition_*` / `assert_valid_transition` + `_add_audit_event` machinery
(`event_type="carrier_quote.info_requested"`, `decision_source="carrier_desk"`).

Transitions:
- `requested | pending → info_requested` — carrier asks (note required).
- `info_requested → pending` — broker answers (`info_response_note`), re-queues for decision.
- `info_requested → quoted | declined` — carrier decides anyway / withdraws the request.

Endpoints:
- `POST /api/quotes/{qid}/request-info` (carrier) `{ note }`.
- `POST /api/quotes/{qid}/info-response` (broker, `require_broker`) `{ note }` → re-queue.

**Cross-persona surface (broker):** on the broker submission detail, a quote in `info_requested`
renders the carrier's question + a "respond & re-queue" box — same shape as the operator-response
control already in `/underwriter/[id]`. Minimal; closes the loop.

### 3.4 UI — "B" layout (decision-hero), web + mobile

Decision page (`/underwriting/[qid]` web; `UnderwriteDecisionScreen` mobile), driven by the dossier
endpoint. Single layout for both platforms (B was chosen partly because it collapses cleanly to
mobile). Top-down:

1. **Header** — back ("‹ Desk"), `CARRIER · UNDERWRITING DECISION`, venue name, coverage + effective.
2. **KPI band** — tier badge + score · open incidents · compliance open-count · (loss-run headline
   if present). Tier uses the heat ramp; color is never the only signal (label + value).
3. **Suggested premium** card (per-line breakdown, tabular figures).
4. **Structured terms** form — per-line limit/deductible/sublimit (prefilled from requested),
   subjectivities (add/remove rows, status chip), exclusions, endorsements, schedule-mods, valid-until.
5. **Actions** — single primary **Quote at $X** (editable total, rescales lines); **Decline** (reason);
   **Request info** (note). One primary CTA; destructive/secondary subordinate.
6. **Dossier accordions** — Risk factors · Loss run · Incidents · Compliance (collapsed by default).

Visual build runs through `ui-ux-pro-max` at implementation (matches the `lc-*` system: tabular
money, accessible tier color, error-below-field, loading/disabled states).

### 3.5 Design pass (scoped)

- **Richer queue rows** (web + mobile): age-in-queue, requested limits, status chip (so
  `info_requested` is visible in the list).
- **Back-home fix**: for the carrier, AppShell "Back to home" → `/underwriting` (no
  `/dashboard`→bounce); decision page keeps a single back. Removes the double-affordance.
- **Desk KPI strip** (queue-derived only): awaiting-decision · info-requested · oldest-in-queue.
  Loss-ratio/hit-ratio KPIs wait for the C5 portfolio spec.
- Nav/mobile-tabs stay lean (Desk is the only carrier destination until portfolio/renewals exist),
  but structured so adding Book + Renewals later is a one-line change. No nav items that go nowhere.

## 4. Testing

TDD, RED→GREEN; full backend suite (1089) stays green; evals `--compare-baseline` unaffected.

- **Dossier endpoint**: composes all sections; carrier-gated (403 broker/operator, 401 anon);
  failure-isolated (unknown venue / missing loss-run → `null` sections, no 500); `decidable` by status.
- **Structured terms**: `validate_coverage_terms` (shape, enums, date, pct, line-id subset); persists
  on the quote; `premium_breakdown` sum-check unchanged.
- **Request-info lifecycle**: valid/invalid transitions via `assert_valid_transition`; audit event
  emitted; broker response re-queues to `pending`.
- **Frontend/mobile**: `tsc` clean both; reuse existing unit/E2E patterns (light per project norms).

## 5. Build sequence (for the plan)

1. Backend: `info_requested` lifecycle + request-info/info-response endpoints (TDD).
2. Backend: `validate_coverage_terms` + persist via the underwrite path (TDD).
3. Backend: dossier endpoint composing existing services (TDD).
4. Web: dossier-driven decision page (B layout) + structured-terms form + request-info action.
5. Web: broker info-response surface on submission detail; richer queue rows; back-home fix; desk KPI strip.
6. Mobile parity: decision screen (B), terms form, request-info; richer rows.
7. Verify: full suite green, tsc clean both, manual carrier+broker loop walkthrough.

## 6. Landmines (pre-noted)

- Neon `Column(JSON)` returns **strings** — coerce `coverage_terms` / `requested_limits` /
  `premium_breakdown` at the read boundary (the dossier composer is the single place to get this right).
- Column-level FK ordering on Postgres if any new columns FK (none expected; new fields are scalar).
- New `CarrierQuote` columns need a `_COLUMN_MIGRATIONS` allowlist entry in `database.py`
  (schema self-healing is an allowlist, not introspection).
- Lifecycle: every status mutation goes through a `_transition_*` helper + audit event — don't set
  `status` ad-hoc.
