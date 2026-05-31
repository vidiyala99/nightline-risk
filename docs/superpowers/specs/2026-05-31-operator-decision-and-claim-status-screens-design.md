# Operator decision + claim-status screens — split the incident hub

**Date:** 2026-05-31
**Status:** Design / approved (pending spec review)
**Scope:** Web, **operator persona only**. Broker incident view is unchanged.
**Builds on:** Plan 2 (the file-vs-pay decision card + claim-status stepper, currently inline on the incident detail) and the `GET /api/incidents/{id}/claim-status` endpoint.

## Problem

The operator incident-detail screen crams two distinct concerns inline: the **file-vs-pay decision** ("Worth filing?") and the **claim lifecycle tracker** (Reported→…→Resolved). These are questions an operator asks at *different times* ("should I file this?" vs "what happened to the one I filed?"). Inline, they make the incident screen heavy and bury each behind the other.

## Principle

The incident detail becomes a **lean hub**. The decision and the status each get a **dedicated, single-purpose screen**, reached by a compact entry on the hub. Decision (why file / pay) and status (what's happening to the filed claim) are separate destinations. This mirrors the calm, single-purpose direction the operator home already took.

Persona note: this is **operator-only**. The broker's incident view already links its recommendation to `/underwriter` (their decision surface) and has `/claims/[cid]` for status — left untouched.

## Architecture

Two new **nested, operator-facing routes** under the incident (venue-gated through the incident, deep-linkable, each with its own `layout.tsx` wrapping `AppShell` per the per-page-layout convention):

- `/incidents/[id]/decision` — the full file-vs-pay reasoning.
- `/incidents/[id]/claim-status` — the lifecycle tracker + claim detail.

**No new backend.** Both reuse existing, operator-visible data:
- Decision: the primary packet's `claim_recommendation` (already deductible-aware), via `GET /api/incidents/{id}/packets` (the hub already fetches this).
- Claim status: `GET /api/incidents/{id}/claim-status` (incident→proposal→claim chain) + the venue-claims read the hub already uses (`GET /api/venues/{venueId}/claims`) for carrier #/reserve detail.

The current inline "Worth filing?" two-path card and the inline stepper are **removed from the operator branch** of `frontend/src/app/incidents/[id]/page.tsx` and replaced by two compact entry links. The broker branch (recommendation + "Review proposal →") is unchanged.

## Visual spec (ui-ux-pro-max, paper/light v3)

Tokens/classes: `lc-shell, lc-hero, lc-eyebrow, lc-display, lc-sub, lc-card/lc-card__inner, lc-meta-cell, badge-success/warning/info`, `font-mono` for money, `var(--accent-ink)` for accent **text** (lime is a fill, never text), tier ramp for risk. 44px targets. Color-not-only everywhere.

### Incident hub — two compact entries (operator branch)
- **Decision summary** (`lc-card`, links → `/incidents/[id]/decision`, reuses the `.wq-row` hover/focus pattern, ≥44px, `aria-label="View filing decision"`): one row — verdict `badge` (success "Worth filing" / warning "Pay out of pocket") · `font-mono` net figure (`net +$7,911`) · chevron + "View decision".
- **Claim-status one-liner** (`lc-card` link → `/incidents/[id]/claim-status`): `Claim status: <current step> →`; pre-claim reads `Claim status: not filed →` (muted) — never a dead end.

### `/incidents/[id]/decision`
- "← Back to incident" link above the hero (back-navigation is High severity).
- `lc-hero`: eyebrow `OPERATOR · DECISION`, `lc-display` "File or pay out of pocket?", `lc-sub` one-line plain-English recommendation.
- Two-path comparison: `lc-card` ×2 in a flex row, `gap-md`, each `minWidth:240` → **stack on mobile**.
  - **File** panel: "Carrier covers ~$X" (`font-mono`), "your cost: $<deductible> deductible + $<cumulative premium> / 3 yrs", **net ±$<EV>** (bold, `font-mono`).
  - **Pay out of pocket** panel: "Absorb ~$<expected loss>", "no premium hike · no loss-run mark".
  - Recommended panel: `border: 1px solid var(--accent-ink)` + faint tint + a "Recommended" tag; the verdict badge reinforces it (color-not-only).
- **Reasons** list (`lc-card`, bulleted, `text-sm`, line-height ~1.6).
- **Venue-risk snapshot** strip: score/tier in the tier ramp, `font-mono`, with a link to recent incidents.
- **No-active-policy state** (`deductible == null`): render only the Pay panel + "No active policy — talk to your broker about coverage." (reuses the existing branch).
- Section rhythm: `mb-xl` between blocks.

### `/incidents/[id]/claim-status`
- "← Back to incident" link; `lc-hero` eyebrow `OPERATOR · CLAIM STATUS`, `lc-display` "Claim status", `lc-sub` summary.
- **Horizontal stepper** (`lc-card`): Reported → Sent to broker → Approved → Filed → Resolved. Lit = `●` + `accent-ink` text; unlit = `○` + `text-muted` (glyph makes it color-not-only). Wraps on mobile. The step booleans match the existing stepper logic:
  - Reported: always. Sent: `proposal.exists`. Approved: state ∈ {approved, filed_with_carrier, paid, denied}. Filed: state ∈ {filed_with_carrier, paid, denied} OR claim exists. Resolved: state ∈ {paid, denied} OR claim.status ∈ {closed_paid, closed_denied, closed_dropped}.
- **Branch tag** below the stepper: `rejected_by_broker` → "Declined by broker" (`state-error`) + AlertTriangle icon; `needs_more_info` → "Info requested" (`state-warning`) + Clock icon.
- **Claim-detail block** (`lc-card`, only once a claim exists): carrier claim # · coverage line · `font-mono` reserve · status badge.
- **Pre-claim empty state** (`lc-card`): "This incident hasn't been filed as a claim — it's a recommendation right now." + a link "View decision →" to `/incidents/[id]/decision`. No blank screen.
- **Loading**: skeleton card (mirror the `risk-profile/layout` skeleton), not a bare spinner (it fetches).

## Scope / phasing

One plan, web operator only:
1. Hub: collapse the operator inline decision card + stepper into the two compact entry links (keep broker branch intact).
2. New route `/incidents/[id]/decision` (+ `layout.tsx`).
3. New route `/incidents/[id]/claim-status` (+ `layout.tsx`).
4. e2e/verify: **grep `frontend/e2e/` for incident-detail selectors before pushing** (the renamed/removed inline blocks could pin a spec); run gates + prod e2e; confirm CI.

## Out of scope
- No backend changes (data already exists).
- No broker changes.
- Add/delete venues (separately deferred by the user).
- Mobile parity (Phase 4).

## Testing focus
- The two new routes render for an operator and are venue-gated through the incident (a non-owning operator gets the incident's 403/404, same as the detail page).
- Decision screen: priced two-path when an active policy exists; pay-only "no active policy" branch when not.
- Claim-status: correct lit steps for none/proposal-only/filed/closed; pre-claim empty state; branch tags for rejected/needs-info.
- Hub: compact entries link to the right routes; broker branch unchanged.
- tsc clean · design-lint 0 · CI e2e green.
