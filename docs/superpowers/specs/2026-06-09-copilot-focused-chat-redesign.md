# Copilot — focused-chat layout redesign

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation plan
**Scope:** Frontend layout only — `frontend/src/app/copilot/*` + the `.copilot*` block in `styles.css`. No backend, no behavior, no theme/color change.

## Goal

Reframe the operator `/copilot` page from a contained "log-box below a tall header" into a **focused chat** that reads like a modern AI assistant: one centered conversation column, minimal chrome, composer pinned to the bottom. The current page wastes vertical space on a large `PageHeader` and horizontal space around a narrow log, and the heavy black-bordered bubbles feel like documents, not a conversation.

Chosen from three directions (A focused chat / B two-pane cockpit / C command surface). **A approved.**

## What changes (layout only)

1. **Header → slim eyebrow.** Drop the tall `PageHeader` ("Operator / Copilot / subtitle"). Replace with a slim inline eyebrow (small `OPERATOR · Copilot` label). The descriptive line ("Grounded answers… every reply cites its sources… any action waits for your confirmation") **moves into the empty state**, where it's read once at the start of a conversation rather than permanently occupying the top.

2. **Centered single column.** The conversation lives in one centered column, **max-width ~720px** (narrower than today's 880px page), so lines are comfortable to read and the chat fills the space instead of floating in a wide void.

3. **Full-height flex, sticky composer.** The panel becomes a flex column that fills the available viewport height. The transcript (`.copilot__log`) is the flex-growing, scrolling region; the composer is **pinned to the bottom**, full column width, rounded — always reachable as the log scrolls. Replaces today's fixed `max-height: 58vh` bordered scroll-box with composer-below.

4. **Lighter bubbles.**
   - **User** messages: a soft dark rounded bubble on the **right** (asymmetric radius, e.g. `12px 12px 4px 12px`). Remove the `.lc-card` heavy border.
   - **Assistant** answers: **borderless, plain text on the left** — no card, no heavy border. The link ("View … →") and the source chip(s) sit directly under the text.
   - This removes `.lc-card` from both bubble variants in `CopilotPanel.tsx`.

5. **Empty state = centered hero.** Sparkle + greeting + the descriptive promise line + the 4 suggestion chips, vertically centered in the column, with the composer already pinned below. (Today the empty state is fine but sits inside the bordered box; here it owns the open canvas.)

## What stays exactly the same

- **All behavior:** grounding/citations, confirm-gated `ProposalAffordance` (incl. required file attachment), followup chips, `aria-live` on the latest assistant turn, the "Thinking…" pending indicator, error alert, smooth scroll-to-newest.
- **Source chips are kept** (the "every reply cites its sources" promise) — not simplified to the link alone. *(User decision, 2026-06-09.)*
- **Theme + fonts:** cream/lime palette, type system, `--accent-ink` text rule — untouched. This is layout, not a recolor.
- **Backend, copilot tools, eval gate** — untouched.
- **Mobile:** collapses to the same single column (it already is one). There is **no mobile Copilot screen**, so no parity work. *(User decision, 2026-06-09.)*

## Files touched

| File | Change |
|---|---|
| `frontend/src/app/copilot/page.tsx` | Remove `PageHeader`; render a slim eyebrow header. Move the descriptive subtitle string into the empty state (pass to panel or inline in the empty block). Keep the auth/role guard + `theme-venue` wrapper. |
| `frontend/src/components/copilot/CopilotPanel.tsx` | Empty-state hero gains the promise line. Remove `lc-card`/`lc-card__inner` from user + assistant bubbles (use the new `.copilot-bubble*` styling). No logic/state changes. |
| `frontend/src/app/styles.css` | Rework the `.copilot*` block (~7046–7294): `.copilot-page`/`.copilot` become a full-height flex column ~720px; `.copilot__log` flex-grows + scrolls (drop the border/`max-height`/fixed surface box); user bubble = dark rounded fill, assistant bubble = borderless; composer sticky at bottom. |

## States to verify (all preserved, restyled)

Empty (hero + chips + composer) · user turn · assistant answer (text + link + source chip) · `propose_action` (confirm/dismiss) · compliance proposal (file attach) · followup chips · pending "Thinking…" · error alert · long transcript scrolls under a fixed composer.

## Accessibility

- Keep `aria-live="polite"` on the newest assistant turn and the pending indicator.
- Keep the composer `<label>` (visually it may be the placeholder, but the label stays for SR).
- Honor `prefers-reduced-motion` (already guarded for the pending dots; keep for any new transition).
- Maintain ≥44px touch targets on send/suggestion/followup/proposal buttons (already in CSS; preserve).
- Contrast: user bubble text on the dark fill must meet AA (use the existing dark-surface token, not a new hex).

## Verification

- `cd frontend && npx tsc --noEmit` clean; `npm run lint` clean.
- Grep `frontend/e2e/` for any copilot selector pinned to `lc-card`/old copy before pushing (per the e2e-selector-drift rule).
- Manual: run the app, open `/copilot` as the operator demo user, walk every state above; confirm the composer stays pinned while the log scrolls and the conversation centers at ~720px.
- Implementation uses the **ui-ux-pro-max** skill for the visual pass (spacing, bubble states, hierarchy), per project convention.

## Out of scope

- Directions B (context rail) and C (command surface).
- Any copy/wording change beyond relocating the existing subtitle.
- Multi-tool / LLM-gating / 429 work (tracked separately in backlog Track 11).
