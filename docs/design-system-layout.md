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

3. **The next action is always reachable.** Primary action lives in the header
   (detail pages) or a **sticky action bar** (long forms, `.endorse-actionbar`) —
   never below an unscrolled fold. One primary CTA per screen.

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

- [x] `policies/[pid]/endorse` — reference (two-pane summary, sticky bar, collapse, format)
- [ ] `policies/[pid]/renew` — confirm screen → two-pane (renewal YoY summary on the right)
- [ ] `policies/[pid]/certificates/new` (Issue COI) — two-pane + sticky action
- [ ] `policies/[pid]/claims/new` (FNOL) — two-pane + sticky action
- [ ] `submissions/new` + `submissions/[sid]` edit-terms — apply form-shell where it's a single column today
- [ ] audit other single-column form pages against rules 1–6
