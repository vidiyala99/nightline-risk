# Carrier Adjudication Desk — Persona, Reserve, and Polarity Fixes

**Date:** 2026-06-17
**Status:** Approved (design)
**Surface:** Carrier adjuster desk (`/adjusting/*`)

## Context

The carrier claims-adjudication surface conflates the underwriter and adjuster
functions under a single `carrier` role, gates the reserve behind the coverage
decision (contrary to FNOL practice and the backend's own flow), renders an
operator-side recommendation with carrier-wrong polarity, and silently drops
its actuarial signal on Postgres. This spec covers seven findings (F-1, F-2,
F-3, F-4, F-7, F-8, F-9) as one coherent change.

There is **no new role or demo login**. Nightline is a vertically-integrated
insurer — the single `carrier` persona (Sam Rivera, `underwriter@nightline.risk`)
legitimately performs both underwriting and adjudication. The fix is contextual,
not structural.

Roles confirmed in `app/auth.py` `DEMO_USERS`: `broker`, `venue_operator`,
`carrier`, `staff` (+ `admin`, no demo account).

## Findings and resolutions

### F-1 — Contextual persona label (frontend, trivial)
The carrier eyebrow is route-driven: `CARRIER · CLAIMS` on `/adjusting/*`,
`CARRIER · UNDERWRITING` on the underwriting desk. No stored sub-role — each
surface already knows which it is. One-line change to the `lc-eyebrow` on the
adjusting queue (`adjusting/page.tsx`) and detail (`adjusting/[cid]/page.tsx`).

### F-3 — Ungate reserve at FNOL (frontend structure)
Remove the `inert` / `opacity:0.45` coverage gate around the action grid
(`page.tsx:1357–1366`) and the "record coverage to unlock" lock banner
(`page.tsx:1326–1355`). Reserve, close, and **expense/recovery** payments are
live from `notified`. **Only the indemnity payment-type stays disabled** until
coverage ∈ {covered, reservation_of_rights} — already enforced server-side
(`adjusting.py:126`) and mirrored in the UI via `indemnityGated`. The
coverage-determination card stays prominent but is reframed from "required
before adjudication" to a parallel action (heading + copy change only).

Backend already supports reserve-at-notice: `record_carrier_reserve` auto-hops
`notified → acknowledged → reserved` (`claims.py:247–258`); `CLAIM_TRANSITIONS`
permits it (`lifecycles.py:138–139`); `ACTION_PRIORITY` makes `record_reserve`
primary at `notified` (`claim-tokens.ts:152`).

### F-9 — Context-aware reserve adequacy (frontend, pure helper)
New adequacy cell in the hero KPI band. A pure function
`reserveAdequacy(reserve, incurred, hint)`. Branch on whether any money has been
paid, using the same sub-cent epsilon as `formatReserveDelta` (`incurred < 0.005`
counts as zero):
- **Incurred ≈ 0** (`incurred < 0.005`): compare reserve to the advisory band
  → "Below advisory" (danger) / "Within advisory" (neutral) / "Above advisory"
  (success). Uses `reserve_hint` low/high; prefers `chain_ladder_mean` as the
  midpoint when present.
- **Incurred ≥ 0.005**: delegate to `formatReserveDelta(reserve, incurred)` →
  headroom / gap.
- **No hint and incurred ≈ 0**: render nothing (no benchmark available).

### F-8 — Surface the chain-ladder mean (frontend types)
Add `chain_ladder_mean?: string` to the `ReserveHint` type (`adjusting.ts:24`).
The backend already returns it (`adjusting.py:181–194`, credible at ≥10 claims)
but the client type drops it. Render it in `ReserveHintBanner` as the
"chain-ladder estimate (IBNR-aware)" line; it also feeds F-9's midpoint.

### F-2 — Reframe recommendation for the carrier (frontend, display)
Same data object, carrier semantics, in the `incidentReport` block
(`page.tsx:1018–1048`):
- `Net EV` → **"Indemnity exposure (EV)"**.
- Invert color: higher exposure = warning/error, never green/success. (Drop the
  `netEvRaw >= 0 ? success : error` rule — exposure magnitude drives tone, not
  sign.)
- Keep paid-out probability; label it as the carrier's pay-likelihood.
- Memo relabeled **"Insured's defense posture"**.

### F-4 — Decouple deny from close (backend behavior + tests)
`decide_coverage(decision="denied")` stops auto-closing
(`adjusting.py:95–101`). It stamps the denial and advances
`notified → acknowledged → under_investigation` exactly like covered / RoR,
leaving the claim **open**. Closing remains the explicit
"Close claim → denied" action (`close_claim_as_carrier`, already present).
Matches real practice (a denied claim stays open through dispute/appeal) and the
lifecycle. The frontend "Denied" radio loses its silent-close side effect
automatically.

**Blast radius:** any test asserting `decide_coverage(denied)` closes the claim
must change. Audit `tests/test_adjusting.py` and `tests/test_adjusting_api.py`
and update expectations to "denial recorded, claim open at
`under_investigation`".

### F-7 — Fix the prod-only silent failure (backend, TDD)
In `_incident_report` (`adjusting.py:29–63`), coerce `risk_signals` / `memo`
(JSON dict) and `citation_ids` (JSON list) at the read boundary before
`.get()` / `len()`, so the AI panel survives Postgres' JSON-as-string
round-trip instead of being swallowed by the blanket `except: return None`.
Follow the `_as_list` / `_as_dict` coercion pattern from
`app/defense_package.py`. This is the regression class previously hit on Neon.

## Test plan

- **F-7** (red-first): unit test feeds a packet whose `risk_signals`/`memo` are
  JSON **strings** (Postgres shape) and asserts `_incident_report` returns a
  populated dict, not `None`.
- **F-4** (red-first): `decide_coverage(denied)` leaves status
  `under_investigation` and `coverage_decision == "denied"`; claim is not
  closed. Update existing deny-path assertions.
- **F-9 / F-2**: pure-function unit tests for `reserveAdequacy` (all branches)
  and the exposure-tone mapping.
- **F-1 / F-3 / F-8**: structural/display — verified by build + existing
  adjusting API tests staying green.
- Full backend suite green before push (`cd backend && python -m pytest -q`).

## Out of scope

- F-5 (`settling` reachability from this desk) — investigate separately.
- F-10 (future `date_of_loss` guard), F-11 (queue vs detail venue-name drift) —
  low priority.

## Conventions

Money stays `Decimal` server-side / strings in JSON. New display logic reads
from `claim-tokens.ts` formatters. No commit inside services. Do not break the
62 pricing characterization tests or the claim-status SoT.
