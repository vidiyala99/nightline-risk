# Persona-correct claim loop — close the operator↔broker↔claim loop

**Date:** 2026-05-31
**Status:** Design / approved (pending spec review)
**Scope:** Phase 1 = backend + web. Phase 2 = mobile parity.
**Builds on:** `2026-05-31-broker-triage-routing-design.md` (routing/inbox, shipped). Supersedes the paused `2026-05-31-incident-lifecycle-evidence-and-close-design.md` for the evidence-append slice.

## Problem

The operator→broker→claim loop is **open at the seam and persona-blurred**:

1. **Approval goes nowhere.** A broker can approve a claim proposal, but nothing creates the carrier `Claim` (FNOL). The proposal sits at `approved` forever; `services/claims.py::file_fnol` exists but is never reached from the approval flow.
2. **The operator's loop is write-only.** Operators log incidents but have **no screen** showing what happened next — proposal state, claim status. The `/claims` page is broker-only.
3. **Shared surfaces are persona-blurred.** The incident detail screen showed an operator-framed *"Sent to broker for review"* to brokers (fixed by hand 2026-05-31). The broker's *decide-on-a-claim* journey is smeared across four nav items (Incidents → Claim Proposals → Reports/`underwriter` → Claims) with two duplicate decision surfaces.

## Principle: persona-correctness

Every **shared** surface branches by persona. The **operator sees status** (where is my report?); the **broker sees actions** (what do I decide?). Neither is shown the other's framing. This is the spine of the whole design.

## A. Approval → FNOL (broker; pre-filled draft, broker confirms)

Reuses `services/claims.py::file_fnol(...)` (creates the `Claim`, takes `policy_id`, `coverage_line`, `date_of_loss`, `incident_id`, `proposal_id`). New work is *resolve → confirm → advance*.

- **`resolve_fnol_defaults(session, proposal) -> dict`** (new, `services/claims.py`): from the proposal's incident →
  - `policy_id`: the venue's active `Policy` (`status in {"active","bound"}`); none → `blockers=["no_active_policy"]`; multiple → newest, `notes=["multiple_policies"]`.
  - `coverage_line`: mapped from `risk_signal.type` via `RISK_TYPE_TO_COVERAGE` (`premises_liability→general_liability`, `liquor_liability→liquor_liability`, `altercation_event→general_liability`, `medical_emergency→general_liability`, default `general_liability`).
  - `date_of_loss`: `date` parsed from `incident.occurred_at`.
  - Returns `{policy_id, coverage_line, date_of_loss, blockers, notes}`.
- **`GET /claim-proposals/{id}/fnol-draft`** (broker): returns `resolve_fnol_defaults(...)` for the confirm form.
- **`POST /claim-proposals/{id}/file-fnol`** (broker): body `{policy_id, coverage_line, date_of_loss}` (confirmed/edited). Requires proposal state `approved` (else 422). Calls `file_fnol(... proposal_id=id, incident_id=...)`, then transitions the proposal `approved → filed_with_carrier` (via a new `_transition_proposal` path + audit event `claim.filed_with_carrier`). Returns the `Claim`. Refuses when `blockers` non-empty unless the broker supplied an explicit `policy_id` override.
- **Feedback loop:** in the claim-close service (`services/claims.py` close path), when the closing `Claim.proposal_id` is set, advance the proposal: `closed_paid → paid`, `closed_denied|closed_dropped → denied`. Emits the matching audit events. (`ClaimProposal` already declares `filed_with_carrier`, `paid`, `denied`.)
- **Broker UI:** on the broker decision surface (Part D), after **Approve**, reveal a **pre-filled "Confirm & file FNOL"** form (policy / coverage line / date of loss, editable). `blockers` disable confirm with the reason shown. Confirm → `Claim` created; the row moves to "filed".

## B. Operator status spine (operator)

- **`GET /incidents/{id}/claim-status`** (new, venue-gated): resolves incident → latest packet → latest `ClaimProposal` (state) → linked `Claim` (via `proposal_id`/`incident_id`) → claim status. Returns:
  ```json
  { "incident_status": "open",
    "proposal": { "exists": true, "state": "filed_with_carrier" },
    "claim":    { "exists": true, "status": "reserved" } }
  ```
  Operators see only their own venue's chain (no exposure of the broker `/claims` list).
- **UI — status timeline** on the incident detail (operator view): a horizontal stepper
  `Reported → Sent to broker → Under review → Approved → Filed → Reserved → Settling → Closed`,
  steps lit by the resolved state; rejected/needs-info render as a branch label. Answers "what happened to my report?"

## C. Operator evidence-append (operator)

- **Backend:** `POST /incidents/{id}/evidence` already works on any incident. Add a guard: `incident.status == "closed_archived"` → `409 Conflict`. All other statuses permit append (late evidence is legitimate).
- **UI:** an **"Add evidence"** control on the incident detail (operator view), reusing the report-form dropzone; posts with `authHeaders()`; on success refreshes the evidence list and re-fetches `evidence-analysis` (re-runs the vision agent).

## D. Broker triage pipeline + persona-correctness (broker)

Make the broker's claim journey read as **one pipeline: Inbox → Decide → Claims**, not four peer nav items.

- **D1 — one decision surface.** Two pages currently host `submitBrokerDecision` (`/underwriter/[id]` and `/claim-proposals/[packetId]`). Pick the **more complete of the two** as the canonical decision surface (compare during implementation — likely `/underwriter/[id]`, which carries the full packet/recommendation/citations); the other 301s/redirects to it. Removes the "where do I decide?" confusion. The FNOL-confirm form (Part A) lives here.
- **D2 — continuous links.** Inbox row → the canonical decision page → (on approve) FNOL confirm → the filed `Claim` is linked from the proposal and appears in `/claims`. Each stage links forward and back.
- **D3 — persona-correct shared surfaces.** Formalize the incident-detail branch already shipped: operator = status spine (B) + add-evidence (C) + send-to-broker; broker = recommendation + **"Review proposal →"**. Point that link at the **canonical decision surface chosen in D1** (the shipped fix currently targets `/underwriter/{id}` — update if D1 picks the other). Audit the other shared screens (compliance, venues) for stray cross-persona framing and fix any found.
- Heavy nav re-grouping / relabeling beyond D1 is **out of scope** (tracked, not built).

## Testing (TDD, backend-first)

- `resolve_fnol_defaults`: resolves policy/line/date; `no_active_policy` blocker when none; multi-policy note.
- `POST /file-fnol`: requires `approved` (422 otherwise); creates a `Claim` linked to proposal+incident; proposal → `filed_with_carrier`; emits audit event.
- Claim close → proposal terminal state (`paid`/`denied`) for a proposal-linked claim.
- `GET /claim-status`: correct chain for none/proposal-only/filed/closed; venue-gated (operator can't read another venue's).
- Evidence append: allowed on open/under_review/closed; `409` on `closed_archived`.

## Scope / phasing

- **Phase 1 (this spec):** backend (A, B, C, D1 redirect) + web (A confirm form, B timeline, C button, D2/D3).
- **Phase 2:** mobile parity — operator status spine + add-evidence; broker decision + FNOL confirm.

## Out of scope (tracked)

- Live carrier API / IVANS — `file_fnol` records the claim; the broker notifies the carrier out-of-band.
- Full nav re-architecture beyond consolidating the duplicate decision surface (D1).
- Operator-initiated claim filing — operators flag (send-to-broker); brokers file. By design.
