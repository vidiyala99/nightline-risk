# Per-persona IA — distinct homes, navigation, and the broker Work Queue

**Date:** 2026-05-31
**Status:** Design / approved (pending spec review)
**Scope:** Web-first. Mobile parity is a later phase.
**Builds on / supersedes:** Extends Part D of `2026-05-31-persona-correct-claim-loop-design.md`. That spec deliberately deferred "heavy nav re-grouping / full nav re-architecture" as out of scope; this spec takes that deferred work and makes it the deliverable. D1 (collapse the duplicate decision surface) and D3 (persona-correct shared screens) are absorbed here and elaborated.

## Problem

The persona spec fixed the *seam* (operator→broker→claim loop) but left the *information architecture* untouched. Three IA problems remain:

1. **The broker's decision journey is scattered across four nav items** — Incidents → Claim Proposals → Reports (`/underwriter`) → Claims — with two duplicate decision pages (`/underwriter/[id]` and `/claim-proposals/[packetId]`). There is no single "what needs me now" surface.
2. **Neither persona has a real home.** Both land on a thin `/dashboard` ("The Book" for brokers, a sparse dashboard for operators). After logging an incident the operator has no obvious "what happened to my report?" screen.
3. **One shared, role-filtered sidebar serves both personas** (`AppShell.tsx`), so the navigation is a lowest-common-denominator list rather than a workflow tailored to each role.

## Principle: persona-correctness, taken to the navigation

The persona spec's spine holds and extends to the whole IA: **the operator sees status and their own actions; the broker sees decisions across the book.** Neither is shown the other's framing. We now also give each persona a **distinct navigation and home screen**, not a filtered view of one shared list.

## A. Broker home — triage strip over The Book

The landing answers "what needs me now?" first, then "how is my book?" — a thin **action strip** above the existing **Book** content.

- **Action strip ("⚡ Needs you now · N"):** grouped counts + the single top item per group, each a link into the relevant surface:
  - *Proposals to decide* — count of `ClaimProposal` in `pending_broker_review` (+ `needs_more_info` returned); top item by Work-Queue priority (§C).
  - *Renewals expiring* — policies within the renewal window; top by soonest expiry.
  - *Open requests* — `PolicyRequest` in an open state; top by oldest.
- **The Book (unchanged in spirit):** premium, active policies, loss ratio, venue count, venue map / tier heat, tier mix. This is today's `/dashboard` broker content, preserved.
- **Data:** reuse existing endpoints — the prioritized proposals list (`/api/claim-proposals?status=pending_broker_review&sort=priority`), the renewals list, the policy-requests list, and whatever the current Book dashboard already queries. The strip is an aggregation of counts the broker can already see; no new domain data.

## B. Broker navigation — task-oriented spine

Replace the three vague groups (Portfolio / Operations / Underwriting) with workflow-named clusters:

```
🏠 Home                       (triage strip + Book)
— Claims pipeline —
  📥 Work Queue               (canonical decision surface — §C)
  📂 Claims                   (filed claims, reserves, payments)
— Placement —
  Submissions → Policies → Renewals
— Book —
  Venues · Requests
(header / utility, not primary nav)
  Ingestion · Alerts
```

- **Work Queue** absorbs two of today's decision items: the **Claim Proposals** inbox and the underwriter **Reports** decision page. The **Incidents** *screen* persists as a shared browse surface (§F) — reachable by brokers via venue scoping / links — but is no longer a primary broker nav destination; the broker's decision entry point is the Work Queue.
- **Tasks** folds into the Work Queue / header utilities (it is not a distinct primary destination for the broker journey).
- **Alerts** and **Ingestion** move to a header/utility affordance, off the primary spine.

## C. Work Queue — the canonical decision surface

One page (`/work-queue`) is where the broker triages and decides. It replaces the duplicate decision pages; `/underwriter` and `/claim-proposals` **301/redirect** to it (Part D1). Clicking a row opens the existing decision controls (approve / reject / needs-info) and, on approve, the pre-filled FNOL-confirm form (Part A of the persona spec).

**Grouping — by state, in workflow order:** (proposal-centric — every row is a `ClaimProposal`, preserving the "operators flag, brokers file" invariant; the broker never originates a proposal here)
1. **To decide** — `pending_broker_review` proposals.
2. **Awaiting info** — proposals in `needs_more_info` (broker asked the operator) — oldest first.
3. **Ready to file** — `approved` proposals awaiting FNOL confirmation.

Borderline incidents (no proposal yet) are **not** in the queue — sending them is the operator's decision. Brokers browse all incidents on the shared Incidents screen (§F), not here.

**Default sort within "To decide" — value + urgency hybrid:**

```
base_value     = confidence × expected_payout_median        (today's _proposal_priority)
age_days       = now − proposed_at, in days
urgency_factor = 1 + 0.15 × max(0, age_days − 3)            (escalates only after ~3 days)
priority       = base_value × urgency_factor
```

Sort descending by `priority`. The constants (3-day grace, 0.15/day slope) are tunable and live next to the existing threshold env vars in `claim_routing.py`. Items with no recommendation snapshot sort last (as today). This guarantees a high-value item ranks first immediately, *and* an aging low-value item eventually surfaces rather than rotting.

