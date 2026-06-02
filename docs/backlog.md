# Engineering Backlog

Working checklist for the subscription-free work (no API keys, no S3/email/SMS
accounts yet). Gated/integration items live in [`go-live-readiness.md`](./go-live-readiness.md).

Last updated: 2026-06-02.

---

## Recently shipped (context for picking back up)

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
    the most visibly-missing box). ★
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

Updated 2026-06-02 (carrier Phase 1 UI shipped). Track 1 (evals, the headline) and track 2
(correctness) are done; spine + lifecycle edges (7a/7b) and the **whole carrier Phase 1** (backend +
web/mobile desk UI) are shipped. Live focus:

1. **Policy-doc vector RAG** (track 10) — design approved; next is the implementation plan → TDD build.
   Strong pitch artifact (vector pipeline + retrieval eval delta).
2. **Two-way open questions + agent assistants** (track 8) — the AI-native frontier on the broker side.
3. **Carrier Phase 2** (track 9) — carrier claims/adjuster authority (sets reserves, approves payments),
   plus the desk enrichment hook (premium_breakdown is already on the queue) and an appetite match-score.

Good filler (independent, no subscription): track 7c polish, the cross-cutting Neon JSON-string
correctness sweep, track 3 (deterministic memo quality), track 4 (test-coverage breadth). The Slack
incoming-webhook adapter (track 5 ★) remains the cheapest "closes a visibly-absent box" win.
