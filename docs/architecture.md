# Nightline Risk OS — System Architecture

> Full-system reference: high-level design, low-level mechanics, and the invariants that hold it
> together. Verified against code 2026-06-05. Companion docs: [`backlog.md`](./backlog.md) (live
> roadmap), [`go-live-readiness.md`](./go-live-readiness.md) (gated integrations), `adr/` (decision
> records), `superpowers/specs/` (per-feature design specs).

---

## 1. What Nightline is

**Thesis:** insurance for nightlife venues, rebuilt from the evidence up. A venue's operational
data (door counts, POS, ID scans, cameras) and incident evidence (hashed at intake, corroborated
by vision analysis) feed proprietary underwriting, lawsuit-ready defense packages, and carrier-side
claims — the full chain, operator → broker → carrier, in one system.

**The value-chain position:** Nightline owns its own ladder. It is simultaneously:

- the **operator surface** (the insured): incidents, compliance, live floor, coverage
- the **broker platform** (distribution): submissions → quotes → bind → policies → renewals → book
- the **carrier desk** (risk-bearing): underwriting queue, claims adjudication, reserves/payments

Five roles: `venue_operator`, `broker`, `carrier`, `staff`, `admin` (admin ≈ super-broker).
Tenancy: `tenant_id == venue_id` for operators, plus `extra_venue_ids` for multi-venue access.

**Operating constraint that shaped everything:** built subscription-free (no required API keys).
Every AI capability has a deterministic implementation that works with zero keys; LLM providers
are a drop-in upgrade behind a seam, gated by a regression eval harness.

---

## 2. Runtime topology

```
┌─────────────┐     ┌──────────────────────────┐     ┌──────────────┐
│  Vercel      │     │  Railway (Dockerfile)     │     │  Neon        │
│  Next.js 16  │────▶│  FastAPI + SQLModel       │────▶│  Postgres    │
│  nightline-  │ REST│  nightline-risk-api-      │ SQL │  (us-east-1, │
│  app.vercel  │     │  production.up.railway.app│     │  cross-region│
│  .app        │     │                           │     │  from compute)│
└─────────────┘     └──────────────────────────┘     └──────────────┘
       ▲                       ▲
       │                       │ EXPO_PUBLIC_API_URL
┌─────────────┐     ┌──────────────────────────┐
│  Browser     │     │  Expo / React Native      │
│  (operator/  │     │  mobile app (iOS/Android) │
│  broker/...) │     │  token in SecureStore     │
└─────────────┘     └──────────────────────────┘
```

- **Backend:** Railway, Dockerfile build (nixpacks fails on native deps). No `startCommand` in
  `railway.toml` — the Docker `CMD ["sh","-c","uvicorn ... --port ${PORT:-8080}"]` owns startup so
  Railway's `$PORT` shell-expands (an exec-form override would crash-loop on the literal string).
- **DB:** Neon Postgres via `DATABASE_URL`; **unset → silent SQLite** (the dev default and a known
  prod footgun). Cross-region Neon latency is why the bootstrap/backfill guards in `database.py`
  exist (§12).
- **Frontend:** Vercel; API base from `NEXT_PUBLIC_API_URL` (fallback `127.0.0.1:8000`).
  `next.config.mjs` 308-redirects the stale auto-generated `frontend-mu-ebon-*.vercel.app` host to
  the canonical domain.
- **Mobile:** Expo; `EXPO_PUBLIC_API_URL` (inlined at bundle time — changing it requires
  `expo start --clear`).
- **CORS** (`main.py`): localhost:3000, the canonical Vercel domain, `*.vercel.app` regex, Expo
  LAN origins, plus `EXTRA_CORS_ORIGINS`.

