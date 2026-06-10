# Web layout rules (design system)

The web app is a wide-screen surface, but content was rendering as a single narrow
column — wasting the right half and pushing actions below the fold. These are the
house rules so layout is decided **once** and applied consistently, not per page.

## Rules

1. **Constrain reading width, don't stretch fields.** Forms read best at a fixed
   column width (~460–560px). Never widen inputs to fill a 1900px screen — that
   hurts scannability and looks unprofessional.

2. **"Configure → confirm" action forms use the two-pane shell** (`.form-shell`):
   the form stays a single readable column on the left; the otherwise-empty right
   space carries a **live summary / preview** (`.form-summary`) so the broker
   confirms at a glance before submitting. Reference implementation:
   `frontend/src/app/policies/[pid]/endorse/page.tsx`.

3. **The next action is always reachable.** Placement by surface:
   - **Detail pages** → primary action in the header (right-most).
   - **Two-pane forms** → Cancel / primary at the **top of the right summary
     panel** (`.form-summary__actions`); the panel is sticky, so the action
     stays in view while the form is filled on the left. Summary sits below it.
   - **Single-column forms** (no right pane) → sticky bottom bar
     (`.endorse-actionbar`).
   Never below an unscrolled fold. One primary CTA per screen.

4. **Collapse what a pre-filled flow already decided.** Advanced/rarely-changed
   fields go behind a disclosure (e.g. premium/tax/description on the endorse
   form), so the common case is short.

5. **Responsive, mobile-first collapse.** Two-pane → single column at ≤900px (the
   summary becomes a context strip above). The native mobile app (`mobile/`) has
   its own screens; "mobile different" on web = these breakpoints.

6. **Format values for humans.** `$1,000,000` not `1000000`; "Workers' Comp" not
   `wc`. Use the shared label maps / formatters.

## Primitives (in `frontend/src/app/styles.css`)

- `.form-shell` — responsive two-column grid (`1fr | 300px`), collapses at 900px.
- `.form-summary` — sticky right panel; `.form-summary__row` (dt/dd) + `__note`.
- `.endorse-actionbar` — sticky-bottom action bar.
- `.policy-actions__group` / `--end` — additive vs destructive button grouping.

## Rollout checklist (apply the shell + sticky action + format rules)

- [x] `policies/[pid]/endorse` — reference (two-pane summary + policy context, action-rail, collapse, format)
- [x] `policies/[pid]/certificates/new` (Issue COI) — two-pane (certificate summary + policy context)
- [x] `policies/[pid]/claims/new` (FNOL) — two-pane (claim summary + policy context)
- [n/a] `policies/[pid]/renew` — retired; renewal is now one-click (creates the submission, lands there, Undo toast) — no form to lay out
- [x] `submissions/new` — two-pane (new-submission summary + prospect savings) + toast
- [n/a] `submissions/[sid]` — a workspace (summary strip + carrier picker + quote grid), not a
  "configure→confirm" form; the two-pane rule doesn't apply. Already passed the easy-or-more-work
  review (appetite-guided carriers, one-click pull quotes, save-before-submit).
- [ ] audit other single-column form pages against rules 1–6

**Action + return pattern (shipped on all three):** every mutating submit fires a
success toast and lands on a destination that matches the flow it started in
(endorse: dashboard if from a gap card, else policy; FNOL: the new claim; COI: the
policy where the cert appears).