- Extends the existing `_proposal_priority` in `app/api/v1/claim_proposals.py`; the urgency factor is the only new term. "Awaiting info" sorts by age ascending; "Ready to file" by approval time.

## D. Operator home — venue status + what's due

Single-venue by data model (`tenant_id == venue_id`). Same strip-over-body shape as the broker home, role-appropriate content:

- **Venue health header:** risk score / tier (`/api/venues/{id}/risk-score`), live occupancy (operator-only — gated by `can_read_venue_floor`, per the floor-data invariant), coverage summary (active policy line(s), deductible, renewal date).
- **"⚡ Needs you" strip:** compliance items due + incidents in `needs_more_info` (the broker asked for something).
- **"📋 Your reports" feed:** each incident with its lifecycle stepper (Reported → Sent to broker → Approved → Filed → Resolved), driven by the existing `GET /incidents/{id}/claim-status` chain. Directly answers "what happened to my report?"

## E. Operator navigation — slim, venue-centric

```
🏠 Home                       (venue status)
— My venue —
  Incidents · Compliance · Coverage · Live Terminal
(header / utility)
  Alerts
```

- No broker surfaces (Submissions / Policies / Claims / Work Queue / Renewals).
- "Venues" folds into Home (they are one venue); the venue profile is reachable from the home header.

## F. Shared screens — branch by persona

The screens both personas reach render per-persona content. Rule: **operator = status & my actions; broker = decisions across the book.**

| Screen | Operator sees | Broker sees |
|---|---|---|
| **Incidents** | own venue · status feed · add-evidence · send-to-broker | all accessible venues · sorted by decision urgency · row → Work Queue |
| **Incident detail** | file-vs-pay explainer · status timeline | recommendation · "Review proposal →" (to Work Queue / canonical surface) |
| **Compliance** | my to-dos, actionable | portfolio compliance, read/scope |
| **Alerts** | my venue's alerts | book-wide, grouped by venue |

This formalizes Part D3 and the already-shipped incident-detail persona branch.

## G. Non-functional requirements

- **Visually calm, low eye-strain.** The two dense screens (Work Queue, The Book) must stay uncluttered: generous whitespace, a single accent, quiet tier colors, clear hierarchy.
- **Build with `ui-ux-pro-max`.** Run it before/while implementing each screen's visual treatment.
- **Adhere to design-system v3 tokens:** paper/light theme, single tier heat-ramp (never lime accent for tiers), accent-ink for accent *text* (lime is a fill, not a text color), 44pt touch targets, the established type scale.
- **Per-page `layout.tsx` caveat:** new top-level pages (e.g. `/work-queue`) render bare without their own `layout.tsx` wrapping `AppShell`. Each new route needs its layout, verified in a rendered check (compiles clean otherwise).

## H. Scope / phasing

1. **Phase 1 — Broker:** task-oriented nav spine (B) + Work Queue page with grouping & value+urgency sort (C) + `/underwriter`,`/claim-proposals` redirects (D1) + broker home triage strip (A).
2. **Phase 2 — Operator:** slim nav (E) + operator home (D).
3. **Phase 3 — Shared-screen persona rules (F):** audit and branch Incidents / Compliance / Alerts; incident-detail already done.
4. **Phase 4 — Mobile parity:** mirror the homes and nav in `mobile/` (bottom-nav + MoreSheet already exist).

Each phase is independently shippable. The `AppShell.tsx` `NavLinks` change splits into two persona-specific structures (`brokerNav` / `operatorNav`) rather than one role-filtered list.

## I. Out of scope (tracked)

- **Multi-venue operators** — `tenant_id == venue_id`; an operator is one venue. A venue switcher / roll-up is a broker-style scoping feature, not built here.
- **Renaming/relocating screens beyond the nav regroup** — the underlying routes keep their paths (except the D1 decision-surface redirect); this is IA grouping + homes, not a URL migration.
- **New domain data** — the homes aggregate existing endpoints; no new persisted entities.
- **Broker-initiated proposals (Gap B)** — when a recommendation says "file" but no proposal exists (e.g. operator never sent, or legacy data), the broker still cannot originate one from the Work Queue. Routing creates proposals; this stays a separate, deliberate product decision, tracked.

## J. Testing focus (TDD where backend changes)

- **Work-Queue sort:** unit-test the value+urgency priority — a fresh high-value item outranks a fresh low-value one; a low-value item aged > 3 days eventually outranks a fresh low-value one; the 3-day grace means no boost before then; missing-snapshot sorts last.
- **Redirects:** `/underwriter` and `/claim-proposals` → `/work-queue` (and the `[id]`/`[packetId]` deep links to the canonical decision surface).
- **Nav role-split:** broker sees the broker spine and not operator-only items; operator sees the slim venue nav and no broker surfaces.
- **Persona-branch rendering** on shared screens: operator/broker each get their framing (extends the incident-detail pattern).
- **Homes:** the broker triage-strip counts match the underlying lists; the operator report feed reflects the `claim-status` chain.
