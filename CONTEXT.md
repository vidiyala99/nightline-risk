# Context

Vocabulary for working on this codebase. Read this once at the start of any session — it's much shorter than re-deriving the jargon from code.

This is **evidence-first underwriting infrastructure for nightlife venues**. An operator logs an incident; an agent pipeline produces a citation-backed underwriting packet that an underwriter approves, blocks, or sends back for more info — all traceable to source.

---

## Actors

- **Operator** (a.k.a. **Venue Operator**) — runs a bar/club. Logs incidents, uploads evidence, manages compliance queue. Sees only their own venues.
- **Broker** — sees a portfolio of venues across operators. Triages incidents toward carriers.
- **Underwriter** — reviews packets and renders a decision. Reviewer role; not its own login today (broker fills the role in the demo).
- **Carrier** — the insurance company that ultimately holds the risk. The packet is the carrier-facing audit artifact.

Roles live in `backend/app/auth.py` (`broker`, `venue_operator`).

---

## Core domain entities

- **Venue** — a physical location. Capacity, infrastructure, current carrier, renewal date. Two storage shapes: `VENUES` in-memory dict (seed) + `Venue` DB row with JSON-encoded `venue_data`. `_resolve_venue()` in `main.py` is the canonical lookup.
- **Incident** — something that happened at a venue (brawl, medical, property damage, liquor, crowd). The atomic input the system reasons about.
- **Stream Event** — sub-incident signal from venue infra: door scan, camera anomaly, POS, staffing change. Lower-grain than incidents; consumed by `LiveStateManager.process_events`.
- **Infrastructure Item** — a piece of venue tech (door scanner, camera, POS). Status: `ACTIVE` or `DEGRADED`.
- **Compliance Item** — actionable gap visible in the operator queue (degraded camera, missing manager sign-off). Severity: `URGENT` or `ACTION_REQUIRED`.
- **Live Venue State** — per-venue snapshot of *now*: current capacity, infrastructure status, compliance queue, accumulated `premium_impact`. Mutates as events arrive.
- **Camera Feed** — RTSP connection config per venue zone (entrance, bar, dance floor, exit). Stored in `CameraFeed` table. The sampler singleton `rtsp_sampler.sampler` opens one thread per feed.
- **Alert Event** — a detection persisted when the 3-gate filter passes (confidence ≥ 0.75, 3+ consecutive frames, severity critical/high). Carries operator feedback (`confirmed` / `false_alarm`) used for threshold calibration. Lives in `AlertEvent` table.
- **Push Subscription** — a browser Web Push endpoint registered by an operator on login. Used by `alert_dispatcher` to deliver mobile alerts. Lives in `PushSubscription` table.

---

## The packet (central artifact)

- **Underwriting Packet** — the durable, immutable per-incident artifact. Carrier-facing. Bundles risk signals + action plan + claims timeline + memo + citations under one `snapshot_hash` and one `rubric_version_id`. Lives in `UnderwritingPacket` table; built in `packet_core.py`.
- **Snapshot Hash** — content-addressed hash that tamper-proofs the packet. Any change recomputes; mismatch = tampering.
- **Rubric Version** — the versioned scoring rules in effect when this packet was generated. Lets old packets be re-evaluated under newer rubrics without losing history.

Inside the packet:

- **Risk Signal** — type / severity / confidence / explanation, with citations. The "what's the risk here" verdict.
- **Action Plan** — list of **Action Items** for the operator (title + rationale + `evidence_needed`).
- **Claims Timeline** — chronological reconstruction (`TimelineEvent`: at / label / source).
- **Underwriting Memo** — LLM-generated synthesis (summary + open questions + provider/model attribution + optional `fallback_reason`).
- **Citation** — source-attributed evidence (`source_id` / `source_type` / `excerpt`). Every claim in the packet ties back to one. `CitationRecord` carries `validation_status` per claim.
- **Review Decision** — the Approve / Block / Request More Info verdict on a packet, attributed to a reviewer with optional `override_reason`.

---

## Pipeline