Env vars (backend, `.env.example`): `APP_SECRET` (refuses to boot in prod without it),
`DATABASE_URL`, `STORAGE_BACKEND` + `S3_*`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY` /
`GEMINI_API_KEY` / `OPENAI_API_KEY`, `VAPID_PRIVATE_KEY`, `COMMS_MCP_*_SSE_URL`,
`INGEST_TICK_SECONDS`, `FRAUD_TIER_*` threshold overrides.

---

## 3. The four-layer architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ CLIENTS      Next.js web (per-persona IA)  ·  RN/Expo mobile (parity)│
├────────────────────────────────────────────────────────────────────┤
│ EVAL LAYER   gold scenarios + scorers → CI baseline gate            │
│              adversarial/safety scorers · calibration-vs-reality    │
│              (gates every agent change; baseline keyed per provider)│
├────────────────────────────────────────────────────────────────────┤
│ AGENT LAYER  packet pipeline (retrieval→risk→action→timeline→memo)  │
│              vision · corroboration · fraud · comms classifier ·    │
│              underwriting recommender · claim recommender           │
│              provider seam: Claude → Gemini → deterministic fallback│
├────────────────────────────────────────────────────────────────────┤
│ DOMAIN       Evidence layer            │  Broker-platform layer     │
│ (two data    incident → evidence →     │  submission → quote →      │
│  layers)     packet → proposal →       │  bind → policy →           │
│              defense package           │  endorsement/renewal/claim │
├────────────────────────────────────────────────────────────────────┤
│ PLATFORM     SQLModel + self-healing schema · storage seam ·        │
│              ingestion spine · audit events · lifecycles ·          │
│              Decimal money · snapshot hashes                        │
└────────────────────────────────────────────────────────────────────┘
```

The two domain layers meet at exactly one junction: `Claim.proposal_id` (optional) links a
carrier-side `Claim` back to the evidence-layer `ClaimProposal` that recommended filing it, and
`Claim.defense_package_id` pins the frozen `UnderwritingPacket` (FK `ON DELETE RESTRICT` — you
cannot delete the evidence under a claim). Vocabulary split is deliberate (ADR-0004):
**`ClaimProposal`** = internal recommendation routed for broker decision; **`Claim`** = real
reported loss with reserves and payments.

---

## 4. Domain model

### 4.1 Evidence layer (`app/models.py`)

| Entity | Purpose |
|---|---|
| `IncidentRecord` | Operator/staff-filed incident; structured A&B/liquor facts (injury/police/EMS flags, parties/witnesses JSON) |
| `EvidenceFile` | Uploaded media; **SHA-256 `content_hash` of bytes** at intake (chain of custody) |
| `EvidenceAnalysis` | Vision/audio findings per file; corroboration verdict + confidence delta |
| `SourceRecord` | Retrieval/citation target (`venue_id="*"` = shared corpus); content-hashed |
| `PolicyDocument` | Broker-uploaded policy doc (PageIndex tree; leaves flattened to SourceRecords) |
| `UnderwritingPacket` | **The frozen snapshot**: risk signals, action plan, timeline, memo, citations, validation, corroboration status, fraud signal — sealed by `snapshot_hash` |
| `CitationRecord` | One cited source per factual claim (`claim_id`, `field_path`, validation status) |
| `RubricVersion` | Validation rubric the packet is gated against |
| `ReviewDecision` | Broker/underwriter decision on a packet (also feeds calibration) |
| `OpenQuestionResponse` | Operator answers + broker resolves memo open-questions (upsert per packet/index) |
| `ClaimProposal` | Operator-proposes / broker-decides claim recommendation; `recommendation_snapshot` |
| `AuditEvent` | Universal audit row (§6 conventions) |

### 4.2 Broker-platform layer

| Entity | Purpose |
|---|---|
| `Venue` / `UserRecord` | Tenancy + auth (`tenant_id == venue_id`; `extra_venue_ids`) |
| `Carrier` | Insurer; `market_type` (admitted/E&S), appetite JSON, AM Best rating |
| `CoverageLine` | Standardized product (ISO code, default limits/deductible as `Numeric`) |
| `Submission` | Placement attempt (coverage lines, requested limits — money as strings in JSON) |
| `CarrierQuote` | Per-carrier offer/decline; `premium_breakdown`, structured `coverage_terms`, `inputs_snapshot`, info-request round-trip |
| `Policy` | Bound contract; `snapshot_hash`, commission, cancellation/refund fields |
| `SurplusLinesFiling` | NY E&S filing: tax + ELANY stamping, 45-day deadline, diligent-search flag |
| `Declination` | Admitted-carrier decline (NY §2118 diligent search needs 3) |
| `Endorsement` / `CertificateOfInsurance` | Mid-term change (validated `terms_diff`) / COI (supersede-not-delete) |
| `Claim` / `ClaimPayment` / `ReserveChange` | Carrier-side loss: reserves, payments, coverage decision, `total_incurred`, reopen count |
| `PolicyRequest` / `BrokerTask` | Operator→broker service requests / broker to-do overlay |

