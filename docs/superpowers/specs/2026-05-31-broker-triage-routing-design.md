# Broker triage drivetrain — recommendation-gated routing + inbox + operator context screen

**Date:** 2026-05-31
**Status:** Design / approved (pending spec review)
**Scope:** Phase 1 = backend + web. Phase 2 = mobile parity.
**Related:** sits in front of the deferred `2026-05-31-incident-lifecycle-evidence-and-close-design.md`.

## Problem

The platform has the *brains* of an operator→broker claims flow but not the *wiring*.
When an operator logs an incident, the create flow already builds an
`UnderwritingPacket` and the `ClaimRecommendation` (`should_file`, probability,
payout range, premium impact, net expected value, confidence —
`app/claim_recommendation.py`). But:

1. **The recommendation is never surfaced.** It's computed on packet read and sits in
   the API response; no UI renders it, and there is no redirect to a screen that shows it.
2. **Nothing routes to the broker.** No `ClaimProposal` is created and no broker queue
   is populated — the broker would have to hunt through `/packets`. Proposals are
   created only by an explicit, manual operator action today.
3. **The recommendation is half-blind.** `venue_prior_claim_count` is hardcoded to `0`
   (`app/main.py`), so the "worth filing" math ignores the venue's real loss frequency.

This design wires the **front of the drivetrain**: compute-and-persist the
recommendation, gate routing on it, and surface it to both the operator (a context
screen on log) and the broker (an inbox queue). The back of the drivetrain — turning an
approved proposal into a carrier `Claim` (FNOL) — is explicitly deferred.

## Two-party framing

Operator (the venue, insured) and broker (ThirdSpaceRisk, acting for the venue) are
distinct roles with a real handoff; the single-developer demo collapses them but the
design targets the two-party reality. Routing/linking is **server-side**, so it is fixed
once and serves both personas and both platforms; only the UI surfaces are
persona/platform-specific.

## Decisions (locked)

- **Routing trigger — recommendation-gated hybrid.**
  - `should_file && confidence ≥ 0.70` → **auto-route**: create a `ClaimProposal` in
    `pending_broker_review` → broker inbox.
  - `0.40 ≤ confidence < 0.70` (borderline) → **no** proposal; operator is prompted to
    "send to broker" (reuses the existing manual propose path).
  - otherwise → stays a logged incident; recommendation still shown as context.
  - Thresholds are config, not magic constants (`CLAIM_ROUTE_AUTO_CONFIDENCE=0.70`,
    `CLAIM_ROUTE_BORDERLINE_FLOOR=0.40`, env-overridable via `app/config.py`).
- **Inbox = reuse `ClaimProposal` + its `pending_broker_review` state** (not a new
  entity / not a new `BrokerTask` kind). The proposal *is* the triage item.
- **Persist a recommendation snapshot** on the proposal at routing time, so the inbox
  shows the exact number that triggered routing (auditable, not recomputed).

## Backend

### 1. Make the recommendation real
- New helper `count_prior_claims(session, venue_id) -> int` (counts the venue's prior
  `Claim` rows, excluding `closed_dropped`).
- `app/main.py` packet read + the router (below) pass the real count instead of `0`.

### 2. Persist the snapshot
- New JSON column on `ClaimProposal`: `recommendation_snapshot` (the
  `ClaimRecommendation` serialized: `should_file`, `probability`, `net_expected_value_usd`,
  `expected_payout`, `confidence`, `reasons`, `rubric_version`). Nullable; relies on the
  existing per-engine schema self-healing (commit `a6b2a46`) — no manual migration.

### 3. Auto-router in the incident-create flow
- After the packet is built (`app/incident_flow.py`), compute the recommendation with the
  real prior-claim count and apply the gate:
  - auto-route → create a `ClaimProposal` (`pending_broker_review`) via the **same
    service the manual propose path uses**, with `proposed_by="auto-router"` and the
    snapshot attached; emit the standard audit event.
  - borderline / not-routed → create nothing.
- Idempotent: never create a second auto-routed proposal for the same packet.
- The recommendation payload (served with the packet) gains a server-computed
  `routing_status`: `auto_routed` | `borderline` | `not_routed`. The operator UI reads
  this directly rather than duplicating the thresholds — single source of truth for the
  gate. No extra persisted state is needed for borderline (it's derived each read).

### 4. Broker inbox endpoint
- Extend `GET /claim-proposals` with `?status=pending_broker_review` and
  `?sort=priority`, where priority = `confidence × median_payout` from the snapshot
  (highest first). Each row includes the snapshot summary. (Today the list returns all
  proposals, unsorted by value.)

## Frontend (web)

### 5. Post-submit redirect
- In `frontend/src/app/incidents/page.tsx` `handleSubmit`, after evidence upload
  completes, call the existing `openIncident(created.incident.id)` helper (line 154) so
  logging an incident lands the user on its detail screen instead of the list.

### 6. Incident detail becomes the operator "context screen"
- `frontend/src/app/incidents/[id]/page.tsx` adds, above the existing evidence/packet
  sections:
  - **Claim-recommendation card** — file / don't-file, net EV, confidence, top reasons
    (from the packet's `claim_recommendation`). When `routing_status == "borderline"`, a
    **"Send to broker"** action that creates the proposal via the existing propose
    endpoint; when `auto_routed`, show that it's already with the broker (+ proposal state).
  - **Venue risk-profile snapshot** — score/tier from `/venues/{id}/risk-score`, plus a
    link to the venue's recent incidents — so the operator sees this incident in the
    context of the venue's standing.

### 7. Broker inbox view
- A queue surface (extends the existing broker decisions hub, or a dedicated
  `/claim-proposals` inbox page) listing `pending_broker_review` proposals, prioritized,
  each showing the recommendation summary and linking to the incident/packet for the
  approve/reject/needs-info decision the broker flow already supports.

## Tests (TDD, backend-first)

- Routing: `should_file && conf ≥ 0.70` creates exactly one `pending_broker_review`
  proposal with a snapshot; borderline and not-routed create none; re-running the create
  flow does not create a duplicate.
- Prior-claims feed: the recommendation (and thus routing) changes when the venue has
  prior `Claim` rows vs none.
- Snapshot matches the recommendation computed at routing time.
- Inbox endpoint returns only `pending_broker_review`, sorted by priority, and includes
  the snapshot.

## Scope

- **Phase 1 (this spec):** backend (1–4) + web (5–7).
- **Phase 2:** mobile parity — operator context screen + broker inbox in `mobile/`
  (same API; RN UI only).

## Out of scope (deferred)

- **Approval → FNOL/`Claim` creation** (the back of the drivetrain) — its own spec.
- Claim-closure feedback loops (claim close → proposal/compliance state).
- Push/email notifications for new inbox items.
- Carrier-shopping at claim time (shopping stays a placement/renewal activity).