- **Agent Pipeline** — the orchestrated agents that turn an incident into a packet, run synchronously (~200ms). Order: retrieval → risk evaluator → claims timeline → memo → (Phase 2) corroboration. Lives in `app/agents/runtime.py`.
- **Phase 1 / Phase 2 / Phase 3** — Phase 1 is the synchronous text pipeline. Phase 2 is async vision on uploaded evidence. Phase 3 is live camera monitoring with push alerts.
- **Vision Pipeline** — async image/video analysis on uploaded evidence. Findings update the packet after the fact.
- **RTSP Sampler** — background-threaded service that connects to IP cameras, samples frames every N seconds, runs them through Gemini 2.5 Flash, and applies a 3-gate filter before persisting an `AlertEvent` and dispatching a push notification. Singleton at `app/services/rtsp_sampler.py::sampler`.
- **Alert Dispatcher** — sends Web Push notifications to operator subscribers, records feedback, logs false-alarm rates for threshold observability. Lives in `app/services/alert_dispatcher.py`.
- **Corroboration** — vision findings vs the written report. Tagged `CONSISTENT` / `PARTIAL` / `CONTRADICTED` / `INCONCLUSIVE`.
- **Memo Provider** — pluggable LLM backend for memo generation. Two implementations: `AnthropicProvider` (live LLM, with prompt caching on the system block) and `DeterministicProvider` (template-based; eval-stable). Mode selected at request time.
- **Knowledge Sources** — venue-scoped corpus of policy docs and reference material. Retrieved via `SemanticKnowledgeBase` (TF-IDF cosine, with keyword fallback if sklearn missing). Lives in `app/rag.py`.
- **Brawl Incident Flow** — `create_brawl_incident_flow()` in `incident_flow.py`. Despite the name, it's the general incident entry point, not brawl-specific. (Naming debt; rename pending.)

---

## Eval

- **Eval Set** — 15 research-grounded scenarios across 7 exposure classes. Lives in `backend/app/evals/`.
- **Scorer** — deterministic scoring function. Five of them.
- **Scoreboard** — public Next.js dashboard at `/evals` reading a JSON snapshot.
- **Live Mode vs Snapshot Mode** — eval can run live against `AnthropicProvider` (writes a fresh snapshot with `ProviderInfo`) or replay against a stored snapshot. Live mode is non-deterministic and used for measuring real provider quality; snapshot mode is what CI / the public dashboard reads.

---

## Where things live

| Concern | File |
|---------|------|
| Pydantic API contracts | `backend/app/schemas/domain.py` |
| Stream event payloads | `backend/app/schemas/events.py` |
| DB tables (SQLModel) | `backend/app/models.py` (incl. `CameraFeed`, `AlertEvent`, `PushSubscription`) |
| Seed VENUES + knowledge + stream events | `backend/app/seed_data.py` |
| FastAPI routes + `_resolve_venue` | `backend/app/main.py` |
| Incident → packet entry point | `backend/app/incident_flow.py` |
| Agent orchestration | `backend/app/agents/runtime.py` |
| RAG (TF-IDF) | `backend/app/rag.py` |
| Live venue state manager | `backend/app/live_state.py` |
| Packet snapshot + hashing | `backend/app/packet_core.py` |
| Memo providers (Anthropic / deterministic) | `backend/app/providers/` |
| Eval harness + scorers | `backend/app/evals/` |
| RTSP sampler + 3-gate filter | `backend/app/services/rtsp_sampler.py` |
| Web Push alert dispatch | `backend/app/services/alert_dispatcher.py` |
| PWA service worker | `frontend/public/sw.js` |
| Push subscription hook | `frontend/src/hooks/usePushNotifications.ts` |
| Alerts page | `frontend/src/app/alerts/page.tsx` |
| Web UI | `frontend/` (Next.js 16, App Router) |
| Mobile UI | `mobile/` (Expo / RN) |

---

## Conventions worth knowing

- **`_resolve_venue` is the precondition.** Anything taking a `venue_id` from a route assumes `_resolve_venue` ran first (raises 404 + populates `VENUES[venue_id]`). Functions that take `venue_id` downstream should trust that and use `VENUES[venue_id]` directly — silent fallbacks are explicitly removed (see commits `4e1cd3d`, `f231a8a`).
- **JSON columns over normalized tables for AI output.** `risk_signal`, `action_plan`, `underwriting_memo`, `claims_timeline` are all JSON columns on `IncidentEvaluation` / `UnderwritingPacket`. Schema flexibility > query ergonomics for evolving agent contracts.
- **Two carrier-facing guarantees the codebase enforces:** (1) every claim cites a source the packet was built from, (2) every packet is reproducible from its `snapshot_hash` + `rubric_version_id`. Don't break either.