Ops-adjacent: `ComplianceSignal`, `CameraFeed`, `AlertEvent`, `PushSubscription`,
`VenueOperationalEvent` (content-hash deduped), `IngestionRun` (watermark cursor),
`CommsReviewItem`.

### 4.3 Lifecycles (`app/lifecycles.py`)

Typed `Literal[...]` status sets + `TRANSITIONS: dict[str, set[str]]` per entity;
**every status mutation** goes through a `_transition_<entity>()` helper that calls
`assert_valid_transition(...)` (raises `InvalidTransitionError`) and emits an audit event.

```
Submission   open → in_market → quoting → bound | lost | declined | withdrawn
CarrierQuote requested → pending ⇄ info_requested → quoted → bound | declined/expired/withdrawn
Policy       bound_pending_number → active → cancelled|non_renewed|lapsed|expired
             (lapsed → active = reinstate; hash NOT recomputed on status-only changes)
Claim        notified → acknowledged → under_investigation → reserved → settling
             → closed_paid | closed_denied | closed_dropped → reopened → …  (no true terminal)
ClaimProposal pending_broker_review → approved | rejected_by_broker | needs_more_info
             needs_more_info → pending_broker_review · approved → filed_with_carrier → paid|denied
             (encoded in claim_proposals.py, not lifecycles.py)
Incident     open ⇄ under_review ⇄ closed → closed_archived (only true terminal)
SLFiling     pending → filed → confirmed → void
```

---

## 5. The two core flows

### 5.1 Evidence chain: incident → defense → FNOL

```
staff/operator files incident (web /report, mobile)
  └▶ create_brawl_incident_flow (incident_flow.py)
       ├─ persist IncidentRecord + IncidentEvaluation
       ├─ execute_underwriting_packet_agents          ← §7 agent pipeline
       └─ create_packet_snapshot (packet_core.py)
            ├─ per-citation: _ensure_source_record (content-hash) + _validate_citation
            ├─ _apply_rubric_gates → validation verdict
            ├─ snapshot_hash = SHA-256(canonical JSON)
            └─ audit: packet.generated
  └▶ maybe_auto_route_incident (claim_routing.py)      ← idempotent per packet
       ├─ recommend_claim_filing  (EV math, §9)
       ├─ assess_fraud v1 (metadata) — tier "high" → audit fraud.hold, SUPPRESS auto-route
       └─ confidence ≥0.70 & should_file → auto-create ClaimProposal (actor "auto-router")
  └▶ evidence upload → vision agent → corroboration agent
       └─ regenerate_packet_with_corroboration (v2 packet)
            └─ assess_fraud v2 (evidence-aware) — idempotent fraud.flagged
  └▶ broker decision (approve / reject / needs_more_info round-trip)
  └▶ file_fnol (claims.py) — resolve_fnol_defaults picks policy/line/date,
       Claim created (notified), defense_package_id pinned (ON DELETE RESTRICT)
  └▶ adjudication: coverage decision → reserves → payments → close
       └─ close_claim → total_incurred → settle_proposal_from_claim (paid/denied)
  └▶ render_defense_pdf (defense_package.py): cover w/ snapshot hash, facts, timeline,
       corroboration, per-file content hashes, cited sources, full audit trail
```

### 5.2 Placement chain: submission → policy

```
broker creates Submission (open)
  └▶ submit_to_market — check_appetite per carrier → CarrierQuotes (requested), sub → in_market
  └▶ carrier desk (require_carrier): underwriting_queue → decision dossier
       ├─ suggested premium from build_quote_for_carrier (same engine as broker indicative)
       ├─ advisory UnderwritingRecommendation (deterministic recommender, §9) on the dossier
       └─ underwrite_quote → record_carrier_response (validates breakdown sums to $1 tolerance;
          decision_source = "carrier_desk" vs broker relay "broker_relay" — audit provenance)
  └▶ select_quote → bind_quote (ATOMIC: quote→bound, siblings→withdrawn, sub→bound,
       Policy row, snapshot hash, E&S → SurplusLinesFiling auto-created)
  └▶ assign_policy_number (→ active, re-hash)
  └▶ mid-term: issue_endorsement (validated terms_diff, re-hash) · issue_certificate (supersede)
  └▶ renewal: create_renewal (one live renewal per policy) → compute_loss_experience
       → loss_adjustment_from_loss_ratio bands → re-priced quote
  └▶ end-of-life: expire / non_renew / lapse / reinstate / cancel (pro-rata or short-rate refund)
```

---

