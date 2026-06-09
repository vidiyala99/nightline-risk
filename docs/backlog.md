# Engineering Backlog

Working checklist for the subscription-free work (no API keys, no S3/email/SMS
accounts yet). Gated/integration items live in [`go-live-readiness.md`](./go-live-readiness.md).

Last updated: 2026-06-09.

---

## Recently shipped (context for picking back up)

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

### 1. Eval harness deepening  ★ headline / best pitch fit  — mostly already shipped (audited 2026-05-27)
- [x] Audit current eval scenarios + scoring — done. Harness is mature: 15 standard + 6 adversarial scenarios, 10 scorers (severity/citation/review-status/factor + NDCG@5/MRR retrieval + 3 safety).
- [x] ~~Add more research-grounded scenarios~~ — already 15 across 7 exposure classes (A&B, dram-shop, crowd, medical, premises, property, negligent-security) + 6 adversarial.
- [x] ~~Per-provider baseline snapshots + regression gate~~ — already stack-keyed (`baseline.py`); `--compare-baseline` exits 1 on any scorer drop.
- [x] ~~Scorecard on `/evals`~~ — already a full scoreboard (`frontend/src/app/evals/page.tsx`); reads `public/eval-baseline.json`.
- [x] ~~Wire/confirm CI gate~~ — already wired: `evals` + `evals-matrix` jobs in `ci.yml` run `--compare-baseline`.
- [x] Closed the last gap: `off_topic_review_status` 50%→100%. The review gate now fail-safes to `needs_review` on any `general_incident` (unrecognized) input instead of auto-approving at low severity. Aggregate now **21/21 = 100%** on the deterministic stack.

### 2. Correctness pass on latent bugs  ✓ done 2026-05-27
- [x] Fix the tz naive/aware crash in incident-packet backfill — `_reconstruct_timeline_meta._parse` returned mixed-awareness datetimes (naive seed `occurred_at` vs aware `Z` stream events); normalized via `as_utc()`. Regression test in `test_claims_timeline_meta.py`.
- [x] Swept `fromisoformat`/`timedelta`/`total_seconds` sites — no other Python naive/aware comparison crashes. `alert_dispatcher.py:181` uses naive `utcnow()` but only in a SQL filter (DB-handled); left as-is per the out-of-scope `utcnow` deprecation rule.
- [x] Reviewed every `except Exception` site — all log or are intentional best-effort guards; none silently hide real failures.
- [x] Safety Record scoring made recency-decayed + exposure-normalized (`scoring.py` `_effective_incident_load`); fixes the saturated curve where 20+ incidents all read ~1/100 and closing a case didn't move the score. Shipped `scripts/audit_incidents.py` + `scripts/cleanup_stale_incidents.py` (dry-run/`--apply`, archive-only) to remediate venues bloated with stale app-generated open incidents. `/risk-score` + `/quote` are now venue-access gated.
- [x] Triage/ingestion demo flow accumulates unbounded open incidents (`inc-` rows). Fixed with a self-healing per-venue open-incident cap (`app/services/incident_maintenance.py` `enforce_open_incident_cap`, wired into `create_brawl_incident_flow` with `protect_ids` so the just-filed incident is never archived) + extracted the cleanup script's core into a tested `archive_stale_incidents`/`find_stale_incidents` service (single source of truth). Tests in `test_incident_maintenance.py`.
- [x] Re-resolve compliance crash: both `POST /venues/{id}/compliance/{item}/upload` and the broker waiver route (`app/api/v1/compliance.py`) now skip the transition when the signal is already `resolved` — idempotent success, never a 500. RED-proven regression tests in `test_compliance_resolve.py` + `test_compliance_evidence.py`.
- [ ] Prod data cleanup (ops, not code): run `DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.audit_incidents --venue elsewhere-brooklyn` against Railway, review the age buckets, then `cleanup_stale_incidents --apply` to drop the ~29 stale open `inc-` rows so the live Safety Record recovers. The recency-decay model already softens it, but the "29 open" display persists until cleaned.

### 3. Deterministic (no-key) agent quality
- [x] Improve the keyword-ladder risk classifier (`app/providers/deterministic.py`) — added a generalizable aggravator/mitigator severity modifier + filled the medical keyword gap. `severity_match` 47%→100%, aggregate 57%→95%, no other scorer regressed. Unit tests in `test_risk_classifier.py` include over-fit guards (novel summaries + plain-incident guards). Baseline + public scoreboard refreshed.
- [ ] Tighten deterministic memo templates so no-key output reads credibly in a demo.
- [ ] Add eval coverage that pins the deterministic-mode quality (ties into track 1).

### 4. Test-coverage expansion
- [ ] Frontend: component/integration tests beyond the `account`/`market` unit tests; broaden the 6 Playwright e2e specs.
- [ ] Enable the skipped `frontend/e2e/settings.spec.ts` once the backend deploy includes the auth endpoints (it's `describe.skip` pending deploy).
- [ ] Mobile: tests beyond `format.ts` helpers (lightweight, given Expo render-test flakiness).

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

## Gated — needs an account/keys (revisit when available)

See [`go-live-readiness.md`](./go-live-readiness.md) for detail. Summary:
- [x] Object storage (S3/GCS) — `S3Storage` **implemented** (boto3, `STORAGE_BACKEND=s3`), Stubber-tested. Only remaining step is ops: create a bucket (Cloudflare R2 free tier) + set the four `S3_*` env vars on Railway. Was the biggest real blocker (Railway FS is ephemeral → evidence/PDFs vanish on redeploy).
- [ ] 🔒 Email provider (Resend) — set `RESEND_API_KEY` + `FRONTEND_URL`, verify domain → reset emails actually send.
- [ ] 🔒 LLM live mode — set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` (+ budget) to swap deterministic stubs for real agents.
- [ ] 🔒 A real operational connector (e.g. scheduling/POS) — the `staffing` slot is the cheapest real-API swap.
- [ ] SMS (Twilio), payments (Stripe), loss-run ingestion — only if v1 scope expands.

---

## Recommended order

Updated 2026-06-05. Shipped since the last ordering: carrier desk v2 + claims adjudication
(Phase 1.5–2), the AI underwriting memo, the landing page + perf fix, surplus-lines compliance
(C11), the ingestion spine + comms classifier, staff accounts, and the fraud/SIU agent. Live focus:

1. **Underwriting-memo fast-follows** (track 9, smallest + completes the eval headline) — wire the
   3 memo scorers (posture/faithfulness/rate-adequacy) into `runner.py`/`baseline.py`/
   `--compare-baseline` + the `/evals` scoreboard (the 0.917/0.917/1.0 numbers are not drift-gated
   yet); real `check_appetite` (graded 0–100 match — also the open 7a item).
2. **Outbound Slack alert adapter** (track 5 ★) — still the cheapest "closes a visibly-absent box"
   win; one evening, subscription-free, demoable. (Inbound shipped 2026-06-04.)
3. **Policy-doc vector RAG** (track 10) — design approved; implementation plan → TDD build.
   Strong pitch artifact (vector pipeline + retrieval eval delta).
4. **C5 carrier portfolio / C4 renewal underwriting** (track 9) — the management layer; fills the
   carrier nav.
5. **Two-way open questions + agent assistants** (track 8) — the AI-native frontier on the broker side.

Good filler (independent, no subscription): track 7c polish, the cross-cutting Neon JSON-string
correctness sweep, track 3 (deterministic memo quality), track 4 (test-coverage breadth). Quick ops
items still pending: seed prod adjuster demo + prod stale-incident cleanup (see tracks above).
