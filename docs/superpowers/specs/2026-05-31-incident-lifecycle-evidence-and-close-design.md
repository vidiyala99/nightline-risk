# Incident lifecycle — append evidence + structured close

**Date:** 2026-05-31
**Status:** Design / approved (pending spec review)
**Scope:** Phase 1 = backend + web. Phase 2 = mobile parity.

## Problem

The incident lifecycle has two gaps that surfaced during a live demo:

1. **No way to add evidence to an existing incident.** The detail page
   (`frontend/src/app/incidents/[id]/page.tsx`) only *reads* evidence; the report
   modal only uploads at creation. Evidence that arrives later (a photo tonight, a
   police report tomorrow) has no home — you must re-file the whole incident.
2. **Closing captures nothing.** `PATCH /incidents/{id}/status` takes only
   `{status}` and writes a bare `from/to` audit event. Closing an incident records
   no disposition, no notes, no corrective action — so the most important fact for a
   defense file (how and why it was resolved) is lost.

A third, related gap: the `IncidentRecord` model already defines structured slots
(`parties`, `witnesses`, `weapon_involved`, `injury_detail`,
`refused_service_or_overserved`, `security_response`, `incident_category`) but
**nothing populates them** — intake doesn't ask and the create flow doesn't extract
them. At report time the only structured signal is the free-text summary.

## Principle

**Immutable facts, append-only evidence, structured close.**

- Incident *facts* (summary, time, location) stay immutable — they feed snapshot
  hashes, the audit trail, and the defense package. Editing them would destroy the
  chain-of-custody value. Only **status** transitions and **appended** artifacts change.
- **Light intake, structured close.** Reporting happens in the moment (a bouncer on
  mobile at 1 AM) — keep it fast. Closing happens deliberately, after the fact — that
  is where heavy structured capture belongs.

## A. Append evidence (incident detail page)

**Backend.** No new endpoint — `POST /incidents/{id}/evidence`
(`app/api/v1/evidence.py:34`) already works on any existing incident (it only checks
existence + venue access + size). Add one guard: reject append when
`incident.status == "closed_archived"` (archived = sealed) with a `409` Conflict. All
other statuses (`open`, `under_review`, `closed`) permit append — late evidence is
legitimate.

**Frontend (`incidents/[id]/page.tsx`).** Add an "Add evidence" control reusing the
report form's dropzone styling. It POSTs with `authHeaders()` (per the
`project_web_upload_auth_pattern` fix), then refreshes the evidence list and
re-fetches `evidence-analysis` so the vision agent re-runs.

## B. Structured close (resolution record)

**Model — new nullable fields on `IncidentRecord`** (`app/models.py`), set once at
close. New columns rely on the existing per-engine schema self-healing/backfill
(commit `a6b2a46`); no manual migration:

| Field | Type | Notes |
|---|---|---|
| `resolution_disposition` | `Optional[str]` | validated against `INCIDENT_DISPOSITIONS` |
| `resolution_notes` | `Optional[str]` | required at close |
| `corrective_action` | `Optional[str]` | optional |
| `resolution_injury_outcome` | `Optional[str]` | validated against `INCIDENT_INJURY_OUTCOMES` |
| `follow_up_required` | `Optional[bool]` | default `False` |
| `resolved_at` | `Optional[datetime]` | set via `now_utc()` at close |
| `resolved_by` | `Optional[str]` | actor sub from auth |

**Allowed values** (new sets in `app/lifecycles.py`, next to `INCIDENT_TRANSITIONS`):

- `INCIDENT_DISPOSITIONS` = `resolved_no_action`, `resolved_corrective_action`,
  `referred_to_broker`, `unfounded`, `referred_to_authorities`
- `INCIDENT_INJURY_OUTCOMES` = `none`, `treated_on_site`, `refused_care`,
  `transported_to_hospital`, `unknown`

**New endpoint `POST /incidents/{id}/close`** (distinct from the generic
`PATCH /status`, which continues to handle `open ↔ under_review` and reopen):

- Request body:
  ```json
  {
    "disposition": "resolved_corrective_action",
    "resolution_notes": "Spill cleaned, wet-floor sign placed, patron declined care.",
    "corrective_action": "Added hourly wet-floor sweep at the service station.",
    "injury_outcome": "refused_care",
    "follow_up_required": false
  }
  ```
- **Validation (server-side, the integrity point):**
  - `disposition` required and in `INCIDENT_DISPOSITIONS` → else `400`.
  - `resolution_notes` required, non-empty → else `400`.
  - `injury_outcome`, if present, in `INCIDENT_INJURY_OUTCOMES` → else `400`.
- **Effect (atomic):** valid source states are `open` and `under_review` only;
  `assert_valid_transition(INCIDENT_TRANSITIONS, from, "closed")` enforces this (→ `422`
  on any other source, including an already-`closed` incident — correcting a resolution
  requires reopen-then-reclose). On success, write the resolution fields +
  `resolved_at`/`resolved_by`; emit `_add_audit_event` with
  `event_type="incident.closed"` and the resolution payload in `event_metadata`.
- Response: the updated incident (status `closed` + resolution fields).
- **Reopen** (`closed → open/under_review` via `PATCH /status`) retains the prior
  resolution fields as history; a later `/close` overwrites them. The audit trail
  shows both events.

**Defense package** (`app/defense_package.py`). When the incident is `closed` with a
resolution, render a **Resolution** section (disposition, notes, corrective action,
injury outcome, resolved_by/at) so the close becomes part of the defensible record.

**Frontend.** Intercept a change to `closed` on the detail page: instead of a direct
`PATCH /status`, open a "Close incident" modal (report-form styling) with disposition
(select), resolution notes (required textarea), corrective action (optional), injury
outcome (select), follow-up (checkbox). Submit → `POST /close`. Other transitions
(`under_review`, reopen) stay direct `PATCH /status` calls.

## C. Report form — conditional injury detail (lean)

**Frontend (`incidents/page.tsx`).** When "Injury observed" is checked, reveal a
single `injury_detail` text line (progressive disclosure); include it in the create
payload. No other intake change — parties/witnesses/weapon stay narrative-driven and
agent-inferred, or are confirmed at close.

**Backend.** Thread `injury_detail` through the create path so the existing model
field is persisted (today it is accepted nowhere).

## Testing (TDD, backend-first)

- `test_incident_close.py`: missing disposition → `400`; missing notes → `400`;
  invalid disposition/injury_outcome → `400`; close from `closed_archived` → `422`;
  happy path persists all resolution fields + `resolved_at`/`resolved_by` and emits
  one `incident.closed` audit event with resolution metadata.
- Evidence append: succeeds on an `open`/`under_review`/`closed` incident; rejected on
  `closed_archived`.
- Create flow persists `injury_detail` when supplied.
- Defense package renders the Resolution section for a closed incident.

## Scope

- **Phase 1 (this spec):** backend + web for A, B, C.
- **Phase 2:** mobile parity (`mobile/`) — add-evidence on the incident detail screen,
  close-with-resolution modal, conditional `injury_detail` on the report screen.
  Sequenced after Phase 1; mobile's `api.upload` already attaches auth.

## Out of scope

- Editing incident *facts* (intentionally — immutability is the point).
- Capturing parties/witnesses as structured lists at intake (agent-inferred for now).
- Real ticketing / external workflow on follow-up flags.