## 6. Backend design & conventions

**Stack:** FastAPI + SQLModel (Python 3.12). Routers in `app/api/v1/` (one per domain), services
in `app/services/`, mounted under `/api` (`/api/auth` for auth, `/api/v1` for ingestion).

**Service/transaction convention:** broker-platform services take keyword-only args and **never
commit** — the API layer or test fixture owns commit/rollback (atomicity of e.g. `bind_quote`'s
six effects comes free). Evidence-layer modules (`packet_core`, `claim_proposals`,
`open_questions`) commit internally. `session.flush()` parents before children when a column-level
FK will be used immediately (Postgres ordering footgun).

**Error mapping (every router, `_map_service_error`):** typed service errors
(`SubmissionsError`, `PoliciesError`, `ClaimsError`, …) → **400**; `InvalidTransitionError` /
validation errors → **422**, structured `{error, message}` detail.

**Role guards:** `require_broker` (broker+admin), `require_carrier` (carrier+admin),
`require_staff`, `require_non_broker`, `require_venue_access` (tenant gate),
`can_read_venue_floor` (live occupancy is operator-only — brokers excluded).

**Cross-cutting conventions:**

- **Money:** `Decimal` everywhere; `app.money` helpers (`usd` = banker's rounding,
  `usd_to_json`/`json_to_usd` force string round-trips — JSON floats corrupt cents). Columns
  `Numeric(12,2)`; rates `Numeric(6,4)`. One legacy float boundary: `cast_money_to_float`.
- **Time:** `now_utc()` (tz-aware) everywhere; `as_utc()` re-attaches UTC on SQLite reads.
- **Audit events:** uniform `AuditEvent(actor_id, actor_type, entity_type, entity_id,
  event_type="<entity>.<verb>", event_metadata)` on every transition and business event;
  transition metadata carries `{from, to}`; `decision_source` stamped on carrier decisions.
