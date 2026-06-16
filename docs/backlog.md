# Engineering Backlog

Working checklist for the subscription-free work (no API keys, no S3/email/SMS
accounts yet). Gated/integration items live in [`go-live-readiness.md`](./go-live-readiness.md).

Last updated: 2026-06-15.

---

## Recently shipped (context for picking back up)

- [x] **Native-dialog remediation (Session 2026-06-15) — COMPLETE (Phases 1/2/3/4/0b).** All 18 `window.prompt`/`window.confirm`/`alert` sites across the broker/operator placement flows replaced with `PromptDialog` / `ConfirmDialog` / `toastError`. `src/app` is now **native-dialog-free** (verified `grep`); only `ActionModal:76`'s internal "Discard changes?" guard remains, intentionally deferred (replacing it would nest modal-in-modal — tracked as a small follow-up: inline "Discard / Keep editing" footer state). **PR #4 (Phase 3 + 0b):** the 3 optional-reason prompts (`policy-requests` decline, `compliance` waive ×2) → `PromptDialog` (optional textarea, blank→`undefined`/`null` per site); **Phase 0b** restyled `PromptDialog`'s internals to `ds/` (Input/Label/Button + token-matched textarea/select, explicit colors) — logic untouched so the `missingRequired` unit test stayed green (the proof). Gates across all PRs: design-lint 0/0, **vitest 71** (+13 over the sweep: ConfirmDialog 8, bindPolicyNumberArg 3, SUBMISSION_OUTCOME_CONFIG 2), ESLint 0 errors, `next build` ✓. New reusable primitive: `components/ui/ConfirmDialog.tsx` (ds/, on the ActionModal scaffold). Follow-up: `ActionModal` scaffold itself is still legacy-styled (claim-modal* CSS) — migrate in the end-of-sweep modal pass.
- [~] **Native-dialog remediation (Session 2026-06-15) — PR #1 of N SHIPPED.** Plan: [`docs/superpowers/plans/2026-06-15-native-dialog-remediation.md`](superpowers/plans/2026-06-15-native-dialog-remediation.md) (replace native `window.prompt`/`confirm`/`alert` across broker placement flows with `PromptDialog` / a new `ConfirmDialog` / `toastError`; 18 sites, 8 files, phased). **PR #1 (TDD):** new `ConfirmDialog` (`components/ui/ConfirmDialog.tsx`, first fully-`ds/` modal on the `ActionModal` scaffold; 8 RED→GREEN tests incl. the no-auto-close contract + `data-variant` destructive hook); `bindPolicyNumberArg` pure helper in `lib/policies.ts` (3 tests locking the blank→"assign later"/`undefined` contract); **bind flow migrated** (`submissions/[sid]/page.tsx` `handleBind` → `PromptDialog` + `toastError`, was the reported native-prompt pain); net-new `e2e/placement-bind.spec.ts` (tolerant-empty, non-mutating — the flow had ZERO coverage since native prompts aren't Playwright-drivable). Gates: design-lint 0/0, **vitest 69** (+11), ESLint 0 errors, `next build` ✓. **PR #2 (Phase 2 — decline/outcome reasons) SHIPPED:** detail `handleRecordResponse` decline → `PromptDialog` (REQUIRED reason) + its 3 `alert`s (quoted-record, decline-record, select) → `toastError`; list `handleOutcome` (lost/declined/withdrawn) → `PromptDialog` (REQUIRED reason) with a **data-driven dispatch** `SUBMISSION_OUTCOME_CONFIG` in `lib/placement.ts` (TDD'd, 2 tests — guards the three distinct APIs from swapping) + `alert` → `toastError`. Both `submissions/*` files now native-dialog-free. Gates: design-lint 0/0, **vitest 71**, ESLint 0 errors, `next build` ✓. **PR #3 (Phase 4 — confirm sites → `ConfirmDialog`) SHIPPED:** `coverage` withdraw (non-destructive), `incidents/[id]` delete-evidence (destructive, body copy), `policies/[pid]` expire (destructive) + reinstate (non-destructive) → `ConfirmDialog`; the 2 remaining `policies/[pid]` `alert`s (runPrompt, expire) → `toastError`. **`policies/[pid]` is now fully native-dialog-free** (the reference page is done). Gates: design-lint 0/0, **vitest 71**, ESLint 0 errors, `next build` ✓. **REMAINING:** only Phase 3 (optional-reason prompts: `policy-requests:77`, `compliance:148`, `compliance/[venueId]/[itemId]:130`) + Phase 0b (`PromptDialog` contents → `ds/`). `ActionModal:76` internal `window.confirm` deferred (would nest modals). Phases 1/2/4 done — bind, decline/outcome, and all confirms migrated.
- [x] **Session 2026-06-15** — **web design-system migration: "Paper & Ink" on shadcn/21st.dev (foundation + login shipped; sweep IN PROGRESS).** All gates green (design-lint, eslint, vitest, `next build`, **full Playwright E2E**). Commits `0a31d26` (foundation+login), `e48cf51`/`8f3bc36` (E2E selector fixes).
  - **What shipped:** Tailwind v4 + a shadcn-style `ds/` primitive set (`frontend/src/components/ds/`: button, card, badge, input, label, skeleton, tier-badge) + `cn()` (`src/lib/utils.ts`). The shadcn design tokens in `frontend/src/app/globals.css` are **re-themed to the v3 "Paper & Ink" identity** (warm paper `#F6F0E2`, ink `#17150F`, signature lime `#C8F000` CTA, ink-hairline borders, green→red tier ramp; Hanken body / Bricolage display / Caveat flourish). So every `ds/` primitive renders Paper & Ink automatically. The **login** (`src/app/login/page.tsx`) is the migrated reference (warm editorial split, lime CTA, Caveat flourish).
  - **★ The coexistence mechanism + the migration RULE (read before migrating any page):** legacy "Paper & Ink" CSS (`styles.css`/`mobile-native.css`) is imported into the `@layer legacy` cascade layer so the un-migrated pages render unchanged. BUT layer order is insufficient on its own: legacy has bare-element rules `h1,h2,h3 { color: ink }` / `p {…}` / `a {…}` that **match a migrated heading directly and beat an *inherited* Tailwind color** (matched-on-element > inherited, before specificity/layers). **Rule: every migrated page sets EXPLICIT color classes on its text elements — never rely on inherited color.** (A global `.lc-shell`-scoping fix was rejected: only 20/53 pages use `.lc-shell`.)
  - **★ Cascade-layer order FIX (Session 2026-06-15) — un-migrated pages were breaking.** The layer order was `@layer legacy, theme, base, components, utilities` → `legacy` sat BELOW Tailwind's `base` layer, so **preflight (Tailwind's reset) bled into every un-migrated page** and clobbered legacy's bare-element rules + global `* { margin:0 }`, breaking layouts (visible: the broker dashboard ticker / "needs you" strip overlapping). Reordered to `@layer theme, base, legacy, components, utilities, legacy-shim` — `legacy` now beats preflight (un-migrated pages restored to their pre-migration look) but still loses to `components`/`utilities`, so migrated pages (which win via utility classes, the highest layer) are unchanged. **At end-of-sweep, restore the simple order + delete the legacy imports + the `legacy-shim` layer.** This is why the explicit-class migration rule matters: it's what keeps migrated pages winning over the now-stronger legacy layer.
  - **★ Legacy utility-name COLLISION shim (Session 2026-06-15) — the real cause of "faint text" on un-migrated pages.** The legacy app hand-rolled `.text-secondary` / `.text-primary` / `.text-muted` (and `.text-tertiary`, which is safe — no `--color-tertiary`) class names that **Tailwind v4 now ALSO generates** from the ds tokens. The ds values nearly match the paper bg (`--secondary`/`--muted` = `#EFE7D3`) or are the lime accent (`--primary` = `#C8F000`), and utilities outrank `legacy`, so ~46 files rendered near-invisible / wrong-colour text (the washed-out risk-profile labels + summary). Fix: a `legacy-shim` layer ABOVE `utilities` (`globals.css`) restoring the legacy ink colours for those exact class names — migrated pages use the `-foreground` variants + `bg-primary`, so unaffected. **Watch for other legacy↔Tailwind class collisions** (`bg-surface` etc. are NOT Tailwind defaults so they're fine; the danger is any legacy hand-rolled utility whose name matches a ds-token-generated one). Also bumped legacy `--text-tertiary` (#8A8472→#6F6A58) + `--text-muted` (#B3AC97→#837D6B) for WCAG AA.
  - **E2E hooks:** migrated pages drop the legacy `.lc-*` classes that Playwright page-objects pinned to. Use **semantic role hooks** instead (login tabs got `role="tab"`/`role="tablist"`; error is form-scoped `[role="alert"]`). When migrating a page that has E2E selectors, update the page-object/spec to semantic roles (see `e2e/pages/LoginPage.ts`). The E2E suite hits the **deployed Vercel app**, with a warm-up that waits for redeploy.
  - [x] **`reset-password` migrated (Session 2026-06-15).** `src/app/reset-password/page.tsx` rebuilt to mirror login: editorial two-column paper split, `ds/` Input/Label/Button, lime CTA, manual `<Loader2>` spinner (ds Button has no `isLoading`), explicit colors on every text element, `← Back to sign in`. Dropped the old `@/components/ui/Input label=…` API. All gates green (design-lint 0/0, ESLint 0 errors, `next build`, Vitest 58/58). No E2E refs — no page-object change.
  - [x] **`my-reports` migrated (Session 2026-06-15) — FIRST in-shell page; sets the in-shell pattern.** `src/app/my-reports/page.tsx` (floor-staff, read-only, self-contained) rebuilt on `ds/` Card/Badge/Button. **In-shell pattern established:** reproduce `.lc-shell`'s `overflow-x: clip` scroll-jump fix in Tailwind (`relative min-h-screen overflow-x-clip`); drop the legacy `theme-venue` persona class (global ds tokens replace persona theming); incident-status → ds Badge `destructive`/`warning`/`success` 1:1; explicit colors on every text element. All gates green (design-lint 0/0, ESLint 0 errors, `next build`). No E2E refs.
  - [x] **Landing `/` migrated (Session 2026-06-15) — highest-visibility page (recruiters/founders land here first).** `src/app/page.tsx` rebuilt on `ds/` Card/Button to match login's editorial Paper & Ink: lime CTA, paper-grain bg, mono-lime section eyebrows (lime square + uppercase), readable Caveat "rebuilt" accent (replaced the old `0.6em` rotated `lc-display em`), `ds/` Card pillars + differentiator (lime left rule), demo persona grid as `ds/` outline Buttons, section dividers, explicit colors throughout. Also dropped the word "built" from copy (pillar-3 → "An AI-native carrier, end to end"; "made to beat") per [[feedback_building_not_built]]. Ran ui-ux-pro-max first. All gates green (design-lint 0/0, ESLint 0 errors — lone `<img>` advisory matches login, `next build` ○ static). No E2E refs.
  - [x] **`comms-review` migrated (Session 2026-06-15).** `src/app/comms-review/page.tsx` (low-confidence comms triage queue) rebuilt on `ds/` Card/Badge/Button via the my-reports in-shell pattern: ds Card per review item, confidence → ds Badge `warning`, action row with ONE primary lime Button (Confirm) + subordinate outline/ghost Buttons (correct/dismiss), Caveat hero accent, explicit colors. Also cleaned `catch (e: any)` → `e instanceof Error`. All gates green (design-lint 0/0, ESLint 0 errors, `next build` ○ static). No E2E refs.
  - [x] **`policies` migrated (Session 2026-06-15) — FIRST page off the shared legacy `PageHeader`/`StatusPill`.** `src/app/policies/page.tsx` (broker active-policy table) rebuilt on `ds/` Badge + a ds-tokened table. **Shared-component decision:** `PageHeader` (18 consumers) and `StatusPill` (14 consumers) are replaced **inline** — NOT migrated globally — so the still-legacy pages that import them stay visually intact; each page swaps to an inline ds header as it migrates, and the shared legacy components get deleted at end-of-sweep. `StatusPill` tone → ds Badge variant via a local `TONE_VARIANT` map (`neutral→muted`, `danger→destructive`, rest 1:1). Table kept as semantic `<table>` in an `overflow-x-auto` wrapper (accepted pattern for a wide desktop-primary data table) with the `data-testid="policies-table"` seam preserved. E2E-safe (renewals.spec's `.policies-empty` refs target `/renewals`, not this page). All gates green (design-lint 0/0, ESLint 0 errors — 1 pre-existing `set-state-in-effect` advisory, `next build` ○ static).
  - [x] **`tasks` migrated (Session 2026-06-15).** `src/app/tasks/page.tsx` (broker to-do feed) rebuilt on `ds/` Badge + inline ds header; `task-row` rebuilt as a clickable bordered card with an urgency-coloured left rail (`RAIL` map) + `URGENCY_TONE` → ds Badge via the shared `TONE_VARIANT` map; skeleton/empty/non-broker states restyled. **E2E:** `broker-surfaces.spec.ts:28` was pinned to `.page-header__title` (dropped with PageHeader) → updated to `getByRole("heading", { name: /Tasks/i })`. (Lines 35/43 still target the un-migrated policy-requests/claims `.page-header__title` — left intact.) All gates green (design-lint 0/0, ESLint 0 errors — 1 pre-existing `set-state-in-effect` advisory, `next build` ○ static).
  - [x] **`ingestion` migrated (Session 2026-06-15).** `src/app/ingestion/page.tsx` (broker connector run-history table) rebuilt on the `policies` table pattern: inline ds header, ds-tokened `overflow-x-auto` table (`data-testid="ingestion-runs-table"` kept), `STATUS_TONE` → ds Badge via shared `TONE_VARIANT`, rejected-reason chips restyled as muted bordered spans, skeleton/empty/non-broker states restyled. No E2E refs. All gates green (design-lint 0/0, ESLint 0 errors — 1 pre-existing `set-state-in-effect` advisory, `next build` ○ static).
  - [x] **`policies/[pid]` detail migrated (Session 2026-06-15) — largest sweep page so far (665 lines).** `src/app/policies/[pid]/page.tsx` rebuilt on `ds/` Button/Badge: inline ds header (status Badge + state-driven primary CTA), summary strip → 4 ds stat cells, snapshot-integrity `<details>` restyled, **Manage dropdown menu rebuilt in Tailwind** (relative trigger + absolute `bg-card` menu, kept the backdrop/`role=menu`/Escape + danger Cancel item), all 3 tables (endorsements/COIs/claims) → ds `overflow-x-auto` tables, COI status + claim rows preserved (shared `ClaimStatusPill` + `PromptDialog` kept). All logic identical (renew/assign/reinstate/cancel/expire/non-renew/lapse/COI-download). Gates green (design-lint 0/0, ESLint 0 errors — 2 pre-existing `set-state-in-effect` advisories, `next build` ✓). **Reason flagged:** clicking from the migrated list into this legacy detail read as "broken" — the jarring polished-list → rough-detail jump.
  - **[ ] PICK UP HERE — continue the sweep, simplest-first:**
    - [x] **`team` migrated (Session 2026-06-15).** Operator floor-team page (`src/app/team/page.tsx`): inline ds header (lime mono eyebrow + Caveat accent), add-staff form → ds Card + Input/Label/Button, invite/set-password-link panel + staff list → ds Cards + Badge; cleaned `catch (err: any)`. Gates: design-lint 0/0, ESLint 0 errors, `next build` ○ static. First migrated page to showcase the ds/ **form** primitives (Input/Label) on an in-shell surface.
    - **Sibling detail/sub pages of migrated lists are now priority** (avoid the polished-list → rough-detail jump): `policies/[pid]/endorse`, `policies/[pid]/certificates/new`, `policies/[pid]/claims/new`, `policies/[pid]/gaps`. Other candidates: `coverage` (~215), `surplus-lines` (~250), `policy-requests` (~225). **migrate the dashboard LAST** (`src/app/dashboard/page.tsx` is ~1,300 lines, dual-persona broker/operator, a phone variant `DashboardMobile`, ticker + triage console — its own focused session; the legacy AppShell sidebar migrates with it).
    - ~43 pages remain (redirect-only pages `claim-proposals`/`terminal`/`underwriter` need no migration). Reference: `login`/`reset-password` (standalone), `page.tsx` landing + `my-reports`/`comms-review`/`team` (in-shell; `team` = ds form pattern) + `policies`/`tasks`/`ingestion` (inline-header table) + `policies/[pid]` (detail: header + summary cells + dropdown + tables), `globals.css` (tokens), `ds/*` (primitives).
    - **End of sweep:** delete the two legacy `@import … layer(legacy)` lines + the legacy fonts (Hanken/Bricolage/Caveat are kept; the `Inter`/`Space_Mono` legacy-only vars can go) from `layout.tsx`, and remove `styles.css`/`mobile-native.css`.
- [x] **Session 2026-06-10 (cont. 2)** — **native RN app parity** (`mobile/`; `tsc` clean, verify via Expo — no URL preview):
  - **★ Copilot screen built in the RN app** (was *fully absent*) — `mobile/src/screens/CopilotScreen.tsx` + `api/copilot.ts` + `api/intelligence.ts`; grounded chat (composer, user/assistant bubbles, citation chips, tappable follow-ups, inline **Confirm** for non-attachment proposed actions). Wired **operator-only**: `OperatorMoreStack` entry (`MoreStack.tsx`) + a "Copilot" row in `MoreScreen` `OPERATOR_OVERFLOW` + an "ASK COPILOT" dashboard `QuickActionTile`. **v1 defers:** file-attachment confirm (compliance) + deep-link navigation from replies (web `href`s don't map to RN routes).
  - **"What needs your attention" exposure feed on the RN operator dashboard** (was absent as a unified feed) — `mobile/src/components/ExposureCard.tsx` (self-fetch `/api/intelligence/exposure`, severity filter chips, sorted critical→low, self-hides on empty/error), inserted after the stats row in `DashboardScreen`. Rows informational in v1 (deep-link is a follow-up).
  - **Broker bottom-nav "drift" = NON-ISSUE (verified).** The RN `TabNavigator` already uses the current broker set (Portfolio / Work Queue / Submissions / Claims / More); Incidents/Compliance are demoted to the More stack. The web comment claiming the RN still uses the old Incidents/Compliance set is **stale** — no fix needed. (The separate web `MobileBottomNav` 7c item is unrelated and untouched.)
- [x] **Session 2026-06-10 (continued)** — claim-engine correctness + web-mobile native parity (frontend; tsc + backend tests green, deployed to preview alias):
  - **★ Claim-status single-source-of-truth fix.** Two operator screens contradicted for the **same incident** — the decision screen showed "SENT TO BROKER FOR REVIEW" off the recomputed `routing_status` (a *prediction*), while claim-status correctly read persisted `proposal.exists`. Root cause: the proposal→status ladder was duplicated inline in **three** places and the decision screen's copy drifted. Extracted one canonical `frontend/src/lib/claimStatus.ts` `deriveClaimStatus()` whose **`sent` flag keys ONLY on persisted state** (`proposal.exists || claim.exists`), never `routing_status`; decision + claim-status now consume it (incident-detail already agreed via `proposal.exists || claim.exists` — left intact). Mirrors the RN app's existing shared `deriveClaimStatus`.
  - **Web-mobile native parity (phone browser).** The Next.js web app on a phone read as desktop-shrunk/boxy; aligned it to the RN "Paper & Ink" app: retuned `:root` **radius** (4→16) / **shadow** (hard-offset→soft) / **card border** (solid-black→hairline) tokens app-wide; added a scoped `frontend/src/app/mobile-native.css` `m-` layer + `components/mobile/DashboardMobile.tsx` (1:1 port of the RN operator DashboardScreen) behind an `isPhone` early-return (**desktop untouched**); **re-added the web-only "What needs your attention" exposure feed + Copilot access** to the phone dashboard, native-styled (both had been dropped when mirroring the older, feature-behind RN app) + added Copilot to the operator "More" sheet; fixed a **global mobile overflow root cause** (app-shell phone column `1fr`→`minmax(0,1fr)`) and **oversized page titles** (mobile `h1` cap + no-ellipsis full-wrap on the incident header).
  - **Market-pain → roadmap synthesis** (strategy artifact, not code) — sourced market research across all three personas re-confirmed the existing five-agent-audit *Recommended order* (security/storage P0s → online-AI rigor → intake) and the **"sell defensibility, not premium discounts"** reframe; no new tracks needed.
  - [x] **★ claim-routing / fraud-hold affordance — FIXED.** A genuine `auto_routed` **auto-creates** the proposal (`maybe_auto_route_incident` on incident-create `incident_flow.py:116` / packet-build `main.py:150` / boot backfill `main.py:185`), so the *only* `auto_routed`-but-unsent case is a **deliberate high fraud-tier hold** (fraud agent suppresses the auto-route) or a transient failure. (1) Decision screen: manual "Send to broker" **only for `borderline`**; `auto_routed`-unsent → an **actionable "Under review" card** — explains it's under review before reaching the broker, offers an **"Add evidence"** action, and honestly frames "we'll send it once it clears" (no bypass button, no dead end). (2) **Defense-in-depth backend gate** — `POST /api/packets/{packet_id}/claim-proposal` (`api/v1/claim_proposals.py`) now returns **409** when the packet carries a high fraud tier (JSON column coerced at the read boundary), so the hold can't be bypassed even by a crafted request; the operator `sendToBroker` surfaces the refusal via toast. (3) RED→GREEN route test `test_high_fraud_packet_manual_send_is_blocked` (52 claim-routes + fraud-gate tests green). (4) **Re-route-on-clear** — `_run_corroboration_and_update_packet` (`main.py`) now re-attempts auto-routing after the v2 fraud re-score: if added evidence genuinely de-escalates the hold (tier < `high`) and the recommendation still qualifies, the claim routes automatically (audit `claim.routed_after_review`) — so the held state **resolves** instead of sitting stuck until a server restart. Test `test_corroboration_clears_hold_and_routes`. Sibling of the §9 fraud agent.
- [x] **Session 2026-06-10** — correctness + UX hygiene + tooling (all pushed; suite 1331 green):
  - **`DateTimeUTC` TypeDecorator — killed every `datetime.utcnow` deprecation warning.** New
    column type stores naive-UTC, reads back tz-aware on both SQLite and Postgres (no DDL migration,
    no data rewrite); applied to all 42 datetime columns + the 6 direct call sites. TDD'd; CLAUDE.md
    timestamp convention updated.
  - **Incident detail page — three fixes** (operator surface): (a) **closed the silent
    evidence-upload gap** — pending spinner → `toastSuccess`/`toastError`, input reset; (b) **cleaner
    H1** — `incident_category` label or first-sentence of summary (no more mid-word `.slice(80)`),
    which surfaced that `incident_category` was being **silently dropped** end-to-end (fixed: persist
    on create + add to the `Incident` response schema + `_incident_to_response`); (c) **delete
    evidence** — `DELETE /api/evidence/{id}` with an anti-spoliation `evidence.deleted` audit event,
    cascade of dependent vision analyses, storage cleanup; per-row trash button + confirm. All TDD.
  - **Frontend ESLint — set up from scratch** (it was never installed; `eslint .` was linting build
    output → 5000+ junk errors). Added `eslint` + `eslint-config-next` native flat config, scoped to
    app source (ignores `.next`/`public`/generated `src/api/**`), calibrated for first adoption →
    `npm run lint` green (0 errors, 47 advisory warnings). Installing the toolchain is what surfaced
    the Next.js advisory below.
  - **Security — `next` 16.2.4 → 16.2.9.** Patched a high-severity advisory cluster (middleware/proxy
    bypass, RSC cache poisoning, image-opt/websocket DoS/SSRF); `npm audit` clean; prod build green.
- [x] **Session 2026-06-05** — fraud agent + UI polish:
  - **★ Fraud/SIU agent — SHIPPED** (the "fraud flags" slice of track 9's Claims intelligence).
    Deterministic two-point scoring: **v1 metadata gate at intake** (late reporting, prior-claim
    frequency, evidence thinness, severity contradiction) + **v2 re-score with corroboration
    evidence**. `FraudSignal` persisted (v1 signal + hold committed so they survive prod);
    elevated signal **overrides the auto-route gate**; `fraud.flagged` emission idempotent;
    deterministic eval baseline (`app/evals/fraud_scorer.py`, fixtures → expected tier, mirrors
    `comms_classifier_eval.py`); agent contract doc w/ runtime status. Full suite **1230 green**.
  - **Operator home + landing polish** (commit `fix(web)`): landing demo buttons get the lc-card
    conic-ring hover via new `.lc-demo` (focus-visible parity + reduced-motion guards, retrofitted
    onto `.lc-card` too); operator numerals now follow the documented type system (capacity hero =
    sans `lc-num-data`, money demoted to new `.lc-numeral--md` — 5 > 4 > 3.25rem ladder); "On The
    Floor" rebuilt as a full-width strip (`.op-floor-infra` chip row replaces the hollow two-column
    grid); Your Policy card fully clickable → `/coverage` (mirrors Risk Profile, no nested anchors);
    `.lc-beam` traveling border beam on the landing eval-gate card (ported dependency-free from
    21st.dev BorderBeam; `@supports`-guarded).
- [x] **Session 2026-06-04 (overnight into 06-05)** — three tracks, full suite 1208 green at close:
  - **★ Surplus-lines compliance automation — SHIPPED subscription-free** (was C11, gated under
    "Conditional"). Diligent-search guard, deterministic NY SL tax **3.6%** + stamping fee **0.15%**
    (build caught a wrong 3.76% rate — the correctness story), 45-day filing tracking, statutory
    PDFs.
  - **Real-time ingestion spine** — `POST /ingest` + `/signal` live on Railway; channel payloads
    (Slack / tickets / SMS) routed by an **eval-gated comms classifier** → incident / compliance /
    review. (Track 5's *inbound* side is now real; the outbound Slack alert adapter remains open.)
  - **Staff role + accounts** — account-based auth phase 3: staff persona (login, web/mobile
    parity, demo user `staff@elsewhere.com` → `/report`), route-guard leak fixes, mobile nav parity.
- [x] **Session 2026-06-03** — three things:
  - **★ Carrier AI underwriting memo (Track 9 differentiator) — SHIPPED** (spec `2026-06-03-carrier-ai-underwriting-memo-design.md`, plan `…-carrier-ai-underwriting-memo.md`). Advisory `UnderwritingRecommendation` (posture quote/conditions/decline + subjectivities + rate-adequacy + grounded rationale; engine still owns the premium) on the v2 quote dossier. **Deterministic-first, pure recommender** (`app/underwriting/recommender.py`) over a typed input bundle → eval scenarios feed it directly (no DB). **3 eval scorers** (posture / faithfulness / rate-adequacy) over **12 labeled scenarios incl. boundary/stress cases**: **posture 0.917, rate-adequacy 0.917, faithfulness 1.0** — the two misses are *documented, defensible* threshold disagreements (a 0.75 loss-ratio labeled lean-debit vs rule "adequate"; a single $30k loss labeled conditions vs "quote"), NOT fudged to 100%. Audit snapshots recommendation-vs-decision (`followed`). Web + mobile advisory card. 1151 tests green; web card verified live on the dossier. Reviewed (spec+quality) — fixes applied (dead param, fixture tier↔score realism, faithfulness regex now catches single-digit/tier hallucinations). **Fast-follows:** wire the 3 scorers into `runner.py`/`baseline.py`/`--compare-baseline` + `/evals` scoreboard (number not drift-gated yet); wire real `check_appetite` (recommender handles `in_appetite=None` in v1); LLM provider upgrade behind the same seam (faithfulness scorer guards it).
  - **Landing page — SHIPPED** (`/` was `redirect→dashboard→login`; recruiters/founders hit a bare password box). New standalone Nightline landing at `/` (thesis pillars + the loop + eval-gated diff + inline one-click demo personas); signed-in users still route to their role home. No fabricated social proof. Verified live; carrier demo one-click → `/underwriting`.
  - **Logout/auth-bounce → landing, not `/login`** — now that `/` is public, all `router.push("/login")` guards + the 3 `handleSignOut`s go to `/` (kept: landing Sign-in link, reset-password redirect). Mobile app unaffected.
  - **★ Operator-dashboard 20-30s load — FIXED (perf root cause).** `get_session()`→`create_db_and_tables()` ran `_backfill_compliance_signals()` (2 cross-region SELECTs over ~291 venues) **unguarded on EVERY request** — the earlier "32s" fix guarded the DDL but missed the backfill. The dashboard's ~10 concurrent calls each re-ran it on a cold/waking Neon → 20-30s. Now guarded **once per engine** (returns False while venues unseeded so it still self-heals across startup ordering; marks done after the first full pass). Live before/after: light endpoints ~0.86s→~0.43s; `incident-status-feed` ~2.3s→~1.75s; the cold-load compounding eliminated. RED→GREEN tests; 1153 green. **Residual (infra, not code):** Neon scale-to-zero wake (~1-2s first query after idle) — mitigate with a keep-warm ping if needed.
- [x] **Session 2026-06-02 (evening)** — adjuster-desk polish + a real lifecycle bug, all on the
  carrier persona (`underwriter@nightline.risk`). Three commits:
  - **Scroll-jump fix** (`e9114e7`): `.lc-shell` used `overflow-x: hidden`, which per CSS spec forces
    `overflow-y` to `auto` → a nested scroll container that trapped wheel events and snapped long pages
    to the top. Changed to `overflow-x: clip` (no scroll container). Diagnosed by driving the live site
    with Playwright (wheel pinned at 0; keyboard/programmatic worked). Fixes **every** `.lc-shell` page.
  - **Coverage gate** (`607ae54`): reserve / payment / close on the adjuster detail are now **locked
    until the coverage determination is recorded** (heading already said "required before adjudication").
    Web = `inert` + `pointer-events:none` + dimmed + lock banner; mobile = dimmed non-interactive
    sections + banner. ui-ux-pro-max `progressive-disclosure` + `disabled-states`.
  - **Lifecycle fix** (`904114c`, the important one): the gate forces *coverage-first*, but the claim
    auto-transitions only advanced the *reserve-first* path — so after deciding coverage a claim was
    stranded in `under_investigation` and **`closed_paid` was unreachable**. Fixed `record_carrier_reserve`
    (`under_investigation → reserved`) + `record_payment` (indemnity `under_investigation → settling`);
    +3 regression tests. **Full suite 1133 green.** Also added **`scripts/seed_adjuster_demo.py`**:
    8 idempotent `ADJ-DEMO-*` claims across Mirage/HoY/Market/Elsewhere spanning every state (notified ×2,
    covered/under_investigation, reserved, settling w/ payment+reserve history, reservation-of-rights,
    closed_paid, closed_denied) — drives the real services so audit/history/hashes are genuine.
  - [ ] **PICK UP HERE — seed prod** (ops, not code): the seed is committed but only run against the
    *local* DB. To populate the live site, from `backend/` in a terminal:
    `$env:DATABASE_URL="<Neon DATABASE_PUBLIC_URL>"; python -m scripts.seed_adjuster_demo` (use the
    **public** Neon URL, not `railway run`). Open question left for the user: optionally wire this seed
    into the backend startup (idempotent, failure-isolated) so it auto-populates on deploy — tradeoff is
    +4 demo policies/submissions showing on the broker's placement screens.
- [x] **Session 2026-06-02** (newest first): carrier decision-provenance hardening (`46005ca`) —
  `decision_source` (broker_relay default / carrier_desk) stamped on carrier-quote responses through
  the shared `record_carrier_response`, so the audit trail distinguishes a carrier delegated-authority
  decision from a broker relay (pre-bind foundation for MGA authority); +2 TDD tests, 1085 green. Also:
  carrier role name **decided** → stays `carrier` (track 9); policy-doc **vector RAG design spec**
  committed (track 10) — design approved, implementation plan pending.
- [x] **Session 2026-06-01** (newest first): carrier underwriter-desk **backend** (track 9, `5d2f55b`);
  broker-honest copy reframe (`958418f`); open-questions answer/resolve loop (track 8, `f4be266`);
  operator bottom-nav reorder — promote Claims, demote Venues, web+mobile (`20c5503`); operator persona
  parity — drop Reports leak + "Claims" status surface (`32ce45e`); mobile dashboard shows bound policy
  not estimate once in force (`8a35af8`); mobile carrier-detail parity (`9b42bc2`); removed stale
  `render.yaml` (`e4b00b7`). Also: mobile `.env` host fix (login was hitting the retired Railway
  project — local-only, see [[project_mobile_env_host_drift]]). Backlog tracks 8 (agent roadmap) + 9
  (carrier persona) added.
- [x] Web↔mobile consistency: Book navigation fix, role-aware naming, factor-glyph parity, 3 new mobile screens (Settings, Market, Ingestion).
- [x] Settings made real: `PATCH /api/auth/me` + change-password (web + mobile); fake sub-sections neutralized.
- [x] Password reset flow (built; emails gated on `RESEND_API_KEY` — logs the reset URL until then).
- [x] Config hardening: `validate_startup_env()` fails fast in prod without `APP_SECRET` (caught a real silent-session-reset bug on Railway).
- [x] Storage abstraction: all file I/O behind `app/storage.py` (`LocalStorage`); S3 is a one-class swap.
- [x] ETL hardening: startup-seeds connector runs (demo page populated), rejection-reason observability, extract retry/backoff. De-flaked `test_run_pos_moves_a_venue_score`.
- [x] Test scaffolding: Vitest (frontend), jest-expo (mobile).
- [x] Broker spine hardening (gut-check 2026-05-31): `broker-decision` endpoint gated `require_broker` (was **unauthenticated** — anyone, incl. an operator, could approve a claim), actor now from the token; `needs_more_info` broker "withdraw → re-queue" escape; duplicate Review Decision card removed; `authHeaders()` on the underwriter proposal mutations; `/underwriter` lights Work Queue in nav; dead login "Back home" link removed.
- [x] Work Queue Postgres-500 fix: `recommendation_snapshot` JSON-string coerced (`_coerce_snapshot`) so the priority sort no longer 500s on Neon; the CORS-less 500 had been hanging the spinner — load now shows Retry. Verified live (`?sort=priority` 500→200, 13 proposals).

---

## Next up (subscription-free) — pick a track

> **Hygiene 2026-06-09:** completed tracks are collapsed to a one-line ✅ summary (track numbers kept stable so cross-references don't break). Done `[x]` sub-items *inside* still-open tracks are intentional context. **Active work = Tracks 3, 4, 5, 8, 9 (remainder), 10, 11, 12, 13, 14, 15, 16; deferred = 6; done = 1, 2, 7b.** Tracks 13–15 + Track 12 Theme G added 2026-06-09 (evening) from the Fable code-audit + AI-native gap evaluation. **2026-06-10: five-agent external audit** (market research + backend / frontend-mobile / AI-eval / ops) folded in: 3 new security P0s + row-locking + DATABASE_URL guard → Track 13; CI-wiring bug + Postgres test lane + E2E depth → Track 4; shared web fetch wrapper → Track 15; market-thesis caution + named scope gaps → Track 12. Recommended order re-cut below.

### 1. Eval harness deepening  ★ headline / best pitch fit — ✅ COMPLETE
- [x] Mature harness, **21/21 = 100%** on the deterministic stack: 15 standard + 6 adversarial scenarios, 10 scorers (severity/citation/review-status/factor + NDCG@5/MRR retrieval + 3 safety); per-stack baselines + `--compare-baseline` CI gate (`evals`/`evals-matrix` in `ci.yml`); `/evals` scoreboard; last gap (`off_topic_review_status` 50%→100%) closed. *No open work — kept visible as the pitch centerpiece.*

### 2. Correctness pass on latent bugs  — ✅ done 2026-05-27 (one open ops item)
- [x] Shipped: tz naive/aware backfill crash fix (`as_utc()`); swept `fromisoformat`/`timedelta`/`total_seconds` sites; audited every `except Exception`; recency-decayed + exposure-normalized Safety Record scoring (+ `audit_incidents.py`/`cleanup_stale_incidents.py`); self-healing per-venue open-incident cap; idempotent compliance re-resolve (no 500). All RED-proven regression tests.
- [ ] **(Open — ops, not code)** Prod stale-incident cleanup: `DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.audit_incidents --venue elsewhere-brooklyn` → review buckets → `cleanup_stale_incidents --apply` to drop the ~29 stale open `inc-` rows (display persists until cleaned).

### 3. Deterministic (no-key) agent quality
- [x] Improve the keyword-ladder risk classifier (`app/providers/deterministic.py`) — added a generalizable aggravator/mitigator severity modifier + filled the medical keyword gap. `severity_match` 47%→100%, aggregate 57%→95%, no other scorer regressed. Unit tests in `test_risk_classifier.py` include over-fit guards (novel summaries + plain-incident guards). Baseline + public scoreboard refreshed.
- [ ] Tighten deterministic memo templates so no-key output reads credibly in a demo.
- [ ] Add eval coverage that pins the deterministic-mode quality (ties into track 1).

### 4. Test-coverage expansion

**Test infrastructure — speed + selection (shipped 2026-06-09):** the backend suite (~1,314
tests) ran in **37 min** with no way to run a subset. Root cause was per-test cost, dominated by
bcrypt (default 12 rounds in every seed + auth test), on a single shared `database.db` with
pytest-xdist installed-but-unused. Shipped:
- [x] **Cheap bcrypt under `TESTING`** (`app.auth._bcrypt_rounds`, flag set in `tests/conftest.py`)
  — 4 rounds in tests (verification is cost-agnostic). Full suite **37 min → ~3.5 min (11×)**; auth
  files 168 s → 8.5 s. RED→GREEN test (`test_password_hash_cost.py`).
- [x] **Auto `unit`/`integration` tiers** — `conftest.pytest_collection_modifyitems` tags by source
  (TestClient/get_session/tables → integration, else unit); zero per-file labels. `pytest -m unit` =
  880 tests / ~30 s inner loop. Markers registered in `pytest.ini` (`--strict-markers`).
- [x] **Change-aware selector** `scripts/affected_tests.py` — git diff → only the test files that
  transitively import the changed `app.*` modules (`--run` executes them). Honest blast radius (a
  change to `auth` selects ~half the suite because it's imported everywhere; a leaf service selects a
  handful). Workflow doc: `backend/docs/testing.md`.
- [ ] **Deferred (no longer urgent at a 3.5-min suite; tracked):** per-test DB isolation +
  `pytest-xdist -n auto`. Would make the suite deterministic (kills the shared-`database.db` ordering
  flake — `test_evidence_tenant_isolation` / `test_ingestion_runs_api` pass in isolation but can fail
  in full-suite order when accumulated rows overflow a limited query window) and parallel (~sub-minute).
  Carries 121-file regression risk (some tests may rely on accumulation) → do deliberately with
  full-suite checkpoints, not a big-bang. Approach: extract lifespan seeding into a reusable
  `seed_runtime(session)`, function-scoped autouse reset (file-copy restore of a per-worker seeded
  template), per-worker in-memory/temp DB so xdist workers don't collide.

- [ ] Frontend: component/integration tests beyond the `account`/`market` unit tests; broaden the 6 Playwright e2e specs.
- [ ] Enable the skipped `frontend/e2e/settings.spec.ts` once the backend deploy includes the auth endpoints (it's `describe.skip` pending deploy).
- [ ] Mobile: tests beyond `format.ts` helpers (lightweight, given Expo render-test flakiness).
- [ ] **ESLint warning burndown (added 2026-06-10).** `npm run lint` is green but carries 47 advisory
  warnings — 37 are `react-hooks/set-state-in-effect` (the new React-Compiler rule, currently set to
  `warn` in `eslint.config.mjs`). Adoption pass: migrate the flagged effects to event-driven / `use()`
  loading where it's a real anti-pattern, or accept the rest. Tighten to `error` + `--max-warnings 0`
  once burned down so the lint becomes a real gate.
- [x] **★ CI wiring bug — Vitest + ESLint never actually run in CI — FIXED 2026-06-11 (commit `d1df145`).** `ci.yml`'s
  frontend job calls `npm run test`, which runs only the single hand-rolled
  `node src/lib/incidentView.test.mjs` — the real Vitest suite lives under `test:unit` and is **not
  executed in CI**; `eslint` isn't invoked at all (only design-lint + build are). Fix (~30 min):
  point CI at `test:unit` (or fold the `.mjs` into Vitest) + add `npm run lint` (gate at the current
  warning count until the burndown above lands `--max-warnings 0`).
- [x] **Postgres-fidelity test lane — DONE 2026-06-11 (commit `404861b`).** `tests/conftest.py` pins the entire suite
  to SQLite (`sqlite:///test_run.db`), so the **JSON-string-on-Postgres class — the documented #1
  prod-only regression source** (see `project_neon_json_string_regressions`) — is structurally
  invisible to all ~1,300 tests. Add a CI lane running the suite (or at minimum a JSON-read-boundary
  subset) against real Postgres (GH Actions service container). Turns the recurring reactive "Neon
  sweep" into a standing gate; pairs with the Alembic item (Track 13 deferred).
- [ ] **E2E depth + selector seams (2026-06-10 audit).** The 7 Playwright specs (~16 tests) cover
  auth/settings/venues/renewals smoke but **neither core journey** (incident→evidence→packet→proposal;
  submission→quote→bind→FNOL), and they pin to CSS classes (`.sidebar-nav-item`, `.venue-card`,
  `.lc-login__tab`…) that rename invisibly to tsc (the known silent-pin failure mode). Add
  `data-testid` seams on the hot paths + one spec per core journey.

### 5. Data & Defense integration surface — vision-vs-built (added 2026-05-30)

The "Data & Defense" marketing diagram promises: inputs (Cameras, POS, HR, ID Scanner)
→ savings engine → outputs (**Slack/Text, Ticketing, Scheduling, Reporting**). Status of
each output box, verified against code on 2026-05-30:

- **Slack / Text — channels MISSING; the dispatch seam exists.** `AlertEvent` + per-venue
  `PushSubscription` + `app/services/alert_dispatcher.py::dispatch_alert()` already deliver
  alerts via **Web Push** (gated on `VAPID_PRIVATE_KEY`). `app/services/email.py` (Resend) is
  wired for password reset only — not operational alerts. No Slack, Twilio/SMS, or webhook code.
  - [ ] **Slack adapter behind the `dispatch_alert` seam** — Slack *incoming webhooks* need NO
    paid account, so this is subscription-free and demoable. **Highest-leverage first move** (closes
    the most visibly-missing box). ★ (2026-06-04 update: the *inbound* direction shipped — the
    ingestion spine + comms classifier consume Slack/ticket/SMS payloads; this item is the
    *outbound* alert adapter, still open.)
  - [ ] Also route operational `AlertEvent`s through `email.py` (reuse the existing provider), not push-only.
  - [ ] 🔒 **SMS (Twilio)** — same seam, but needs a paid account. Gated.
- **Ticketing — PRESENT internally, under other names.** No external ticketing integration, but
  `BrokerTask`, `PolicyRequest`, the `ComplianceSignal` queue, `AlertEvent`, and the `/tasks` page
  already are the actionable-item layer.
  - [ ] (optional) Unify these into one "inbox / tickets" surface so the diagram box maps 1:1.
  - [ ] 🔒 External ticketing (Linear / Zendesk / Jira) — gated, low priority.
- **Scheduling — simulated *input*, not an output.** `StaffingConnector` (`app/ingestion/connectors.py`)
  ingests a simulated "scheduling feed → staffing_ratio" (RNG). Directionality differs from the diagram:
  data flows IN as a risk signal; there is no scheduling write-back.
  - [ ] 🔒 Real scheduling API (7shifts / Deputy) — the cheapest real-connector swap; the slot exists.
- **Reporting — BUILT (strongest box).** Defense-package PDF export (`app/defense_package.py`),
  `UnderwritingPacket` + audit trail, broker portfolio / risk-profile dashboards, `/evals` scoreboard,
  override-calibration stats.
  - [ ] (enhancement) Scheduled / exportable periodic report (e.g. weekly savings-summary PDF or email).

**Inputs (left side)** are simulated connectors (`app/ingestion/connectors.py`): `PosConnector`,
`IdScanConnector`, `StaffingConnector`, + camera via the vision pipeline. No distinct HR-System
connector. Tracked under "Real operational connectors" in `go-live-readiness.md`.

### 6. Operator multi-venue home — deferred (added 2026-05-31)

- [ ] **Multi-venue operator home layout.** Today the operator home assumes a single venue
  (`tenant_id == venue_id`); a venue-group manager (`extra_venue_ids`) only gets a venue
  *switcher* (chips when `venuesList.length > 1`), not a portfolio roll-up. If/when a single
  operator account legitimately spans multiple venues, design a proper multi-venue home:
  per-venue risk / open incidents / open claims / compliance at a glance, sortable by what
  needs attention (mirrors the broker triage strip, scoped to the operator's own venues).
  **Deferred** — current product assumption is one venue per operator; no multi-venue demo
  data exercises this. Revisit when a real multi-venue operator scenario exists.

> First move when we start: the **Slack incoming-webhook adapter** on the existing `dispatch_alert`
> seam — subscription-free, demoable, and it's the one output box that's genuinely absent rather than
> just renamed (ticketing) or simulated (scheduling) or already built (reporting).

### 7. Broker business iteration — make it read like a real brokerage (added 2026-05-31)

Context: the gut-check (4-agent audit, 2026-05-31) found the broker **transactional spine**
(submission → quote → bind → policy → FNOL → claim) is largely complete and now *operable*
(see Recently shipped). What's missing is the layer a real insurance broker lives in daily —
plus a ring of unreachable lifecycle edges. This track is that iteration. Scope call: this is a
deliberate next iteration, not part of the demo's eval/correctness pitch — size it to the audience
(an insurance recruiter will notice the absent financial layer; an AI-infra audience won't).

**7a. Business / financial layer — the genuinely-absent part.** A broker's day is revenue, loss
ratios, and placement, not just clicks. Commission is *stored* per policy
(`Policy.commission_amount/rate`) and shown on policy detail, but there is no roll-up.
- [x] **Book financials view** ★ — written + earned premium, commission/revenue roll-up, and
  loss ratio (incurred ÷ earned, pro-rated by elapsed term) across the in-force book, with
  per-coverage-line and per-carrier breakdowns. Shipped 2026-06-01: `app/services/book.py` +
  `GET /api/book/financials` (broker-only, TDD'd) → web `/book` page (nav: Book ▸ Financials)
  + mobile `BookScreen` (More ▸ Book Financials). Loss ratio uses underwriting bands
  (<60% healthy / 60–80% watch / >80% high) shown as color **and** text label.
- [x] Per-venue loss run as a first-class, exportable artifact (claims history + reserves/paid by
  coverage line). Shipped 2026-06-01: `app/services/loss_run.py` + `GET /api/venues/{id}/loss-run`
  (+ `.csv` export), venue-access gated (broker any venue, owning operator own). Web dedicated
  page `/risk-profile/{id}/loss-run` (entry tile in Records & evidence) w/ authed CSV download;
  mobile `LossRunScreen` (entry on risk-profile, OS share-sheet CSV export). 11 tests TDD'd.
- [~] Carrier appetite / relationship model — **carrier detail page done 2026-06-01**:
  `app/services/carriers.py::carrier_detail` (book rollup + appetite tags + policies), surfaced via
  the enhanced `GET /api/carriers/{cid}` (additive book/policies keys) → web `/carriers/[cid]` page
  (appetite tags + written/earned premium + commission + loss ratio + in-force policy list), and the
  Book Financials "By carrier" rows now deep-link to it. Mobile carrier-detail parity shipped
  2026-06-01 (`mobile/.../CarrierDetailScreen.tsx`; BookScreen "By carrier" cards tappable).
  **Remaining:** graded match-score on a submission's carrier-picker (turn `check_appetite`'s
  boolean into a 0-100 match + reasons).
- [ ] 🔒 Billing / premium accounting / invoicing — likely needs Stripe; gate it.

**7b. Lifecycle negative edges — defined but unreachable (placement audit).** ✅ **Done 2026-06-01.**
These made the spine *incomplete*, not just unpolished:
- [x] **Renewal hand-off leaves the prior policy dangling** ★ — `create_renewal` now guards one live
  renewal per policy (`find_live_renewal`) and the `/renewals/due` list excludes policies with a
  renewal in flight. (`services/renewals.py`)
- [x] `bound_pending_number` policies are excluded from the default `/policies` list — `list_policies`
  default now filters on `ACTIVE_POLICY_STATUSES` (active + bound_pending_number).
- [x] No UI path to mark a submission `lost`/`declined`, or a policy `expired`/`non_renewed`/
  `lapsed` (or reinstate) — service fns (`mark_submission_lost/declined`, `expire/non_renew/lapse/
  reinstate_policy`) + routes (`/submissions/{id}/lose|decline`, `/policies/{id}/expire|non-renew|
  lapse|reinstate`) + web (submissions kanban + policy detail) and mobile (detail screens) controls.
- [x] `coverage_change` policy-request approval is a silent no-op — approval now issues a real
  `Endorsement` and adjusts premium, validated before the lifecycle transition.

**7c. Remaining gut-check polish (medium/low).**
- [ ] Broker dashboard has no empty-book / fetch-error state (a failed `/api/portfolio` renders a
  healthy-looking empty Book).
- [ ] MobileBottomNav broker tabs are wrong (Incidents/Compliance aren't broker desktop
  destinations; missing Work Queue/Submissions) — `MobileBottomNav.tsx:29-34`.
- [ ] Broker `/incidents` is orphaned on desktop (no sidebar item) but a primary tab on mobile —
  decide: add to nav or remove.
- [ ] Dashboard money via `Number(string)` float coercion; `/alerts` uses off-theme hardcoded hex;
  cancel/assign-number via `window.prompt`.
- [ ] FNOL filing returns the new claim but the UI never links to `/claims/{id}`; broker venue
  risk-profile never links to the venue's policy.
- [ ] Split the `/claims` dual-design file (broker table + operator tracker co-located).

**Pending correctness sweep (cross-cutting):** more un-coerced `Column(JSON)` reads likely 500 on
Postgres — the Neon class (see the Work Queue fix + `project_neon_json_string_regressions` memory).
Grep model JSON attrs for `.get(`/iteration and coerce at the read boundary.

- [x] **Incident create A&B structured fields — DONE** (verified 2026-06-10). `incident_flow.py`
  `create_brawl_incident_flow` now passes `parties`, `witnesses`, `security_response`, and
  `weapon_involved` into the `IncidentRecord(...)` constructor (`incident_flow.py:57-60`), so
  API-created incidents preserve the evidence-defensibility fields. (`refused_service_or_overserved`/
  `injury_detail` follow the same pattern if a future field needs wiring.)

### 8. AI-native broker-workflow layer — audit + agent roadmap (added 2026-06-01)

**Audit verdict.** We're a deep **system of record** for the full placement→policy→claims
lifecycle (ACORD 125/126 generation, defense-package PDFs, calibrated risk, eval harness — well
past "just a CRUD app"). What's thin is the **system of action in the broker's own tools** — email,
spreadsheets, scheduling, phone. The gaps cluster exactly at that boundary: everything *inside* the
app is built; everything that reaches into Outlook/Excel/phone is missing. That boundary is the
AI-native frontier, and it maps onto strengths already shipped (extraction, ingestion connectors,
eval/calibration harness).

Capability map (evidence = real endpoints): ✅ submissions + ACORD; carriers/appetite + quotes;
bind + full policy lifecycle; COIs; FNOL/reserves/payments/defense-package; compliance; book
financials; loss-run + CSV; renewals (in-app). 🟡 appetite match is boolean (graded score pending);
renewals/chase are in-app only. ❌ spreadsheet (loss-run/SOV) ingestion; outbound follow-up email +
scheduling; inbound email/phone; carrier-side integration.

**Foundation (shipped 2026-06-01):**
- [x] Open-questions answer/resolve loop — operator answers AI memo questions, broker resolves; both
  read the same state off the packet payload (`OpenQuestionResponse` + `app/open_questions.py`;
  routes on `packets.py`; web `underwriter`/`incidents/[id]` + mobile incident/report screens). This
  is the in-app **missing-info chase substrate** — it already models *what's outstanding and who owns
  it*, which is the hard part of the broker's #1 time-sink.

**Next (human layer first, per 2026-06-01 decision):**
- [ ] **Two-way open questions** ★ — generalize the loop so *either* persona can open a question
  (`source` ai|broker + `asked_by`); counterparty answers; resolve. Mirror of "operator adds
  evidence." Broker affordance on `underwriter` + `BrokerReportDetailScreen`; operator surfaces
  already render the list. (Operator-answerable, not a note-to-self.)

**Then — agent assistants (each a gated `Worker` + `evals/scorers` entry, same shape as
`underwriter_memo_agent`; suggestion→human-confirm→audit, NEVER autonomous on the defense package):**
- [ ] **Answer-drafting agent** (highest value, lowest risk) — pre-fills an operator answer from the
  evidence + vision analysis already attached; human confirms. Leverages existing extraction.
- [ ] **Sufficiency judge** (LLM-as-judge, the differentiator) — scores whether an answer resolves
  the question; suggests "ready to resolve" or flags the gap. Advisory, calibration-gated.
- [ ] **Follow-up / nudge agent** — detects stale outstanding items (un-answered questions, un-returned
  carrier quotes, COI/renewal due) and **drafts the chase email + proposes a send time**. This is the
  *outbound arm* the chase substrate is missing (needs the gated Resend email path).
- [ ] **Spreadsheet-ingestion agent** — upload a messy loss run / SOV → structured rows into
  submissions or loss-run. Pure "messy → structured"; reuses ingestion + extraction discipline.
- [ ] **Inbound email parser** — a forwarded submission/quote email → structured submission /
  quote-response. (Gated on inbound-email infra.)

Guardrail: any agent autonomy (e.g. auto-resolving a clearly-satisfied, low-severity question) sits
**behind the calibration gate** with an eval scorer measuring accuracy — agents accelerate the loop,
evals keep them honest. The defense-package audit trail is non-negotiable.

> Note: the **carrier persona** (track 9) was prioritized ahead of two-way questions + agents on
> 2026-06-01. Resume order is the user's call.

### 9. Carrier persona — vertically-integrated AI-native insurer (added 2026-06-01)

**Thesis.** Per the founders, the destination is "the first AI-native **carrier** for commercial
insurance." Nightline is on the broker → MGA → carrier ladder; "one-stop / full-stack" is coherent
because Nightline owns *its own* value chain — operator (insured), broker (distribution), carrier
(underwriting + risk-bearing). This is **Nightline-as-the-carrier**, NOT a third-party-carrier
marketplace (no external carrier logins). The carrier engine already existed implicitly
(`pricing.py` + risk + eval harness = underwriting brain; reserves/payments/FNOL/defense = claims);
the persona work *surfaces* it behind a role.

**Scope-honesty pre-work (shipped 2026-06-01, commit 958418f):**
- [x] Broker-honest copy reframe — relay vs decide. Quote → "indicative premium · subject to carrier
  quote"; book → commission (our revenue) + carriers' loss ratios we *monitor*; reserves/payments →
  "log carrier reserve/payment". Flip the same copy when claiming the carrier rung. Engine unchanged.

**Phase 1 — carrier underwriter desk:**
- [x] **Backend (shipped 2026-06-01, commit 5d2f55b)** — new `carrier` role + `require_carrier`;
  `app/services/underwriting_desk.py` (`underwrite_quote` quote-with-terms/decline + `underwriting_queue`),
  a thin wrapper over `record_carrier_response` so lifecycle + submission escalation + audit stay
  single-sourced; `GET /api/underwriting/queue` + `POST /api/quotes/{qid}/underwrite` (carrier-only).
  Closes the placement loop internally: broker submits → carrier underwrites → broker binds. 12 TDD
  tests (6 service + 6 API), full suite 1083 green.
- [x] **UI ★ (shipped 2026-06-02)** — carrier role routing + the desk, web + mobile.
  - Auth/routing: `carrier` added to `UserRole` (`AuthContext`) + `useIsCarrier` (admin counts);
    login role option + "Carrier desk" demo button; `carrier` demo user (`underwriter@nightline.risk`
    / demo123, `user_003`); carrier nav group in `AppShell`; `/dashboard` bounces a carrier →
    `/underwriting` (spinner, no "No Venue" flash). Mobile: `CarrierTabs` (single "Underwriting"
    destination) branch in `TabNavigator`.
  - Web desk: `/underwriting` queue (venue · coverage · TierBadge+score · engine-suggested premium)
    + `/underwriting/[qid]` decision form (suggested per-line breakdown; **Quote** at an editable
    total that proportionally rescales lines so the backend sum-check always passes; **Decline** w/
    reason). Guarded carrier-only. Shared client lib `src/lib/underwriting.ts`.
  - Mobile parity: `UnderwritingStack` + `UnderwritingDeskScreen` (FlatList) + `UnderwriteDecisionScreen`
    (reuses the `Field` primitive); `api/underwriting.ts` mirrors the web lib incl. the rescale.
- [x] Backend enrichment for the desk (shipped 2026-06-02) — `underwriting_queue` rows now carry
  `venue_name`, `risk` (tier + total_score), and `suggested_premium_breakdown` from
  `build_quote_for_carrier` (the same engine the broker's build-indicative uses). Failure-isolated:
  an unknown venue degrades to `suggested=None` rather than 500-ing the queue. +4 TDD tests, full
  suite 1089 green.

**Phase 2 — carrier claims/adjuster authority:** the carrier desk *sets* reserves, *approves*
payments, *adjudicates* (approve/deny) — the things the broker now merely "logs". Reconciles the
relay/decide split with an in-app owner.

**Phase 3 — own-paper capstone:** policy issuance on Nightline paper, declarations, portfolio/
solvency view. The "we are the carrier" finish.

**Decided 2026-06-02:** role name stays `carrier` (not `underwriter`) — matches the
broker→MGA→carrier thesis language and the Phase 3 own-paper framing; the persona reads as the
institution, not just the seat. Phase 1 UI may hardcode `carrier` freely.

**Phase 1 follow-on — decision provenance (shipped 2026-06-02, commit `46005ca`):**
- [x] `record_carrier_response` gains `decision_source` (`broker_relay` default / `carrier_desk`),
  stamped into the `carrier_quote.{quoted,declined}` audit event. The carrier desk
  (`underwrite_quote`) stamps `carrier_desk`; the legacy broker-relay path keeps `broker_relay`. The
  audit trail now *proves* a carrier delegated-authority decision vs a broker transcribing an outside
  quote — the load-bearing distinction for Phase 2 bind / MGA authority. Shared lifecycle core
  unforked; +2 TDD tests, full suite 1085 green.

**Gap review → carrier roadmap (2026-06-02).** A gap analysis (2026-grounded: E&S rate-softening +
selective terms; social-inflation/nuclear-verdict pressure on hospitality A&B/liquor — Nightline's
book; AI submission-triage as the 2026 frontier) found Phase 1 models underwriting as
"quote-or-decline a pre-priced submission." The real job (full risk picture → terms & subjectivities
→ counter/refer/request-info → renewals → portfolio) is mostly *missing*. Sequenced as follow-on
specs (each its own spec → plan → build), **AI memo pulled earlier per 2026-06-02 decision**:

- [x] **Phase 1.5 — Carrier desk v2 ★ (shipped 2026-06-02)** — spec
  ([`2026-06-02-carrier-desk-v2-design.md`](specs/2026-06-02-carrier-desk-v2-design.md)) + 13-task plan
  built/pushed (full suite green): decision-dossier endpoint, **full structured terms** in
  `coverage_terms`, carrier⇄broker **request-info loop** (`info_requested`), "B" decision-hero layout
  (web+mobile), richer queue rows + KPI strip + back-home fix. Then a **decision-first reframe** (lead
  with the suggested quote + Quote/Decline/Request-info; structured terms collapsed into opt-in
  "Tailor terms"; clickable KPIs → dossier accordions) + a `ui-ux-pro-max` a11y/enum-humanization pass.
- [x] **Phase 2 — Carrier claims adjudication ★ (shipped 2026-06-02)** — spec
  ([`2026-06-02-carrier-claims-adjudication-design.md`](specs/2026-06-02-carrier-claims-adjudication-design.md))
  + 13-task plan built/pushed (full suite **1129 green**; web src + mobile tsc clean). **The carrier's
  2nd core job (bear the risk / pay losses).** Adjuster desk on the existing claim machinery:
  **coverage decision** (covered / denied / reservation-of-rights, gates indemnity, denial closes) +
  carrier-owned reserve/payment/close stamped `decision_source=carrier_desk` (broker relay preserved),
  an **adjuster queue**, carrier **Claims** nav desk (web `/adjusting` + mobile Claims tab — extends
  the lean nav to Desk · Claims), an **advisory reserve/severity hint** (deterministic, from loss-run
  + incident severity), and **operator visibility** of the coverage outcome + rationale (web tracker;
  mobile via the shared claim detail). Settlement-authority/escalation deferred.
- [x] **AI underwriting memo** (the differentiator) — **SHIPPED 2026-06-03** (see Recently shipped).
  Advisory `UnderwritingRecommendation` on the v2 dossier; deterministic recommender + 3 eval
  scorers (posture/faithfulness/rate-adequacy, 12 scenarios, 0.917/0.917/1.0); web+mobile card;
  audit snapshot. Fast-follows: CI-baseline wiring + `/evals` scoreboard, real appetite, LLM upgrade.
- [ ] **C5 — carrier portfolio / book** — written/earned premium *underwritten*, loss ratio vs
  target, quote-to-bind (hit) ratio, mix by line/venue-type/tier, accumulation. The **management
  layer** above claims (consumes the carrier-owned incurred losses Phase 2 makes real); fills the nav.
- [ ] **C4 — renewal underwriting** — renewals due → re-rate on loss experience
  (`loss_adjustment_from_loss_ratio` exists) → renew / non-renew / re-terms.
- [ ] **Claims intelligence (the differentiator on the claims desk)** — the claims analog of the AI
  underwriting memo. Phase 2 ships a *lightweight advisory reserve/severity hint* (deterministic, from
  loss-run history + incident severity); the full version is its own spec: a reserve-suggestion model,
  **severity / litigation-risk prediction**, a **coverage-analysis assist** ("does the policy
  respond?"), and **fraud flags** (✅ **shipped 2026-06-05** as the fraud/SIU agent — deterministic
  2-point scoring + eval baseline; reserve-model / litigation-risk / coverage-assist remain) — all
  **powered by the incident evidence + vision analysis + defense
  package Nightline already owns** (most carriers adjudicate blind to that). This is where the carrier
  desk goes from *able* to adjudicate → *smart* at it; addresses the real carrier pains (reserving
  accuracy, claims leakage, severity/social-inflation) that owning the workflow alone doesn't solve.
- (then) **Phase 3** own-paper capstone (below).

**Deferred depth — smaller specs, lower priority (tracked, not committed):**
- [ ] C6 appetite / eligibility / clearance (graded appetite-match is already the open 7a item —
  turn `check_appetite`'s boolean into a 0–100 match + reasons on the carrier picker).
- [ ] C7 decline taxonomy (structured reason codes) + quote/declination history (win-loss log).
- [ ] C8 underwriting authority limits + refer-to-senior workflow (the delegated-authority engine the
  `decision_source` provenance was built to support).

**Conditional — needs accounts / v1-scope expansion:** ~~C11 surplus-lines compliance filings~~
(✅ **shipped 2026-06-04 subscription-free** — diligent-search guard + deterministic tax/stamping +
statutory PDFs; see Recently shipped), C12 loss-control /
inspections, C13 reinsurance / capacity / bordereaux (the 2026 MGA-reporting pressure).

**Non-goal (not a deferral):** refactoring the broker `/underwriter` page — it's fine as-is; touching
it would be unrelated scope creep.

### 10. Policy-doc vector RAG — recall layer of a hybrid (added 2026-06-02)

Embedding-backed semantic retrieval over policy-document clause chunks (the existing `SourceRecord`
leaves), with citation anchoring, measured by the existing `evals/retrieval_scorers.py` (NDCG@5 / MRR).
Cross-cutting (ties track 1 evals + the policy-doc subsystem), surfaced during the track-9 carrier
conversation.

**Paradigm call (see spec §3.1):** vector = **recall** (offline, runs now with a deterministic
hashing embedding, no keys); PageIndex tree = **precision + citation reasoning** (keys-gated, future);
LLM-Wiki **rejected** for policy text on citation-fidelity grounds (its compile step replaces verbatim
clause text with a summary), parked for the institutional-knowledge corpus.

- [x] Design spec — `docs/superpowers/specs/2026-06-02-policy-doc-vector-rag-design.md` (approved).
- [ ] Implementation plan (writing-plans) — pending.
- [ ] Build (TDD): `HashingEmbeddingProvider` + `EmbeddingRecord` table + `VectorKnowledgeBase`
  (same `retrieve` interface) + embed-on-ingest hook (failure-isolated) + `get_knowledge_base`
  selector (vector-when-present-else-TF-IDF). Landmines pre-noted: column-level FK ordering,
  Neon JSON-string coercion at the read boundary.
- [ ] Success = `retrieval_scorers` prints TF-IDF baseline vs vector; with a real key, vector ≥ TF-IDF
  NDCG@5 on the gold set (the pitch number).
- [ ] Out of scope (v1): pgvector-native backend (later swap), Chroma, live PDF/PageIndex ingestion.

### 11. Operator Copilot — grounded chat (added 2026-06-09)

Operator-scoped `/copilot`: deterministic keyword-ladder provider (CI/prod floor) + optional
OpenAI-compatible LLM provider (Ollama/Groq/…) behind the same tool seam; every answer grounded by
the faithfulness guard; eval gate over gold scenarios. Read tools wrap the existing persona-gated
services (one source of truth); two confirm-gated act tools (send-to-broker, resolve-compliance).

**Shipped this session:**
- [x] **`get_policy` read tool** (commit `3fcc3f7`) — premium / coverage / policy number / term via
  `policy_for_venue`, grounded by a `policy` citation; routed in the deterministic ladder +
  LLM tool descriptions; nav → operator-facing `/coverage` (not broker `/policies`); eval scenario
  `read_policy_premium` added (gate stays 100%). Fixes "how much premium am I paying?" → was the
  canned refusal because there was no policy tool at all (not a broken RAG).

**★ Live prod issue — Groq 429 (diagnosed 2026-06-09, NOT yet fixed):** all three `COPILOT_LLM_*`
vars are correctly set on Railway, but the prod copilot is hitting Groq **free-tier 429 rate limits**
and silently falling back to deterministic on every question (confirmed in Railway logs:
`[COPILOT] LLM provider failed (... 429 Too Many Requests ...)`). Root contributors: (a)
`llama-3.3-70b-versatile` has the tightest free limits; (b) **each question costs 2 Groq calls**
(tool-pick + synthesis in `openai_compatible_provider._respond_llm`).
- [ ] **IMMEDIATE (ops, no code):** swap `COPILOT_LLM_MODEL` → **`llama-3.1-8b-instant`** on Railway
  (much higher free RPM/TPM; the constrained, enumerated prompts don't need 70B). Retest a "why"
  question — a fuller 2-4 sentence answer = LLM live; the terse template = still falling back.
- [ ] **Gate the LLM to questions that need it** — only explanatory/"why" questions call the LLM;
  counts/status stay deterministic (the template answer is already identical). Cuts Groq load >½ and
  makes simple questions snappier (no round-trip). Test-first.
- [ ] **429 resilience + caching** — on 429, one retry honoring Groq's `retry-after` before falling
  back; cache identical question→answer pairs (kills repeated-demo-question spend).
- [ ] **Startup provider-log diagnostic** — log `copilot provider: OpenAICompatible (<model>)` vs
  `Deterministic` (never the key) so prod boot shows which path is live without log-spelunking.

**Multi-tool / iterative retrieval (scoped 2026-06-09):**
- **GraphRAG / vector RAG REJECTED for the copilot** — the data is already a typed relational graph
  (explicit FKs); the problem is tool-use/composition, not chunk recall. Routing authoritative
  service results through LLM entity-extraction would *harm* the exact-number grounding that is the
  differentiator. (Vector RAG still lives in track 10 for policy-document *clause text* — a genuine
  unstructured corpus; different problem.)
- [ ] **Fan-out multi-tool** (the ~90%-done unblock) — the provider already loops over `tool_calls`
  and `assert_grounded` already checks the union of results; only three things force single-tool:
  prompt rule 2 ("call exactly ONE tool"), the provider keeping only `last_result` for
  citations/link, and no synthesis guidance. Relax + aggregate. Handles "why is my premium high?"
  (policy × risk × claims).
- [ ] **Causal-grounding guard** (ships *with* fan-out, non-negotiable) — `assert_grounded` only
  validates numeric tokens; multi-tool reintroduces causal hallucination ("premium is high *because
  of* claims"). Extend the guard/prompt to forbid unsupported causal language. This is an
  eval-harness extension — on-thesis for the correctness pitch.
- [ ] **Bounded iterative loop** (defer) — true dependent multi-hop (step 2 depends on step 1's
  output) via a ReAct-style loop with a ≤2-3 step budget, gated behind a capable model. Rare for the
  operator persona; fan-out covers ~90%.

---

### 12. Cross-persona gap research (added 2026-06-09)

Source: parallel persona research (broker / underwriter / claims-adjuster / actuary /
insured-operator), grounded in 2024–2026 industry sources. Gaps below are things Nightline
does **not** yet cover. `extend` = builds on existing primitives; `net-new` = new capability.
★ = strongest leverage.

**Confirmed fold-ins (this session):**
- **Copilot deferred phases** (Risk Intelligence Loop program, see `2026-06-08-risk-intelligence-copilot-design.md` §12): **SP3 routed retriever** — semantic retrieval as a copilot read tool (= Track 10 policy-doc vector RAG, same work from two angles); **SP4 closed-loop feedback** — LLM-as-judge for subjective answer quality. Plus open fast-follow: wire the copilot eval scorers into the main `runner.py`/`baseline.py`/`--compare-baseline` + `/evals` scoreboard (same un-gated-in-CI gap as the underwriting memo).
- ★ **Inbound email connector** `net-new` — forwarded submission / loss-run / quote email → structured intake. **Cross-persona keystone** (broker, underwriter, actuary all named messy email/PDF intake as their #1 manual touchpoint). The AI-native frontier this platform keeps pointing at. (Track 8 had it buried as "inbound email parser" — elevate it.)
- **Outbound operational email** `extend` — route `AlertEvent`s through `email.py` (Track 5; just needs `RESEND_API_KEY`).

**Theme A — Front-of-funnel intake** `extend` (highest cross-persona consensus):
- ★ Inbound email/PDF/spreadsheet → structured submission (the connector above).
- [~] Loss-run extraction & normalization across carrier formats → feeds the existing loss-ratio engine.
  **v1 shipped 2026-06-11** (spec `2026-06-10-loss-run-extraction-design.md`, plan
  `2026-06-11-loss-run-extraction.md`): CSV+xlsx → canonical rows + **per-field confidence**, persisted
  as a **review-only `LossRunImport` artifact** (no auto-create of money rows), broker+carrier-gated,
  `AIProvenance`-stamped + audit event; deterministic header-synonym mapper with an **injectable LLM
  `extractor` seam** (mirrors `classifier.py`); **key-free eval scorers** (field-mapping + confidence
  calibration). 23 TDD tests green. **Follow-ups:** PDF via the LLM/OCR seam; feed the rows into the
  underwriting memo / submission risk view; promote scorers into `--compare-baseline`; web/mobile
  review UI (low-confidence fields → correction-flywheel capture point).
- Missing-info / NIGO completeness checker at intake (extends the request-info loop).
- ★ Carrier-quote normalization + apples-to-apples comparison + proposal generation —
  **promoted to the recommended order 2026-06-10**: the highest-frequency broker spreadsheet
  ritual (broker pain #8 below), mostly deterministic over existing `CarrierQuote.coverage_terms`
  rows; pair with Theme D's sublimit-aware analysis so the comparison **highlights A&B
  sublimit/exclusion deltas between quotes** — the artifact a nightlife broker can't get anywhere
  else. Proposal PDF rides the existing doc-generation patterns.

**Theme B — Appetite & placement** `extend`:
- Graded carrier appetite match (boolean → 0–100 + reasons) — already open as 7a/C6.
- Market-submission follow-up / chase agent; renewal remarketing trigger.
- ★ **Subjectivities clearance workflow (added 2026-06-10)** — real quotes carry subjectivities
  (signed application, inspection, sprinkler cert, loss-control visit…) that must be collected and
  *cleared* before bind. Today the UW memo lists them and `coverage_terms` is structured, but
  nothing tracks collect → clear → gate-bind. Extends the request-info loop + the open-questions
  substrate; a daily broker/underwriter workflow and a natural deterministic bind-gate (sibling of
  the diligent-search guard).

**Theme C — Eval/governance moat** `extend` ("ahead of the market" — pitch gold):
- ★ Reframe the eval/calibration harness as **model-governance evidence** for the NAIC AI Model Bulletin (~25 states by 2026): lineage, validation, drift, explainability. Buyers are now *required* to have this.
- Rate-filing justification/documentation generation, grounded in the deterministic pricing engine.
- Claims-leakage as a measured KPI via LLM-as-judge over closed files (= SP4 applied to the back-book).

**Theme D — Claims intelligence** `extend` (partly Track 9's "Claims intelligence"):
- Reserve adequacy + ★ severity/litigation-risk prediction at FNOL — a 2nd scored agent on the fraud-agent pattern.
- ★ Sublimit-aware coverage analysis ("does the policy respond?") — hospitality A&B / dram-shop wedge.
- Medical/demand-package summarization (extends defense-package + vision); subrogation early-ID; cross-claim fraud entity-graph.

**Theme E — Actuarial capability** `net-new` (biggest true whitespace; strong for actuarial-role pitches, e.g. Tesora):
- ★ Reserving engine — triangles + chain-ladder + BF/Cape Cod + Mack/bootstrap ranges. Deterministic + test-first = fits the harness ethos exactly.
- Experience & exposure rating module on the pricing engine; continuous reserve/accumulation monitoring on the Dagster/ETL core.

**Theme F — Operator/insured** `extend` (most product-aligned — your direct user):
- ★★ Underwriter-facing **risk / loss-control dossier** — turn the calibrated risk score + evidence into renewal leverage ("prove you're a good risk"). Flagged highest-leverage by the operator research; reuses everything already built.
- Policy-doc intelligence in copilot ("am I covered if a bouncer breaks someone's arm?") = SP3 retriever + Track 10.
- ★ COI request / verification vault (operator **and** broker need it; E&O angle) — high-frequency, dual-persona.
- Compliance-deadline engine (extends compliance tracking); claims-dispute support + loss-history narrative generator.

**Theme G — commercial-wide research delta** (2026-06-09 second pass; beyond nightlife — grounded
in 2026 sources: premium-audit leakage, broker E&O/policy-checking, LexisNexis claimant-attorney
drivers, InsTech bordereaux bottleneck):
- ★ **Premium audit / continuous exposure monitoring** `extend` — GL + liquor premiums are rated on
  gross/alcohol sales and policies are *auditable*: insureds get surprise audit bills; agencies leak
  **$120–240K premium per $10M book** recoverable via midterm endorsements. The POS connector +
  endorsement machinery already exist → continuous exposure tracking → proposed midterm endorsements
  → audit-ready exposure report. Deterministic, on-thesis; generalizes to all exposure-rated
  commercial lines (payroll-rated WC, sales-rated GL). **Best new domain wedge.**
- ★ **Policy checking** `extend` — deterministic diff of *issued policy vs quoted/bound terms*; a
  classic broker E&O driver (most agencies do **no** post-issuance check; AI-quoting errors rising
  in 2026 forecasts). Structured `coverage_terms` + snapshot hashes make this cheap. Theme-B sibling.
- ★ **Claimant-experience instrumentation** `extend` — **new persona: the claimant** (the research
  gap in the first pass). 56% of claimants hire attorneys because settlement drags; 75% say first
  carrier contact shapes everything; attorney rep ≈ **4×** claim cost. Instrument first-contact SLA
  + settlement-cycle timeliness on the existing claim lifecycle; litigation-propensity (Theme D)
  becomes the prioritizer. "Measured claimant experience → lower litigation-rep rate" is a carrier
  pitch nobody at this stage has.
- **Born-clean bordereaux** `extend` (expands C13) — DA/bordereaux reporting is "the industry's
  biggest drag" (late, misaligned, manually reconciled across fragmented systems; costs MGAs binding
  authority). Nightline is ONE system, so the fragmentation problem doesn't exist → deterministic
  carrier-grade bordereaux export (Lloyd's V5.2-shaped). MGA-ladder thesis artifact.
- **Statutory cancellation/non-renewal notice engine** `extend` — state-mandated notice periods
  before the 7b transitions (expire/non-renew/lapse ship with no notice-timing compliance).
  Deterministic state-rules table — direct sibling of the SL tax module (the correctness story).
- **OFAC payee screening** `extend` — carriers must screen claim payees before paying. Deterministic
  list-check seam in `record_payment`; small, real carrier-compliance credibility.

**Top picks (product + pitch leverage):** (1) inbound email intake [A keystone], (2) operator risk/loss-control dossier [F, most aligned], (3) eval-harness → model-governance reframe [C, ahead-of-market], (4) sublimit-aware coverage analysis [D, hospitality wedge], (5) reserving engine [E, actuarial whitespace]. **Pick which become tracks.** *(All five independently validated by funded competitors — see "Competitive comparables" below; #1/#3/#4 are the strongest convictions post-comparison.)*

**Market-thesis caution (2026-06-10 sourced market research).** The five-agent audit's web-research
pass *validated as severe*: the A&B/liquor capacity crisis (NYC premiums ~$2k→$4k/mo with closures;
sublimits $250–500k; carriers exiting), the E&S/ELANY compliance burden (25.7% of commercial P&C now
E&S; casualty firm through 2026), broker re-keying/turnaround (~40% admin time, ~60% submission
leakage, turnaround = #1 carrier-selection factor), and social inflation (135 nuclear verdicts 2024,
+52%). **But: no source shows carriers discounting documented venues at bind.** The operator evidence
layer's *defensibility* value is validated ("not documented = not defensible" is consensus); the
*premium-reward* loop is not. Pitch evidence → claims-defensibility + loss outcomes; treat
"documentation lowers premiums" as a design-partner hypothesis, never a market fact. White space
confirmed: no competitor spans the operator-evidence↔broker-placement bridge for nightlife
(Capitola/Sayata/Relay/Federato are horizontal; Solink/LevL360 are non-insurance venue tools).

**Named scope gaps (2026-06-10 audit — scope, not defects; name them out loud when pitching "broker
platform" to insurance people):** ACORD-standard forms (25/125/126 — current PDFs are
internal-format); premium billing/installments/disbursement (7a 🔒); commission *ledger*
(splits/carrier-statement reconciliation vs the single stored rate); carrier API connectivity (all
quotes are in-house `pricing.py`; reserves are manual relay); multi-state SL compliance (NY only);
rating depth (no class codes / experience mods / territory); loss-run *ingestion* (Theme A covers);
reinsurance/bordereaux (C13 / Theme G); **binder / declarations-page / invoice generation**
(binding today produces no binder artifact — the temporary-evidence-of-coverage doc every bind
emits in practice); premium financing (PFA) integration; ISO ClaimSearch / industry fraud-DB
reporting; single-location tenant model (`tenant_id == venue_id` — multi-location/multi-entity
insureds with named/additional-insured schedules are a schema-level assumption, the second hard
constraint after rating depth on any "all commercial lines" claim).

#### Competitive comparables — what funded peers do (2026-06-10)

Fresh research on five companies in the same space (insurance × AI). Purpose: each maps onto a
Nightline track/theme, so what they've *funded and shipped* de-risks our roadmap bets and sharpens
the pitch. The market has split into a **barbell**: horizontal infra/workflow rails (Adapt, Outmarket)
vs full-stack AI carriers (Corgi), with single-function depth plays between (Adaptional, Tesora).
Nightline's bet = full-stack **and** vertical (nightlife) **and** owns the operator-evidence feed —
the intersection none of them occupy.

- **Adaptional** (custom AI for **claims + underwriting**, reads/extracts/analyzes docs; brands as a
  "system of *intelligence*"; top-10 carriers; $10M seed). → **Learning:** stop leading with "system
  of record" — our eval-gated decision layer (UW memo, fraud agent, calibration) IS the intelligence
  layer; reframe the pitch around it. Validates Theme A (extraction) + Theme D (claims).
- **Adapt API** ("**Plaid for P&C**"; connects to carrier portals, standardizes docs/notices into the
  AMS, routes tasks, outbound text/email/voicemail on late-pay/cancellation; 95% doc-processing cut).
  → **Learning:** the unglamorous integration *is* the moat, and their core loop is exactly the
  **"system of action in the broker's own tools"** boundary (Track 8) we flagged as the AI-native
  frontier. Elevates the outbound-action arm (Slack adapter → nudge agent on the `dispatch_alert`
  seam, Track 5/8) from "nice-to-have" to strategically central. Also = the carrier-connectivity
  named-scope gap, productized.
- **Tesora** (YC S25, a16z/10VC; agentic **actuarial** workbench — ingests loss runs/SOVs/SERFF →
  builds/audits/deploys raters with **SOX-grade audit trail + ASOP-aligned reviews**). → **Learning:**
  they productized *governance as the selling point*. That is our eval/calibration harness + the
  `AIProvenance` stamping (Track 14) — but we treat it as a pitch *reframe* (Theme C) instead of a
  named surface. ★ **Build the `/evals` → "Model Governance" screen** (lineage/validation/drift/
  provenance); a funded team proves buyers pay for the audit trail itself. Also de-risks the
  reserving-engine bet (Theme E).
- **Outmarket** ($17M Series A; AI workflow suite for **brokerages**, 250+ live, saves **12–15
  hrs/person/week**; flagship **Proposal Builder**, quote comparison, policy review, carrier-appetite
  search, book-wide Q&A, E&O reduction; native AMS integrations + SOC2/ISO/HIPAA). → **Learnings:**
  (1) their shipped features are a 1:1 checklist against our *unbuilt* Theme A/B — every one is
  fund-validated. (2) They lead with the **highest-frequency** ritual (proposal/quote-comparison), not
  the fanciest AI → so should we (Theme A #4 carrier-quote normalization + comparison + proposal, with
  the nightlife A&B sublimit angle they *can't* do). (3) They quote outcomes in **hours saved**; we
  pitch capability → instrument + display a time-saved counter. (4) Their moat is distribution (AMS
  integrations) + trust (compliance certs), not model cleverness.
- **Corgi** ($160M Series B, **$1.3B valuation, $40M ARR**; **AI-native full-stack insurance
  *carrier*** for startups — UW + policy + claims in-house, licensed, quote <10 min; D&O/E&O/cyber +
  an **AI-liability** product; now expanding verticals into trucking). → **Learnings:** this is
  Nightline's Track 9 destination, *proven at scale*. (1) Full-stack-vertical-carrier owning the whole
  value chain is venture-rewarded; our hard-to-place nightlife A&B wedge is the analog of Corgi's
  startup-D&O wedge (a carrier-exiting class — confirmed by the §market research). (2) **Licensing /
  regulatory approval is the real unlock + moat** (Corgi's ARR started *at* approval, Jul 2025) — a
  non-eng gate to name honestly in the pitch. (3) "Quote in <10 min" — speed-to-quote is the carrier
  KPI. (4) Their AI-liability launch = pick an *underserved emerging risk class* incumbents underprice.

**Net adjustments to conviction (no new tracks — reprioritization):**
1. **Document/email intake (Theme A keystone / Track 14 "Document intelligence")** — now validated by
   *all four* non-carrier peers leading with unstructured→structured. Unanimous next build; remains #1.
2. **Model-governance surface (Theme C + Track 14 AIProvenance/telemetry)** — promote from "reframe"
   to a *named, shipped surface*; Tesora shows it's a sellable feature line, and it's where we're
   genuinely ahead.
3. **Carrier-quote comparison + proposal generation (Theme A #4)** — highest-frequency broker ritual
   (Outmarket's flagship); mostly deterministic over existing `coverage_terms`; pair with the A&B
   sublimit diff for a wedge Outmarket's horizontal product can't match.
4. **Outbound action arm (Track 5/8)** — Adapt proves the broker's-own-tools boundary is a whole
   company; the Slack/email nudge agent is more central than its backlog placement implies.
5. **Pitch hygiene** — (a) lead with "intelligence," not "record"; (b) quantify time saved; (c) name
   the two non-eng gates out loud: **carrier connectivity** (Adapt's whole business) + **licensing/
   regulatory approval** (Corgi's real moat) bound how far the "we are the carrier" claim goes today.

Sources: adaptional.com · adaptinsurance.com · ycombinator.com/companies/tesora · outmarket.ai
($17M Series A, PRNewswire 2026-05-13) · ycombinator.com/companies/corgi-insurance ($160M Series B,
SiliconANGLE 2026-05-06). NB: the **Corgi** in the job-pipeline memory is a *different* (ETF-ops)
company; the relevant one here is corgi.insure.

#### Geographic validity — CA / SF vs the NYC-coded thesis (2026-06-10)

Research question: is the project valid for SF, and who already plays there? Verdict: **valid, but the
liability *engine* differs — re-point, don't rebuild.** The platform is accidentally **NYC-*coded***
(dram-shop framing, `elsewhere-brooklyn` seed, NY-only SL tax), but the architecture serves CA cleanly.

**The load-bearing legal wrinkle — CA dram-shop immunity:**
- **CA Civil Code §1714** broadly **immunizes** bars/restaurants from over-serving/liquor liability
  ("furnishing alcohol is not the proximate cause"); lone real exception = serving an *obviously
  intoxicated minor*. NY is the opposite (dram-shop live + central). → **The over-serving/liquor-
  liability framing that anchors the NYC pitch largely evaporates in CA.**
- What *replaces* it (and is arguably a stronger fit): **negligent security + assault & battery + the
  new DFSA regime.** CA A&B is identical to NYC ($250K–$500K sublimits, hard market >40% alcohol,
  ~$90K premium on $1.6M sales). Negligent security is the *live* theory in CA precisely because
  dram-shop is off the table — and we already capture `security_response` on incidents (the
  negligent-security defensibility record, Track 7c). **Premium-reward loop is stated outright by CA
  insurers** ("risk-control measures — training/security/surveillance/occupancy — lower premiums";
  "3 yrs no A&B claims → better market") — the one thing the NYC research *couldn't* confirm.
- **New net-new surface:** CA **drink-spiking / DFSA / gender-based-violence laws** (effective
  **2025-07-01**) impose fresh documentation duties on venues. Greenfield — nobody has tooling.

**CA competitor map — three fragmented layers, none span the bridge (the wedge holds in CA):**
- **L1 Insurance distribution (crowded, traditional, no AI/evidence):** RMS Hospitality Group,
  Entertainment Risk (program administrators); JVRC, Western Pacific, Mighty Oak (SF), Anvo, XINSURANCE
  — real nightlife-A&B programs. → **compete-with or feed-into**; the cleaner near-term CA wedge is the
  evidence/defensibility layer that *feeds* these programs, NOT "a better nightclub MGA."
- **L2 Venue-safety software (capture, no insurance bridge):** ★ **CSA360** (incident reporting w/
  photo/video/doc upload + live maps — closest analog, **watch it**); Noggin, Momentus WeTrack,
  Omnilert, 247Software. → differentiate on the insurance/underwriting/claims-defensibility bridge they
  lack (= the prior national "Solink/LevL360 non-insurance tools" category).
- **L3 Safety advocacy / DFSA (demand-drivers, *partners not competitors*):** The Night's Watch SF;
  Good Night Out (UK); Safe Bars (Richmond). → they *create* the DFSA documentation demand and do
  training/culture, no product. **The Night's Watch = plausible design partner + distribution channel.**

**Net adjustments / new items (re-pointing, mostly existing primitives):**
1. **Multi-state SL: add CA** — the NY-only SL-tax module (the 3.6% correctness story) needs CA SL tax
   (~3%) + stamping; generalizes the named-scope "multi-state SL (NY only)" gap. Deterministic state-
   rules table (SL-tax module pattern).
2. ★ **CA DFSA / drink-spiking compliance module** — net-new deterministic state-rules + documentation
   surface (sibling of SL-tax + compliance-deadline engine); first-mover, on-thesis.
3. **Re-anchor the CA pitch** on negligent-security + A&B + DFSA; drop dram-shop/over-serving for CA.
   Lead with `security_response` defensibility + the premium-reward loop CA insurers state outright.
4. **SF demo seed** (SF venues + Entertainment-Commission permit context) for any Bay-area
   conversation — the seed/prospects are NYC today.
5. **Partner posture:** treat The Night's Watch as design-partner/demand-signal, not a build target.

**Honest risks:** L1 incumbents (RMS Hospitality, Entertainment Risk) are real + specialized → head-on
distribution competition is the harder path; **CSA360** is the one to watch on the capture side; the
whitespace is partly *because* the niche is small/fragmented (validation cuts both ways).

Sources: nolo.com / portersimon.com (CA §1714 dram-shop) · wpinsure.com + insurancejournal.com
(CA bar A&B market) · 48hills.org (DFSA laws, 2025-07-01) · rmshg.com + entertainmentrisk.com (L1) ·
csa360software.com (L2) · thenightswatchsf.org (L3).

#### Appendix — full persona pain-point detail (research, 2026-06-09)

Complete enumerated findings from the parallel persona research, sourced to 2024–2026 industry
material. One line each: **pain** — why it hurts → AI/data approach.

**Broker / wholesale / MGA:**
1. **Unstructured email/PDF/SOV/loss-run intake** — ~40% of time re-keying (47 min/quote manual vs ~11 automated); 82% would drop a slow broker → extraction + classification + field confidence scoring.
2. **Carrier appetite matching** — "from memory + Rolodex"; long-tail markets under-shopped, declines burn goodwill → structured appetite guides + LLM match + rank by bind-likelihood.
3. **Loss-run extraction & normalization** — dozens of inconsistent carrier formats delay renewals → extraction + normalize → existing loss-ratio engine (audit trail = edge).
4. **Surplus-lines multi-state tax filing + diligent-search** — ~840 hrs/yr/200 policies; top rejects: wrong rate 38%, missed deadline 29% → deterministic rate/deadline/form rules + LLM affidavit assembly + correctness verification.
5. **COI issuance + endorsement reconciliation** — 4.2 COIs/policy/yr, 45–90 min each, 1.8% list AIs never endorsed (E&O driver) → auto-gen from policy + reconcile cert language vs endorsement schedule.
6. **Market submission follow-up/chasing** — silent-underwriter problem, deadlines slip → agentic placement tracker: per-market state, drafts follow-ups, parses responses.
7. **Missing-info / NIGO chase** — incomplete submissions, ~1 hr chasing a single DOB → completeness checker at intake vs required-field rules + auto-draft request.
8. **Carrier-quote normalization + comparison + proposal** — differing quote letters hide sublimit/exclusion traps → extract → normalize → diff coverages → generate proposal.
9. **Renewal remarketing trigger** — manual, started too late (need 90–120 days) → pipeline flags at-risk renewals (rate Δ, loss-ratio shift, market exits) → kicks the intake→appetite→submit chain.
10. **Hospitality liquor + A&B placement intelligence** — hardest-to-place class, state dram-shop variance, sublimit/exclusion traps → class-specific appetite + state knowledge + coverage-gap checker.

**Underwriter / carrier:**
1. **Submission triage & clearance** — ~60% never fully reviewed, ~25% bound; triaged by arrival not quality → extraction + LOB/class classify + dedup/clearance + scored "work-me-first".
2. **~40% admin/re-keying** (unchanged since 2008) → extraction agents + auto-populate + agentic chase via the request-info loop.
3. **External-data gathering for risk selection** — fragmented, manual → enrichment pipeline + entity-linked risk signals + provenance, feeding score + memo.
4. **Appetite/eligibility inconsistency & leakage** — single largest 12-mo ROI item → deterministic rules alongside scoring; violations auto-route to referral w/ cited rationale (NAIC governance edge).
5. **Rate adequacy under social inflation** — 2024: 135 nuclear verdicts (+52%), $31.3B (+116%) → jurisdiction-aware loss-cost + trend factors + rate-inadequacy eval scorers.
6. **Hospitality A&B controls assessment** — manual from narratives; acceptance hinges on controls not form → extract/score venue controls + incident history + state dram-shop posture (ties to evidence layer).
7. **Renewal re-rating on changed exposure** — can't see what materially changed → period-over-period entity diff (snapshot-hash) + surface deltas + auto-propose re-rate.
8. **Exposure/accumulation management** — periodic, misses cross-class aggregation → aggregate bound book by geo/peril/class + threshold alert at bind.
9. **Referral & authority workflows** — opaque, slow, "why" not captured → authority rules + auto rationale + routing/SLA (maps to lifecycle/audit machinery).
10. **AI veracity & explainability** — gating adoption blocker; NAIC Bulletin in 25 states (Mar 2026) → field-level confidence + human-in-loop + eval scorers + provenance (the moat).
- *Bonus (MGA):* delegated-authority bordereaux oversight → normalized, audit-ready DA reporting + portfolio monitoring.

**Claims adjuster / SIU:**
1. **Reserves systematically under-set** — ~$7.3B adverse dev in other-liability 2025 → severity-development models + confidence-scored reserve vs adjuster + mismatch alert.
2. **"Sleeper" claims not flagged early** — 64% GL / 75% auto-liability litigants have counsel within 2 weeks → litigation-propensity scoring at FNOL (rides fraud-agent pattern).
3. **Coverage analysis manual** — A&B sublimits $25K–$300K, state-varying → LLM extract → coverage object + "does the policy respond?" agent (hospitality wedge).
4. **Claims leakage 7–14%, poorly measured** — 40%+ carriers cite it top challenge → LLM-as-judge over closed files → leakage as a measured KPI.
5. **Medical/demand-package review bottleneck** — up to 30% of time, 1,000-pg file = 10–20 hrs → summarization/chronology w/ page citations (extends defense-package/vision).
6. **Subrogation identified too late** — up to $15B/yr missed; early-ID = +20–40% recovery → NLP+graph+vision third-party-fault scoring at FNOL.
7. **Litigation management black box** — #1 friction is accurate exposure analysis from counsel → extract invoice/case signals + benchmark counsel exposure vs realized (calibration).
8. **Organized fraud rings** — per-claim scoring misses networks → entity-graph across claims/providers/attorneys (extends 2-pt fraud agent; cross-venue repeat A&B claimants).
9. **FNOL intake quality inconsistent** — bad inputs corrupt everything downstream → AI FNOL: complexity/severity in 15–30s + completeness + coverage/litigation/subro triggers.

**Actuary:**
1. **Data wrangling = #1 time sink** — only 42% have a single source of truth → ETL/pipeline + canonical loss/exposure model + LLM column-mapping (your strongest axis).
2. **E&S loss runs/bordereaux unstructured** — 30–50% of quoting time is pre-parse mechanics → doc extraction → structured rows + format-variant detection.
3. **Reserving backward-looking, spreadsheet-bound, failing** — adverse dev concentrated AY2022–24 → *net-new* triangle + chain-ladder + BF/Cape Cod + Mack/bootstrap engine; auto CL-vs-BF divergence.
4. **Social-inflation trend outruns pricing** — stale trend poisons rate + a-priori loss ratio → data-fusion internal+external trend + flag divergence (extends risk score/rate-adequacy).
5. **Rate-filing mechanics >50% of effort** — SERFF transmission only → LLM-gen exhibits/memoranda grounded in pricing engine (eval = reproducibility for ASOP/state).
6. **Model governance under NAIC AI Bulletin** (~23–25 states) — lineage/validation/explainability on demand → reframe eval harness as governance-evidence generation (best fit to existing assets).
7. **Experience & exposure rating manual** — blend two methods by hand, ad hoc limit-drift → *net-new* dev/trend/on-leveling + ILFs/exposure curves + layer blending on pricing engine.
8. **Analysis periodic not continuous** — emerging signals caught a quarter late → continuous pipeline (Dagster) incremental recompute + threshold alerts.
- *Gap map:* net-new = reserving engine, experience/exposure rating, continuous monitoring; eval harness reframed for governance (#5/#6) is where you're *ahead* of incumbents.

**Insured / venue operator (your direct user):**
1. **Premiums doubling, capacity vanishing** for liquor + A&B (25–40% hikes; carriers exiting KY/TX/MN; venues shuttering) → calibrated score + evidence trail to shop E&S as a *preferred* risk + auto submission packet.
2. **Can't prove they're a good risk** — underwriting is a black box they enter empty-handed → ★ underwriter-facing risk/loss-control dossier (camera map, retention attestation, training, refusal logs, declining-severity trend).
3. **Incident docs disintegrate before claim** — claims arrive 12–24 mo later, footage overwritten in days → hashed-evidence + defense PDF; push capture-at-moment + preserve nudges + deposition-grade chain-of-custody.
4. **Don't understand coverage / underinsured** — 69% can't interpret coverage, 77% underinsured → policy-intelligence in copilot: ingest dec page, extract sublimits/exclusions, answer "am I covered if a bouncer breaks someone's arm?" + gap-flag vs their incident pattern.
5. **Claim disputes & post-incident non-renewal** — 40% of liquor claims → non-renewal/hike → claims-dispute rebuttal assembly + loss-history narrative generator for shopping.
6. **COI / additional-insured churn** for events/vendors/landlords → COI request/issuance + inbound-vendor-COI verification vault + expiry alerts.
7. **Compliance-deadline lapses** — license/permit terms, $50/day late (OK), license termination at 60 days (AZ) → deadline engine + 90/60/30 reminders + link to score/dossier.
8. **No agent in the loop, buying blind** — 60% buy without an agent → copilot as "broker brain": plain-language terms, limit benchmarking, produces the shopping packet.

---

### 13. Security & hardening (added 2026-06-09, code audit)

Robustness audit finding: the *enforcement* layers (require_* gates, lifecycle transitions, eval
gates) are rigorous, but entry points and ops robustness lag behind. P0 first; everything here is
subscription-free.

- [x] **★ P0 — `/register` privilege escalation — FIXED 2026-06-09.**
  `RegisterRequest.role` was client-supplied and unvalidated: anyone could POST `{"role": "carrier"}`
  (or broker/admin/staff) and mint a privileged token bypassing every `require_*` gate. Fix:
  **removed `role` from `RegisterRequest`** (Pydantic drops a posted role) and the `/register` route
  now hardcodes `register_user(..., "venue_operator", ...)` — `register_user` itself stays
  role-flexible for the future authed admin/seed path. RED→GREEN regression test
  (`tests/test_register_role_escalation.py`: 4 escalation params × carrier/broker/admin/staff +
  default-is-operator, asserts both the user record **and** the minted token are venue_operator).
  **Sibling-path audit (done):** the only client-controllable role-minting path was `/register`;
  `login` reads role from the authenticated DB record, `seed_users` uses the server-side `DEMO_USERS`
  constant, and `create_staff_account` hardcodes `role="staff"` behind a venue-ownership gate. Front
  door closed too: removed the broker/carrier role picker from the web signup form
  (`login/page.tsx`) + mobile `RegisterScreen` (public sign-up = Venue Owner; demo personas reach
  broker/carrier via demo buttons), and the e2e `LoginPage.register` helper. Privileged accounts are
  still provisioned only out-of-band (Track 15 admin surface remains the proper path).
- [x] **★ P0 — path traversal in evidence upload — FIXED 2026-06-10.** `api/v1/evidence.py` built the
  storage key as `f"{evidence_id}_{file.filename}"` with the **client-controlled** filename
  unsanitized — a `../`-bearing filename escaped `evidence_uploads/` (the `evidence_id` prefix only
  neutralizes the *first* `../` segment; the var named `safe_name` didn't earn it). (Storage's
  `_resolve_within_base` already blocked the *write* with a `ValueError` → ugly 500, and S3 keys went
  unsanitized entirely.) Fix: one `_sanitize_filename` helper — basename (strips `/` **and** `\\` so it
  holds on any server OS), strips control chars (CRLF/NUL) + quotes, drops leading dots so bare `..`
  can't survive — applied to the storage key, the stored `EvidenceFile.filename`, **and** re-applied at
  serve to `Content-Disposition` (defense-in-depth for pre-fix rows / header injection). RED→GREEN:
  `tests/test_evidence_path_traversal.py` (traversal basename + backslash separators + header injection).
- [x] **P0 — unauthenticated `/api/debug/llm-provider` — DONE** (verified 2026-06-10): the route at
  `main.py:553` is now gated `dependencies=[Depends(require_broker)]`.
- [x] **P0 — CORS no longer trusts all of `*.vercel.app` — DONE** (verified 2026-06-10): the
  `allow_origin_regex` at `main.py:492` is pinned to `https://nightline-app[a-z0-9-]*\.vercel\.app`
  (this project's own preview subdomains) + the `exp://` LAN pattern, not the whole shared domain.
- [ ] **Upload content-type validation** — size limits exist (20MB image / 200MB video,
  `evidence.py:30-31`) but MIME type is client-supplied: no magic-byte sniffing, no extension
  allowlist; arbitrary bytes labeled `image/png` flow into vision analysis. Add server-side sniff +
  allowlist. (Was deferred "verify-first" — limits verified present, type validation verified absent.)
- [x] **`DATABASE_URL` startup guard — DONE** (verified 2026-06-10): `validate_startup_env()`
  (`config.py:37`) now fails fast in prod when `DATABASE_URL` is unset, so a prod boot can no longer
  silently fall back to ephemeral SQLite.
- [ ] **Rate limiting** — none anywhere in `backend/`. Login is brute-forceable and `/copilot` lets
  any token burn the LLM quota (the Groq 429 problem is partly self-inflictable). slowapi (or a
  small middleware) on auth + copilot endpoints first, then global sane defaults.
- [ ] **Account lockout / failed-attempt throttling** on login (pairs with rate limiting; no
  failed-attempt tracking exists today).
- [ ] **Token revocation** — JWTs are stateless with no `token_version`/denylist; password change
  doesn't invalidate existing sessions. Add `token_version` on `UserRecord`, embed in the token,
  bump on password change + a "log out everywhere" action.
- [ ] **Idempotency keys on money mutations** — reserve/payment POSTs have no concurrency control
  (double-submit race on Postgres). The pattern already exists (copilot act tools, ClaimProposal
  dedup) — generalize to all money-mutating endpoints. **Sibling (2026-06-10 audit): row locking** —
  `record_payment`/`record_carrier_reserve` read running totals into Python, add, write back
  (`services/claims.py:342`) with no `SELECT … FOR UPDATE`; concurrent payments on one claim can lose
  an update (same shape on `Policy.annual_premium` during endorsements). Add `with_for_update()` on
  the money rows (no-op on SQLite, real on Postgres) in the same pass.
- [ ] **Hash-chained audit ledger** — snapshots are hashed but audit events themselves are mutable
  rows. Chain each event to the previous event's hash → tamper-evident trail; directly upgrades the
  "deposition-grade chain of custody" pitch. (Human-readable viewer = Track 15.)
- [ ] **Pagination on list endpoints** — only incidents/packets/ingestion_runs take limit/offset;
  venues (291 rows), claims, submissions, work queue are unpaginated. Payload/perf cliff grows with
  every demo seed.
- [ ] **Observability floor** — request-ID middleware + structured error logging (+ Sentry free
  tier when wanted). The Groq 429 went undetected until Railway log-spelunking; this is the fix
  class for that whole failure mode.
- [ ] **Deep health check** — `/api/health` (`main.py:494`) should ping the DB; a 200 while Neon is
  asleep is worse than nothing for uptime probes / keep-warm.
- Deferred (CORS + upload validation promoted to open items above after 2026-06-10 verification):
  **Alembic migrations** — the `_COLUMN_MIGRATIONS` allowlist works but the 2026-06-10 audit ranks
  it the **#1 structural production gap** (ADD-COLUMN-only, failures swallowed by bare
  `except: pass`, no renames/type-changes/backfills possible); pair with Track 4's Postgres test
  lane when taken up. 2FA (backlog-worthy for an insurance platform, not urgent). **Backup/DR
  runbook** — no documented Neon restore path; seeds rebuild *demo* state only, real operator
  incidents/evidence/claims currently have no recovery story (and evidence files are ephemeral
  until the R2 env vars are set). Module-level **`VENUES` global mutated at runtime**
  (`main.py:293,510,529`) — process-local state that diverges under >1 worker; revisit with any
  worker-scaling work. **Background job queue** (2026-06-10 audit P2) — vision/corroboration run
  via in-process `BackgroundTasks`, so a wedged LLM call ties up a web worker; a real queue
  (Arq/RQ) only when LLM volume justifies it (note the risk grows once keys + retries land).

### 14. AI-native productionization (added 2026-06-09)

Gap audit vs the "solid AI-native insurance product" bar. Verdict: **offline** AI rigor is
world-class (evals, baselines, CI gates, faithfulness guard) — **online** rigor is ~zero. The
product doesn't record, monitor, or learn from its own AI outputs in prod. Close the online half.
All subscription-free except 🔒.

- [ ] **★ AI provenance stamping** (~1 day) — `CopilotReply`, memo, and fraud outputs record
  nothing about what produced them (verified: no model/provider field anywhere in the schemas).
  Stamp `model`, `prompt_version`, `input_hash` into each AI artifact + its audit event — the
  sibling of `decision_source`. Converts Theme C (NAIC governance) from "reframe" to
  *demonstrable*: every AI output carries its lineage.
- [ ] **★ Online LLM telemetry** — `LLMCallRecord` (provider, model, tokens, latency, fallback?,
  error class) + a live strip on `/evals`. Yields the **fallback-rate metric** that would have
  caught the prod Groq 429 degradation on day one. Subsumes Track 11's startup provider-log item.
- [ ] **★ Correction flywheel** (the differentiator) — human overrides of AI suggestions (carrier
  edits memo premium, operator rejects copilot answer, adjuster overrides reserve hint) currently
  *vanish*. Build the pipe: override captured → labeled eval scenario → gold set grows from prod →
  baselines re-gate. Both ends already exist (audit events capture overrides; harness consumes
  scenarios). Generalizes override-calibration beyond risk scores. This is what separates "product
  with AI features" from "AI-native product."
- [ ] **Copilot streaming (SSE) + feedback affordances** — answers currently arrive as a block
  (verified: no streaming in `api/v1/copilot.py`); add thumbs-up/down + "suggest a correction"
  (which is also the flywheel's capture point). Non-streaming AI chat reads prototype in 2026.
- [ ] **Closed-loop MEASURE → RECALIBRATE** — the Risk Intelligence loop today is
  SURFACE→RECOMMEND→ACT only; the measuring/recalibrating phases from the design doc are unbuilt.
  (SP4 LLM-as-judge slots here, 🔒 for the judge model.)
- [x] **★ Vision-agent contract + eval gate — DONE 2026-06-10.** The vision agent was the **only
  ungoverned LLM-factual-output path** (`vision_agent.py` runs Gemini 2.5 Flash on uploaded media →
  injury detail / crowd density / security / hazards → **risk scoring AND fraud detection**), with the
  prompt inline and no `.md`/eval. Shipped, mirroring the **fraud-agent precedent** (standalone
  contract, *not* `REQUIRED_CONTRACTS` — vision runs in the evidence pipeline, not the packet runtime,
  so the 5-agent trace test stays intact): `app/agents/vision_agent.md` (runtime status + output
  contract + honesty invariant) + `app/evals/vision_scorers.py` (deterministic, **key-free**, sibling
  of `fraud_scorer.py`) with three scored dimensions — **routing** (summary → correct finding family),
  **honesty** (template path always `_stamp_unverified`'d → can't claim unperformed corroboration), and
  **mapping** (the Gemini→dataclass clamp forces `security_response_seconds`/`timestamp_in_exif` to
  None and binds `confidence_delta` to the verdict, so the LLM can't inject score-moving integrity
  fields). RED→GREEN `tests/test_vision_eval.py` (3 tests, all 1.0); `agents/README.md` TODO closed.
  **Pytest-gated like its siblings** (fraud/comms/intelligence) — promotion into the
  `--compare-baseline` CI gate is the batched recommended-order #6 item, not per-scorer here.
- [ ] 🔒 **One reliably-live LLM path in prod** — the deterministic floor is a floor, not a ceiling:
  prod copilot currently template-falls-back on *every* question. Now: Groq model swap + gating +
  retry (Track 11 ops/code). With keys: small-budget `ANTHROPIC_API_KEY` (Haiku covers demo traffic
  for single-digit $/mo) as the dependable path.
- **Document intelligence — the big build** = Track 12 Theme A keystone (inbound email/PDF/loss-run
  intake). THE table-stakes AI-insurance capability and the largest AI-native hole. **First slice
  shipped 2026-06-11: loss-run extraction v1** (CSV+xlsx → confidence-scored review-only artifact,
  deterministic + key-free + LLM seam reserved — see Theme A above). The deterministic-first pattern is
  now proven end-to-end; remaining intake surfaces (inbound email, PDF/OCR, SOV, ACORD) extend the same
  `readers → parser → review-only artifact` spine. A real key only raises the quality tier (PDF/OCR).

### 15. Platform basics (added 2026-06-09)

Product table-stakes that are absent regardless of persona. One consolidated track; most items are
good filler between bigger tracks.

- [ ] **Admin / back-office surface** — list users, assign roles (the privileged-role creation path
  Track 13's P0 requires), correct bad data without raw DB access.
- [ ] **Global search** — jump to venue/policy/claim/submission by name or number (`SearchInput` is
  a list filter, not search). The most visible daily-usability gap + an easy demo win.
- [ ] **Audit-log viewer** — human-readable per-entity timeline over the audit trail. The expensive
  half (emitting + hashing events) is done; this is the cheap half that shows it off.
- [ ] **Demo reset** — one-click reset-to-clean-demo-state (the idempotent seeds exist; wrap them).
  De-risks live demos — a recruiter clicking around can't poison the data.
- [ ] **Unified notifications inbox + per-user notification preferences** — AlertEvent/BrokerTask/
  push exist but there's no "what needs me" feed and no prefs UI. (Overlaps Track 5's
  inbox-unification item — same build.)
- [ ] **Onboarding / first-run** — a new operator account lands on a bare dashboard; guided "add
  your venue / upload your policy" path.
- [ ] **★ Data export suite — "meet them in Excel" (expanded 2026-06-10).** Loss-run CSV is the
  ONLY export today, but spreadsheets are where brokers/underwriters/actuaries actually live —
  adoption means exporting to their world, not forcing dashboards on them. Enumerated exports, all
  cheap over existing services: **book financials** (per-carrier/per-line rows), **expiration /
  renewal X-date list**, **quote-comparison sheet** (rides the promoted Theme A item), **claims
  history beyond loss-run**, **bordereaux** (Theme G's born-clean export when built), and an
  **exportable rating worksheet** — the deterministic `pricing.py` calc as a "show your work"
  sheet (Excel raters are the underwriter idiom; ours being transparent + reproducible is the
  correctness pitch in artifact form). Cross-ref Track 5's scheduled/periodic report item — same
  build, add a cadence.
- [ ] **Empty/error/loading state sweep** — make 7c's broker-dashboard finding systematic across
  surfaces (a failed fetch should never render as healthy-empty).
- [ ] **★ Shared web fetch wrapper (2026-06-10 audit)** — 42 web files hand-roll raw `fetch` +
  `authHeaders()`; many lack a `.catch` that clears `loading`, so the documented
  CORS-less-500 → infinite-spinner class persists, and only ONE request in the whole app has an
  AbortController timeout. Mirror `mobile/src/api/client.ts` (which got this right): one client with
  auth attach, `res.ok` check, timeout, normalized errors → swap call sites incrementally. Kills the
  upload-`authHeaders()` footgun class at the seam too (see `project_web_upload_auth_pattern`).
  Riders while in there: **mount the existing-but-unused `ErrorBoundary.tsx`** in AppShell (0
  importers today — render throws rely solely on `app/error.tsx`, whose "Back to dashboard" is also
  wrong for non-broker personas); **delete or adopt the dead generated `src/api/` OpenAPI client**
  (0 importers — don't keep both patterns).

---

### 16. UI/UX consistency pass (added 2026-06-09, ui-ux-pro-max audit)

Audit verdict: the design system is healthy (token discipline near-total; 12 reduced-motion + 16
focus-visible guards; 108/59 aria/accessibility labels; 85 skeleton refs; layouts cascade clean).
The gaps are **interaction patterns**, not visuals. One focused session for items 1+2+4+5.

- [ ] **★ Replace `window.prompt`/`window.confirm` on money/lifecycle actions — 8 files** (7c
  undercounted it as one): `policies/[pid]` (cancel w/ free-text date prompt!, assign number,
  expire/lapse/reinstate), `policy-requests` (decline reason), `coverage` (withdraw), + others;
  even `claims/ActionModal.tsx` uses `window.confirm` for discard. Build one shared
  `ConfirmDialog` + validated `FormDialog` (reason/date), swap all call sites. Mobile's
  `Alert.alert` is the correct platform idiom — leave it.
- [ ] **Toast/feedback system** — no consistent success/error feedback after mutations. Small
  toast w/ `aria-live="polite"`, auto-dismiss 3-5s; rides with the dialog work.
- [ ] **Mobile Copilot screen** — web `/copilot` has no mobile counterpart; biggest web↔mobile
  parity break and it's the flagship AI surface. Schedule with the next copilot session
  (streaming/feedback work, Track 14) so it's built once, current. **Rider (2026-06-10 audit):
  transcript persistence** — chat state is in-memory `useState`; a refresh wipes the conversation.
- [ ] **Unsaved-changes guards on web forms (2026-06-10 audit)** — exactly one page
  (`submissions/[sid]`) has a dirty-state guard; `submissions/new`, `policies/[pid]/endorse`,
  `certificates/new`, `claims/new`, venue create all lose everything on nav/refresh. Mobile FNOL's
  SecureStore draft pattern is the reference implementation; web needs at minimum
  dirty-state + `beforeunload`.
- [ ] **Nav config drift (2026-06-10 audit)** — web `AppShell` nav groups and mobile
  `TabNavigator` are hand-synced (the comment at `TabNavigator.tsx:46-48` admits it). Extract a
  shared nav manifest (route, label, personas) both consume, so persona-IA changes can't fork.
- [ ] **Mobile tabular numerals** — web 72 `tabular-nums` uses vs mobile 5; money columns on
  Book/Portfolio jitter. Add `fontVariant: ['tabular-nums']` to shared numeral styles.
- [ ] **Token strays** — web: `alerts/page.tsx` (4 raw hex, the 7c item) + `MarketMap.tsx` (5);
  mobile: `BrokerPortfolioScreen` + `IncidentDetailScreen`. Map to theme tokens.
- [ ] **Verify `/evals` + `/market` nav affordance** — both are intentionally AppShell-less
  (public surfaces); confirm each has a visible home/back link so visitors aren't stranded.
- [ ] **Web register decision** — mobile has `RegisterScreen`, web has no signup page. Decide
  *after* Track 13 P0 closes the role-escalation hole (don't widen the front door first).
- Cross-refs still open: MobileBottomNav broker tabs + orphaned broker `/incidents` + `/claims`
  dual-design split (7c); empty/error-state sweep (Track 15).

---

## Gated — needs an account/keys (revisit when available)

See [`go-live-readiness.md`](./go-live-readiness.md) for detail. Summary:
- [x] Object storage (S3/GCS) — `S3Storage` **implemented** (boto3, `STORAGE_BACKEND=s3`), Stubber-tested. Only remaining step is ops: create a bucket (Cloudflare R2 free tier) + set the four `S3_*` env vars on Railway. Was the biggest real blocker (Railway FS is ephemeral → evidence/PDFs vanish on redeploy).
- [ ] 🔒 Email provider (Resend) — set `RESEND_API_KEY` + `FRONTEND_URL`, verify domain. Unlocks:
  reset emails, operational `AlertEvent` email routing (Track 5), the follow-up/chase agent's
  outbound arm (Track 8), claimant first-contact comms (Theme G).
- [ ] 🔒 LLM live mode — `ANTHROPIC_API_KEY` (small budget; Haiku covers demo traffic for
  single-digit $/mo) or keep Groq w/ the Track 11 fixes. Unlocks, in leverage order: **reliable prod
  copilot** (Track 14), memo LLM upgrade behind the faithfulness scorer (Track 9 fast-follow),
  document-extraction quality tier (Theme A keystone), sufficiency judge (Track 8), SP4
  LLM-as-judge / claims-leakage KPI (Track 14 MEASURE + Theme C), real-embedding vector RAG delta
  (Track 10's pitch number).

  **Key-day order of operations (added 2026-06-10, keys planned):**
  1. **BEFORE any key lands:** debug-endpoint auth (Track 13 P0 — it burns a live LLM call
     unauthenticated), copilot rate limiting, and LLM telemetry **with token/cost fields**
     (Track 14) — protect and *see* spend from day one, not after the first surprise bill.
  2. **`GEMINI_API_KEY` only AFTER the vision-agent contract + eval gate ships** (order #3) —
     setting it today activates the one ungoverned LLM-factual path (vision findings → risk
     scoring + fraud) with zero evals. Gate first, then key.
  3. **What lights up code-free with `ANTHROPIC_API_KEY`:** the packet agents' memo + risk
     classifier (`app/providers/anthropic_provider.py` is a real Haiku implementation,
     resolution Anthropic → Gemini → deterministic) and the nightly `evals-matrix` Anthropic
     lane (secrets-gated, currently skipping).
  4. **What does NOT light up — known trap:** the copilot's
     `app/copilot/anthropic_provider.py` is a **stub that delegates to deterministic**
     (`v1 delegates … until the Messages-API call is implemented`). Selection order:
     `COPILOT_LLM_*` (Groq) wins if set; otherwise `ANTHROPIC_API_KEY` routes to the stub →
     **setting the Anthropic key and dropping the Groq vars leaves the copilot silently
     deterministic** — the exact silent-fallback class Track 14's telemetry exists to catch.
     Implement the Messages-API call (small: mirror `_respond_llm`'s tool-pick + synthesis +
     same faithfulness guard) as part of key-day.
  5. **Demoted once a paid key exists:** the Groq `llama-3.1-8b-instant` model-swap ops item
     and "gate LLM to why-questions" (Track 11) become cost optimizations, not survival fixes;
     429 retry logic stays (good hygiene on any provider).
  6. **Jumps in priority:** LLM-as-judge + judge-vs-human agreement (recommended order #6)
     fully unblocks; Track 10's vector-vs-TF-IDF NDCG delta becomes measurable (the pitch
     number); SP4 / claims-leakage KPI becomes startable.
- [ ] 🔒 Inbound email infra (Resend inbound / Cloudflare Email Routing — free tiers exist) — the
  delivery rail for the Theme A inbound-email keystone; the extraction core itself can be built +
  eval'd subscription-free against fixture emails first.
- [ ] 🔒 Sentry (free tier) — drop-in once the Track 13 observability floor (request IDs,
  structured errors) exists.
- [ ] 🔒 A real operational connector (e.g. scheduling/POS) — the `staffing` slot is the cheapest real-API swap; a real POS feed also powers the Theme G premium-audit wedge.
- [ ] SMS (Twilio), payments (Stripe), loss-run ingestion — only if v1 scope expands.

---

## Recommended order

Updated 2026-06-10 after the **five-agent external audit** (sourced market research + backend /
frontend-mobile / AI-eval / ops code audits). What changed: Track 13 gained three security P0s
(path traversal, debug endpoint, CORS) + the row-locking sibling; Track 4 gained the CI-wiring bug
+ the Postgres-fidelity lane; Track 15 the shared web fetch wrapper; Track 12 the market caution +
named scope gaps. Market research **confirmed the pitch leads** (A&B/liquor crisis, E&S/ELANY
burden, broker re-keying/turnaround, social inflation = all validated-severe; operator↔broker
bridge = unoccupied white space) and **flagged one reframe** (documentation→premium-discount is
unvalidated — sell defensibility, not cheaper premiums). Everything below except 🔒 sub-items is
subscription-free.

0. ✅ **DONE 2026-06-10 — security/correctness P0 sweep (Track 13 + 7c):** evidence-upload **path
   traversal** fixed this session (RED→GREEN `test_evidence_path_traversal.py`); auth on
   **`/api/debug/llm-provider`** (`require_broker`), **CORS origin pinning** (own-subdomain regex),
   **`DATABASE_URL` startup guard** (`config.py`), and the **7c A&B field drop** in `incident_flow.py`
   were all verified already-shipped. Next P0-class items now live under Track 13 hardening core
   (rate limiting / lockout / token revocation / idempotency + row-locking / upload content-type sniff).
1. ✅ **DONE 2026-06-11 — CI honesty fixes (Track 4):** CI now runs the real Vitest suite + `eslint`
   on the frontend (commit `d1df145`), and the **Postgres-fidelity lane** is live (commit `404861b`,
   which also fixed FK-ordering bugs it caught). Stale "next" pointer retired — the real next
   substantive item is #2 (copilot thread).
2. **Finish the Copilot thread** (Track 11 + the Track 14 riders) — (a) *ops, you:* swap
   `COPILOT_LLM_MODEL` → `llama-3.1-8b-instant` on Railway; (b) LLM gating + 429 retry/caching;
   (c) while in the provider/UI files: **streaming + feedback buttons + LLM telemetry**
   (Track 14) — same code surface, one session. Audit framing: prod copilot is currently
   deterministic-only on every question; telemetry turns that from a silent liability into a
   measured fallback-rate you can demo.
3. ✅ **DONE 2026-06-10 — Vision-agent contract + eval gate** (Track 14 ★): `vision_agent.md` +
   `app/evals/vision_scorers.py` (key-free routing/honesty/mapping scorers) + `test_vision_eval.py`,
   mirroring the fraud-agent precedent. The last ungoverned LLM-factual path is now contract-bound +
   eval-gated, so "every AI factual output is contract-bound + eval-gated" is literally true
   end-to-end. (Also the key-day prerequisite: `GEMINI_API_KEY` can now be set safely behind the gate.)
4. **Track 14 core — provenance stamping + correction flywheel** — ~2-3 days combined,
   subscription-free, and it upgrades *every already-shipped* AI feature (memo, fraud, copilot)
   from "has evals" to "auditable + learning in prod." The flywheel is the AI-native
   differentiator claim.
5. **Track 13 hardening core** — rate limiting + lockout + token revocation + money-op idempotency
   **+ row locking (`with_for_update`)** + upload content-type sniffing + hash-chained audit
   (Track 15 audit-log viewer rides along — it's the demo face of the chain).
6. **One calibrated LLM-as-judge scorer + a judge-vs-human agreement number** (SP4 slice, Theme C) —
   the audit's expert-credibility gap: every shipped scorer is heuristic (token-overlap / ladder /
   NDCG), so "is your judge calibrated?" currently has no answer. Stage the labeling + harness
   subscription-free; 🔒 the judge model itself. Also promote the intelligence/fraud/comms evals
   from pytest asserts into the `--compare-baseline` CI gate while in the harness (cheap
   consistency win — makes "all AI surfaces regression-gated" literally true).
7. **Operator risk / loss-control dossier** (Track 12 ★★, Theme F) — highest product-alignment,
   best pitch demo. **Reframed per the market caution:** the dossier sells claims-defensibility +
   loss outcomes + "shop E&S as a preferred risk," NOT premium discounts at bind.
8. **Quote-comparison sheet + proposal generation** (Theme A ★, promoted 2026-06-10) — the
   highest-frequency broker spreadsheet ritual, deterministic over existing
   `CarrierQuote.coverage_terms`; highlight A&B sublimit/exclusion deltas between quotes (the
   nightlife-broker artifact nobody else produces) + client-proposal PDF. Pairs with Theme D
   later; exportable via the Track 15 export suite.
9. **Inbound email/doc intelligence** (Theme A keystone = Track 14's big build) — the largest
   AI-native hole (zero doc extraction shipped). Deterministic-first extraction + LLM seam, eval'd
   against fixture emails — starts subscription-free; 🔒 inbound rail + key raise the tier later.
10. **Premium audit / continuous exposure monitoring** (Theme G ★) — best new domain wedge;
    POS connector + endorsement machinery already exist; deterministic and demo-able.
11. **Eval-harness → model-governance reframe** (Theme C) — amplified by #4's provenance
    stamping (lineage on every AI output is the evidence the NAIC bulletin asks for).
12. **Underwriting-memo eval fast-follows** (Track 9) — wire the 3 memo scorers into
    `runner.py`/`baseline.py`/`--compare-baseline` + `/evals`; graded `check_appetite` (7a/C6).

Then: **copilot fan-out multi-tool + causal-grounding guard** (Track 11 — unblocks "why is my
premium high?"), **shared web fetch wrapper** (Track 15 — or pull it into any frontend session;
it's the hung-spinner class fix), **policy-doc vector RAG** (Track 10 = SP3), **sublimit-aware
coverage analysis** (Theme D), **reserving engine** (Theme E), **policy checking + claimant
instrumentation + born-clean bordereaux** (Theme G), **C5/C4 carrier** (Track 9), **two-way
questions + agents** (Track 8), **Alembic migrations** (Track 13 deferred — take it with the
Postgres lane).

Good filler (no subscription): Track 15 basics (global search, demo reset, admin surface, the
"meet them in Excel" export suite — each export is small and pairs with whatever track touched
that data last), 7c polish, the Neon JSON-string correctness sweep (until #1's Postgres lane obsoletes it), Track 3
(deterministic memo quality), Track 4 E2E depth + `data-testid` seams, Track 16 dialog/toast pass.
Quick ops still pending: Groq model swap (#2a), seed prod adjuster demo, prod stale-incident
cleanup (Track 2 open item), R2/S3 env vars (gated list — the audit calls ephemeral evidence the
top deployment risk and the code is already done).