- **Snapshot hashes:** SHA-256 of canonical JSON (`sort_keys=True`, sorted list contents —
  `json.dumps` alone doesn't sort lists). `Policy` re-hashes on bind/endorsement/number-assignment
  only; `Claim` re-hashes on every money/status mutation; packet hash seals the defense package.
- **JSON-string coercion:** `Column(JSON)` returns parsed objects on SQLite but **strings on
  Postgres/Neon** — coerce at every read boundary (`_as_dict`/`_as_list` helpers) or iteration
  silently walks characters. This is a known prod-only bug class.
- **Idempotency:** content-hash dedupe (operational events, evidence, sources), watermark cursors
  (ingestion), once-per-packet auto-routing, upsert-by-key (open questions, seeds), supersede-not-
  delete (COIs), archive-not-delete (incidents, `closed_archived` + `seed-*` rows protected).
- **Failure isolation:** advisory paths (fraud scoring, suggested premiums, calibration telemetry,
  dossier enrichment) swallow their own exceptions and degrade — they never block the primary
  action.

---

## 7. Agent layer

### 7.1 The packet pipeline (`app/agents/runtime.py`)

`UnderwritingPacketAgentRuntime.execute()` runs five steps in order, each producing an
`AgentExecutionStep` trace entry (agent, contract version, execution mode):

```
retrieval → risk_evaluator → customer_action → claims_timeline → underwriter_memo
(deterministic)  (LLM+fallback)   (deterministic)   (deterministic)    (LLM+fallback)
```

- **Contract gate:** the five contracts in `app/agents/*.md` must exist and contain
  `## Current Runtime Status` or the runtime refuses to start (`AgentContractError`).
  `CONTRACT_VERSION = "2026-05-03"`.
- **Hard signals are code, not model:** after classification, deterministic escalation runs —
  EMS bumps severity a step, injury+police forces ≥ high, police/EMS add confidence. A model can
  never *relax* a severity the hard signals imply.
- **Review-status gate:** `approved` only when severity == low AND risk_type is recognized;
  `general_incident` (unrecognized/off-topic) is **never auto-approved** → `needs_review`.

### 7.2 Agent catalog

| Agent | Mode | Job | Invoked from |
|---|---|---|---|
| retrieval | deterministic | type-aware query → TF-IDF/semantic retrieve → `Citation[]` | pipeline step 1 |
| risk_evaluator | **LLM + fallback** | classify → hard-signal escalate → review gate → `RiskSignal` | pipeline step 2 |
| customer_action | deterministic | venue-facing evidence task plan | pipeline step 3 |
| claims_timeline | deterministic | chronology from stream events + gaps/defensibility meta | pipeline step 4 |
| underwriter_memo | **LLM + fallback** | grounded memo + open questions (`fallback_reason` surfaced on output) | pipeline step 5 |
| vision | **Gemini 2.5 Flash + template fallback** | image/video → `VisionFinding` | evidence upload pipeline |
| corroboration | deterministic | findings vs written report → CONSISTENT / PARTIAL / CONTRADICTED / INCONCLUSIVE (+confidence delta; CONTRADICTED forces human review) | post-vision, regenerates v2 packet |
| **fraud** | deterministic (LLM narrative optional) | scored, explainable `FraudSignal` | v1 at routing; v2 after corroboration |
| comms classifier | deterministic (injectable LLM) | inbound text → incident / compliance / noise | ingestion comms router |
| underwriting recommender | deterministic, **pure** (no DB/IO) | posture + rate adequacy + subjectivities | carrier dossier + evals |
| claim recommender | deterministic | EV math → should_file + payout band | auto-routing + proposals |

**Vision integrity invariant:** the template fallback passes through `_stamp_unverified` — forced
`corroboration=INCONCLUSIVE`, zero confidence delta, `[Unverified — template fallback]` prefix.
Fallback prose can never move a score or fake corroboration.

### 7.3 Fraud agent (two-point scoring, `app/agents/fraud_agent.py`)

Stage `v1` (metadata, at intake/routing): reporting delay (>3d +0.15, >7d +0.25), policy
proximity (near-bind +0.15, near-expiry +0.10), claim frequency (≥3 +0.15, ≥5 +0.25), unverified
injury (injury w/o police or EMS +0.15).
Stage `v2` (evidence-aware, after corroboration): CONTRADICTED +0.40, PARTIAL +0.15,
injury-not-visible +0.15, timestamp mismatch +0.15, high-severity with zero evidence files +0.20.

Tiers: high ≥0.55, elevated ≥0.30, low ≥0.10 (env-overridable). Effects: v1 high → audit
`fraud.hold` + **suppress auto-routing** (early return); v2 high → idempotent `fraud.flagged`
(checks for prior hold/flag on the incident before emitting). Persisted to `packet.fraud_signal`.
Entirely advisory and failure-isolated — a scoring fault never blocks the operator's incident.

### 7.4 Provider seam (`app/providers/`)

Resolution precedence (per capability, resolved per-process):

```
memo / risk:   ANTHROPIC_API_KEY → Claude (claude-haiku-4-5, forced tool-use for the
               classifier, ephemeral prompt cache for the memo)
             → GEMINI_API_KEY   → Gemini (gemini-2.5-flash-lite, responseSchema JSON,
               thinkingBudget=0 — 4× free-tier quota vs flash)
             → DeterministicProvider / DeterministicRiskClassifier
embeddings:    OpenAI (1536-d) → Gemini text-embedding-004 (768-d) → FAIL LOUD
               (no deterministic fallback — embeddings would be meaningless)
```

Runtime-level fallback: any provider exception → log → deterministic re-run; a packet is never
blocked by an LLM hiccup. Bulk startup backfill is **pinned deterministic** regardless of keys
(bounded: 25 packets/startup, abort after 5 consecutive failures) so a reboot can't burn quota.
Swapping providers touches one resolver — packet builder, citation validator, audit trail
untouched (ADR-0001).

**Deterministic risk classifier** (`providers/deterministic.py`): off-topic guard first
("no incident"/"nothing to report" → `general_incident`, defeats decoy keywords), then a 7-row
keyword ladder (medical→critical/0.94 … vandalism→low/0.74, first match wins), then severity
modifiers — critical aggravators (after-hours service, underage w/o ID scan, advertised-security
absent, foreseeable repeat harm, delayed EMS) beat mitigators (proactive controls, contained
without harm); documented overcapacity bumps one step. Conservative by construction.

---

## 8. Eval architecture (four layers)

```
L1 GOLD SCENARIOS      15 standard + 6 adversarial, 7 exposure classes (docs/evals/*.json)
   + SCORERS           structural · severity_match · citation_coverage ·
                       review_status_match · factor_recognition · NDCG@5 · MRR
L2 REGRESSION GATE     committed baseline.json, STACK-KEYED per provider signature
   (CI, every PR)      ("memo=X;risk=Y") — ANY drop in aggregate or per-scorer pass
                       rate fails the build; bumps are deliberate (--update-baseline)
L3 ADVERSARIAL         no_injection_followed (injected severity in event labels must not
                       be adopted) · graceful_empty · off_topic_review_status
L4 CALIBRATION         predictions vs REALITY, not gold answers:
   (vs outcomes)       broker_agreement · outcome_in_band (payout inside predicted band) ·
                       probability_calibration (deciles + Brier) — own CI gate
```

- **L1/L3 mechanics:** the runner (`app/evals/runner.py`) bridges gold scenarios into pipeline
  inputs and replays the real agent pipeline. `--provider stub|gemini|anthropic|auto` — `stub`
  forces deterministic so the committed baseline is reproducible with zero keys.
- **L2 stack-keying:** `baseline.json` is keyed by `memo=…;risk=…` signature, so Claude's run has
  its own regression target and can't pollute the deterministic baseline (and vice versa) — the
  structural answer to "what happens when models change under you."
  Regression = aggregate drop OR any scorer drop (tolerance 1e-6) OR a baseline scorer vanishing.
- **L4 mechanics** (`app/evals/calibration.py`): joins `UnderwritingPacket→ReviewDecision` (latest
  per packet), `Claim→ClaimProposal→Packet`. Gated in CI against `calibration_baseline.json` via
  `scripts/run_calibration.py --compare-baseline` over a hand-built 8-row fixture.
  *Honest caveat:* the machinery is real; outcome data is currently seeded (pre-users).
- **Domain suites** (run inside pytest, **no dedicated baseline gate yet**): fraud fixtures
  (5 scenarios → expected tier), comms classifier (precision/recall per kind + human-corrections
  re-score), underwriting recommender (13 labeled scenarios × 3 scorers —
  posture / rate-adequacy / faithfulness, where faithfulness requires every number and tier letter
  in the memo to exist in the grounding set).
- **Current committed numbers:** deterministic stack 21/21 scenarios, aggregate 1.0, all scorers
  100% pass (factor_recognition pass-by-design on deterministic with avg score 0.21 — the
  documented LLM-uplift gap). Recommender: posture 0.917 / rate-adequacy 0.917 / faithfulness 1.0
  with the two misses documented as threshold disagreements, not fudged. Calibration fixture:
  broker agreement 0.714, in-band 0.60, Brier 0.058.
- **CI wiring:** `evals` job on every push/PR (deterministic + calibration gates);
  `evals-matrix` nightly cron runs the LLM provider rows (skips without keys).
  **Not yet gated:** fraud/comms/recommender suites have no committed baseline JSON (tracked in
  backlog); LLM rows gate nightly only.
- **Scoreboard:** `/evals` page reads `frontend/public/eval-baseline.json`; committed failures are
  documented gaps with a root-cause ledger (agent-gap / gold-error / known-limit / safety).

**Eval philosophy in one line:** scorers test "does the agent match my expectations"; calibration
tests "do my expectations match the world"; the baseline is a regression floor, not a vanity
metric — misses are documented, never fudged.

---

## 9. Pricing & the underwriting brain

- **Rating engine** (`app/underwriting/pricing.py`): per-carrier, per-line, Decimal end-to-end:
  `line_premium = BASE_RATES[venue_type] × carrier_venue_mult × TIER_MULT[tier] ×
  carrier_line_mult × loss_adjustment`. Tier multipliers A 0.7 / B 1.0 / C 1.5 / D 2.5.
  Loss-ratio bands: <0.40 → ×0.90, <0.70 → ×1.00, <1.00 → ×1.25, ≥1.00 → ×1.60. Fees: policy fee,
  **E&S-only NY surplus-lines tax 3.6%** + stamping; commission pre-tax. The engine is **pinned by
  62 characterization tests across every (venue × tier × billing) cell** — rating logic is
  deterministic, testable, diff-able.
- **Underwriting recommender** (`recommender.py`): pure function over a typed
  `RecommenderInputs` bundle (tier, score, loss-by-line, indicated total, appetite) →
  `UnderwritingRecommendation{posture, rationale, subjectivities, rate_adequacy, grounding}`.
  Advisory: the engine still owns the premium; the carrier desk shows it on the dossier and audit
  snapshots recommendation-vs-decision (`followed`) for future calibration.
- **Claim recommender** (`claim_recommendation.py`): expected-value math (payout base by incident
  type × severity multiplier vs deductible + 3-yr premium impact) → `should_file` + probability +
  payout band. Feeds auto-routing (≥0.70 confidence) and the calibration layer.

---

## 10. Web frontend (Next.js App Router)

- **Composition:** every page directory carries its own `layout.tsx` wrapping
  `<AppShell><Suspense>` — there is **no global AppShell**; a new page without a layout renders
  bare (known footgun). `/market` and `/evals` are deliberately shell-less.
- **Responsive nav:** `useBreakpoint()` switches sidebar full → rail → drawer; phones drop the
  sidebar for `MobileBottomNav` + a More sheet.
- **Per-persona IA:** operator (Home / Venue / Incidents / Claims / Compliance / Review Queue /
  Coverage / Floor Team / Alerts), broker (Work Queue / Claims / Submissions / Policies /
  Renewals / Financials / Venues / Requests / Surplus Lines / Ingestion), carrier (Desk +
  Claims only), staff (Report + My Reports only).
- **Three-layer role gating:** (1) IA renders only permitted links; (2) hard route guard for
  *focused* personas (staff/carrier allowlists in `AppShell` — direct-URL access bounces to role
  home); (3) backend guards are the real wall. Operator/broker have no client route guard.
- **Auth seam:** token in `localStorage`; `authHeaders()` from `src/lib/authFetch.ts` added
  manually to every fetch (no wrapper — raw uploads that forget it 401 silently; known footgun).
  Plain fetch, no SWR/React Query.
- **Design system** ("Paper & Ink" v3, `styles.css`): warm cream paper, ink text, hard-edge
  borders, blur-less offset shadows, one lime accent. Load-bearing rules:
  - lime `--brand-primary #c8f000` is a **fill, never a text color** — text uses
    `--accent-ink #5a6e00` (4.9:1). Enforced by `scripts/design-lint.mjs` in CI (scans web AND
    mobile sources; raw lime hex or lime-as-text fails the build).
  - **Numeral type system:** `.lc-numeral` (italic display serif) = money only;
    `.lc-num-data` (sans bold, tabular) = counts/scores/percentages; one descending scale ladder
    per view (hero > score > money).
  - Tier colors are one heat ramp (A green → D red), never the lime accent.
  - `lc-*` component family: `lc-card` (conic-ring hover), `lc-demo` (persona launcher),
    `lc-beam` (always-on traveling border beam — max one per view), triage rows, stat labels.
- **Fonts:** Bricolage Grotesque (display), Hanken Grotesk (body), Space Mono (data), Caveat
  (accent script — RN renders 'd' wrong, so accent copy avoids the letter).

## 11. Mobile (React Native / Expo)

**Parity model:** mirrored — design tokens (`mobile/src/theme/colors.ts` hand-mirrors the web
`:root`, enforced by the same design-lint), auth shape, API client modules 1:1 with web
`src/lib/*`, navigation intent (per-persona tab sets: operator 5-tab, broker 5-tab, carrier
2-tab, staff 2-tab, overflow in a More stack).
**Mobile-only:** register/forgot-password screens, `api.upload` (multipart evidence capture via
expo-image-picker), adjuster action screens, SecureStore tokens.
**Web-only:** market map (Leaflet), `/evals`, surplus lines, terminal, Playwright e2e, the client
route guard.
**Known footgun:** `EXPO_PUBLIC_*` is inlined at bundle time; a stale `mobile/.env` host breaks
login silently — keep in sync with web `NEXT_PUBLIC_API_URL`.

---

## 12. Platform layer

- **Schema management — self-healing allowlist, no Alembic** (`app/database.py`): SQLModel
  `create_all` + `_COLUMN_MIGRATIONS` (~40 dated rows of `ALTER TABLE ADD COLUMN`, cross-dialect
  via an inspector probe). **Every new column on an existing table needs a manual allowlist row**
  or prod SELECTs fail. Bootstrap and compliance-backfill are guarded **per-engine**
  (`WeakSet` — tests swap engines), the backfill retrying until venues are seeded; unguarded,
  these added cross-region SELECTs to every request (the historical 20–30s dashboard load).
- **Storage seam** (`app/storage.py`): `Storage` Protocol → `LocalStorage` (default; **ephemeral
  on Railway**) | `S3Storage` (implemented, Stubber-tested; activation is an ops step — R2 bucket
  + four env vars). All file I/O goes through `get_storage()`; no raw `open()` for evidence.
- **Ingestion spine** (`app/ingestion/`): `Connector` ABC with uniform cross-cutting concerns —
  extract w/ 3-attempt exponential backoff → watermark filter → quality gate (per-metric range
  specs, rejection-reason tallies) → content-hash-deduped load → rollup → `IngestionRun` log.
  Connectors: POS (over-pour), ID-scan (rejection + occupancy), staffing, NYC-open-data
  (network-free master data). Push lane: `POST /api/v1/ingest/{venue}/{pos|camera|staffing}` +
  generic `/signal`, synchronous through the same spine, echoing the moved score (202).
  Inbound comms (Slack/tickets/SMS) via env-gated MCP sources → eval-gated comms classifier →
  incident / compliance / review queue.
- **Boot sequence** (`main.py` lifespan): env validation (fail fast in prod w/o `APP_SECRET`) →
  schema + migrations → seeds (venues, carriers, demo users, incidents — all idempotent) →
  packet/proposal backfills (deterministic-pinned, bounded) → prospects → optional ingest tick.
- **Alerting:** `AlertEvent` → `dispatch_alert` (Web Push, VAPID-gated) with operator-scoped
  subscriptions + false-alarm feedback loop. Email (Resend) is env-gated; unset → logged URLs.

---

## 13. Testing & CI

- **Backend:** ~119 test files, ~1,230 tests green (2026-06-05). Service-level vs API-level
  naming (`test_claims_service.py` / `test_claims_api.py`). Per-test in-memory engines
  monkeypatched over `app.database.engine`; the per-engine guard contracts are themselves tested.
  TDD (RED→GREEN) is the working convention; the 62 pricing characterization tests pin every
  rating cell.
- **Evals in CI:** deterministic baseline gate + calibration gate on every PR; nightly LLM
  provider matrix.
- **Web:** Playwright e2e (7 specs) against the **live deployment**, with a warm-up gate (health +
  login smoke) to avoid racing redeploys; design-lint + build on every PR. (Vitest unit suite
  exists but only one `.mjs` test is CI-wired — known gap.)
- **Mobile:** jest-expo logic tests (no render tests by design — Expo flakiness); no CI job yet.

---

## 14. Design invariants (the decisions that hold)

1. **Deterministic-first, LLM as upgrade.** Every agent capability works with zero keys; the
   provider seam upgrades it; the eval baseline gates the upgrade. (ADR-0001)
2. **Advisory, never autonomous.** Agents draft, score, and flag; humans decide. Nothing
   autonomous touches the defense package or a coverage decision.
3. **Hard signals are code.** Injury/police/EMS escalation is deterministic post-processing — a
   model can never talk severity *down* past physical evidence.
4. **Fail safe to human review.** Unrecognized input, contradicted evidence, off-topic text →
   `needs_review`, never auto-approve.
5. **Every fact traceable.** Citations carry `source_id` to content-hashed sources; memos may not
   invent numbers (faithfulness scorer enforces).
6. **Evidence is tamper-evident.** Content hashes at intake; snapshot hashes seal packets,
   policies, and claims; FK `ON DELETE RESTRICT` under claims; archive-never-delete.
7. **Transitions are total.** No ad-hoc status writes anywhere — typed tables + assert +
   audit event, per entity.
8. **Money is Decimal, strings in JSON.** No float ever touches currency.
9. **Advisory paths are failure-isolated.** Fraud, recommendations, telemetry degrade silently;
   the primary action always completes.
10. **The baseline is a floor, not a trophy.** Regressions fail CI; documented misses stay
    documented (0.917 stays 0.917 until the *logic* improves).
11. **Provider changes are eval-gated, stack-keyed.** Model churn lands behind its own baseline
    signature.
12. **Two vocabularies for two truths.** `ClaimProposal` (recommendation) ≠ `Claim` (loss);
    relay (`broker_relay`) ≠ decision (`carrier_desk`).

---

## 15. Known gaps & where the roadmap lives

Tracked in [`backlog.md`](./backlog.md). Headlines as of 2026-06-05: memo/fraud/comms scorers not
yet behind a committed-baseline CI gate; retrieval/customer-action/claims-timeline steps still
deterministic-only (LLM routing pending); vision/corroboration not yet under the eval contract;
outbound Slack alert adapter open (inbound shipped); policy-doc vector RAG designed, not built;
C5 carrier portfolio / C4 renewal underwriting open; S3 activation is an ops step; calibration
runs on seeded outcomes pending real users.
