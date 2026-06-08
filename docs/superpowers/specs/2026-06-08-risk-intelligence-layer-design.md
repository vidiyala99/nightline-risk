# Risk Intelligence Layer + Proactive Exposure Surface — Design

**Date:** 2026-06-08
**Status:** Design / awaiting review
**Scope of this spec:** Sub-project 1 of the *Risk Intelligence Loop* program (defined below). Later sub-projects (copilot, hybrid retrieval, outcome feedback, continuous monitoring) get their own spec → plan → build cycles. Their key architectural choices are *recorded* here so this foundation is built to grow into them, but they are **not** implemented in this spec.

---

## 1. The long-term change (North Star)

Insurance today — and most insurtech — is **reactive risk transfer**: buy a policy, something bad happens, file a claim, fight over coverage, premium goes up. The data only matters at claim time, and by then the documentation is bad and the exposure was never managed. The software underneath is a **system of record**: it stores incidents, policies, claims, and dashboards display them.

The durable change Nightline is positioned to drive is the shift from **system of record → system of risk intelligence + closed-loop action**, and with it, **reactive claims-paying → continuous risk prevention**. The system doesn't just *hold* the evidence→claim→defense→underwriting chain — it continuously *interprets* it into "where is risk accumulating, what will become a loss, what should each actor do now," then *closes the loop* by driving and measuring the action.

```
   SURFACE  →  RECOMMEND  →  ACT (gated)  →  MEASURE  →  RECALIBRATE
   (panels)    (copilot/      (lifecycle     (outcome    (eval / calibration
                agents)        tools)         capture)     harness = trust spine)
       ▲────────────────────────────────────────────────────────┘
```

The eval/calibration harness is not QA infrastructure in this frame — it is the **trust spine** of the loop: it is what lets the system responsibly *drive action* and *prove it is getting better with use*. Every documented incident, adjudicated claim, and corroborated fraud signal feeds back into better judgments. The system compounds.

### Program decomposition

| # | Sub-project | Arm of the loop | Status |
|---|---|---|---|
| **1** | **Risk Intelligence Layer + proactive exposure surface** | SURFACE + the foundation everything hangs off | **This spec** |
| 2 | Conversational copilot (provider-agnostic, persona-aware) | RECOMMEND / ACT surface on the layer | Later spec |
| 3 | Routed multi-strategy retrieval + comms-as-grounding | feeds the layer richer evidence | Later spec |
| 4 | Closed-loop outcome feedback → recalibration | MEASURE + RECALIBRATE | Later spec |
| 5 | Continuous monitoring / ingestion-triggered re-evaluation | makes SURFACE continuous | Later spec |

Sub-project 1 is first because it is the genuine product simplifier, it is deterministic and trustworthy (zero hallucination risk), it feeds the existing calibration harness immediately, and it is the layer the copilot and agents become surfaces *of*.

---

## 2. Why this is value, not noise

Dashboards have three structural limits, and the value lives in those gaps:

1. **Pull, not push** — they show what you go looking for; they cannot tell you about a problem you did not know to check.
2. **Siloed by entity** — incidents page, compliance page, policy page; the risk that matters lives in the *join* (open incident + coverage gap + renewal in 30 days = exposed), which no single screen shows.
3. **State, not implication** — "incident #214: open, no evidence" is data; "if a claim is filed it will likely be denied — attach evidence" is meaning + next action.

The unifying missing thing across every persona is a derived **"what matters now + why + what to do"** layer. The raw data is displayed everywhere; the prioritization and synthesis is nowhere.

The honest design consequence: **the biggest simplifier is the proactive, deterministic surface, not a chat box.** Asking a question is work; a panel that *tells* you "3 incidents missing evidence, 1 renewal in 21 days, 2 compliance items overdue — here's what's exposed" requires nothing and carries zero hallucination risk. The copilot (sub-project 2) is the conversational face of this same layer, not a separate system bolted on.

---

## 3. The core abstraction — `Finding`

A decoupled `app/intelligence/` module holds a registry of *risk judgments*. Each judgment is a **deterministic, persona-gated, cited function over cross-entity data** that emits zero or more `Finding`s.

```
Finding = {
  id:                 stable identity (persona + kind + subject), used for dedup + outcome tracking
  persona:            broker | venue_operator | adjuster (carrier role) | ...
  subject:            { entity_type, entity_id, label, href }   # links to the existing screen
  kind:               evidence_gap | compliance_overdue | renewal_approaching
                      | coverage_gap_eo | renewal_at_risk | submission_stalled
                      | reserve_light | fraud_unreviewed
  severity:           ranked, deterministic (see §6)
  why:                [Citation]    # traces to exact rows/docs — verifiable, click-through
  recommended_action: { label, href | tool_ref }   # the "what to do next" the dashboard never gives
  prediction:         { claim, falsifiable_by, horizon }   # for later outcome scoring (sub-project 4)
  computed_at:        now_utc
}
```

`why` reuses the existing `Citation` schema (`doc_id`/`node_id`/`page_start`/`page_end`/`path`/`clause_id`). `subject.href` deep-links to the entity's existing detail screen so every finding is verifiable in one click. `prediction` is recorded now so sub-project 4 can score whether reality matched — but **nothing scores it in this spec**; this is a seam, not a feature here.

### Judgment kinds for the first cut

Prioritized to the personas where the intelligence layer is genuinely transformative — **operator / broker / adjuster**. Underwriter and carrier judgments are deferred (the platform's own memo/pricing features already do their heavy lift; they come "free" on this layer later and are not led with).

**Venue operator**
- `evidence_gap` — open `IncidentRecord` with thin/absent `EvidenceFile`s → claim-defense risk.
- `compliance_overdue` — `ComplianceSignal` past due / unresolved.
- `renewal_approaching` — operator's `Policy` expiring within window.

**Broker**
- `coverage_gap_eo` — bound `Policy` missing an expected `CoverageLine` for the venue's appetite → E&O exposure.
- `renewal_at_risk` — `Policy` expiring within window with **no** `PolicyRequest` in motion.
- `submission_stalled` — `Submission` sitting in a non-terminal state past a staleness threshold.

**Adjuster (carrier role)**
- `reserve_light` — `Claim` whose reserve looks inadequate vs. payments/exposure.
- `fraud_unreviewed` — `EvidenceAnalysis`/corroboration or `FraudSignal` flag with no review decision.

Each kind is one module under `app/intelligence/findings/`, independently testable.

---

## 4. Architecture & component boundaries

```
GET /api/intelligence/exposure
        │  (persona-gated, optional ?venue= / ?subject=)
        ▼
┌─────────────────────────────┐
│  intelligence/engine.py      │  resolve persona scope → run allowed judgments → rank → persist → return
└───────────┬──────────────────┘
            │ runs only the persona's allowed modules, over the gated scope
            ▼
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  intelligence/findings/*.py  │  ───►  │  gated DB queries              │
│  one pure fn per judgment    │        │  (accessible_venue_ids,        │
│  (scope) -> list[Finding]    │        │   require_carrier,             │
│  + attaches Citations        │        │   can_read_venue_floor)        │
└───────────┬──────────────────┘        └──────────────────────────────┘
            │ persist
            ▼
┌─────────────────────────────┐
│  RiskFindingRecord (table)   │  findings persisted as predictions (outcome-capture seam for sub-project 4)
└─────────────────────────────┘
```

Built to protect the long term:

1. **`app/intelligence/findings/`** — one module per judgment kind, each a pure function `(scope) -> list[Finding]`. This is the *only* place risk logic lives; surfaces never re-implement it. An LLM-assisted judgment later is just another module (eval-gated) — the interface does not change.
2. **`app/intelligence/engine.py`** — resolves the persona's allowed judgment set + gated scope, runs the modules, ranks (§6), persists, returns. Pure orchestration; no SQL of its own, no UI concerns.
3. **API — `app/api/v1/intelligence.py`** — `GET /api/intelligence/exposure`. Persona-gated like every other router (`authorization` header → decode → `require_*`). Honors the venue-scoping convention: optional `?venue=` / `?subject=` for both brokers and operators via the venue-scoped path when present (per the data-integrity convention in CLAUDE.md). Response model in `app/schemas/`.
4. **Surface — proactive "Attention / Exposure" panel** — per-persona, on the home/dashboard, **web + mobile parity**. Proactive (no question required); every finding click-throughs to its cited source. *This is the simplifier.* Web uses the hand-written `lib/*.ts` typed-client + `authHeaders()` pattern; mobile mirrors it.
5. **Outcome-capture seam — `RiskFindingRecord`** — findings persist with their `prediction`, so the calibration arm (sub-project 4) can later score reality vs. prediction, in the style of the existing `calibration.py` metrics. **This spec only writes the records; it does not score them.**
6. **Eval — `app/evals/` extension** — gold scenarios per judgment kind: right findings flagged, severity correct, and a **low false-alarm rate** (critical for trust). Committed baseline + regression gate, reusing existing harness patterns.

### Data flow (one request)

1. Request → decode token → resolve persona + gated scope (`accessible_venue_ids`, role gates).
2. Engine selects the persona's allowed judgment modules.
3. Each module queries only the gated rows, computes `Finding`s, attaches `Citation`s.
4. Engine ranks by severity (§6), dedups by `Finding.id`.
5. Findings persisted as `RiskFindingRecord` (predictions).
6. Ranked findings returned; surface renders proactively. Nothing requires the user to ask.

---

## 5. Data model

New table (SQLModel, following `app.time.now_utc`, money-as-strings, JSON-list read-boundary coercion conventions):

```
RiskFindingRecord
  id: str (pk)                      # stable Finding.id
  persona: str
  kind: str
  subject_type: str
  subject_id: str
  severity: str                     # enum string
  severity_rank: int                # numeric for ordering / stable sort
  why: JSON                         # list[Citation] — coerce at read boundary (Neon JSON-string rule)
  recommended_action: JSON
  prediction: JSON                  # { claim, falsifiable_by, horizon } — seam for sub-project 4
  status: str                       # open | resolved | dismissed
  tenant_id / venue_id refs         # for scoping + audit
  computed_at: datetime = now_utc
  resolved_at: datetime | None
```

- **JSON columns coerced at the read boundary** (the Neon-vs-SQLite JSON-string class of bug): `why`, `recommended_action`, `prediction` round-trip as strings on Postgres — coerce/`json.loads` with try/except at read, never iterate raw.
- **Schema self-healing:** add the new columns to `_COLUMN_MIGRATIONS` in `database.py` (existing-table SELECTs fail otherwise).
- A finding flips to `resolved` when its underlying condition no longer holds on recompute (e.g. evidence attached) — recorded for the outcome loop.

---

## 6. Severity ranking ("risk reranking")

Deterministic ordering, not ML. Each judgment module returns a severity derived from concrete, explainable factors (e.g. `evidence_gap` severity rises with incident injury/police/EMS flags + claim-likelihood; `renewal_at_risk` rises as days-to-expiry shrinks with no request in motion). The engine sorts by `(severity_rank desc, computed_at)`. **List contents are sorted before any hashing/serialization** (the Postgres list-order-drift rule). No LLM, no embeddings — this is why the surface is trustworthy.

---

## 7. Error handling & trust

- **Deterministic → no hallucination risk.** This is the foundation's whole point.
- A failing judgment module degrades to **"not computed"** for that kind — never a wrong finding, never a 500 to the spinner (the Neon-500-hangs-the-frontend lesson). Engine isolates each module in try/except and surfaces partial results.
- **Persona gate enforced in code**, not prose — a finding for data the persona cannot access is never produced.
- **Every finding is verifiable** via its `Citation`s and `subject.href`.

---

## 8. Eval & trust spine (this spec's slice)

- Extend `app/evals/` with an **intelligence** scenario set: per-kind gold cases asserting (a) the right findings are produced, (b) severity is correct, (c) **false-alarm rate stays under a committed threshold**.
- Reuse the baseline-gate pattern (`baseline.json` + regression gate; `--compare-baseline` exits 1 on regression).
- **LLM-as-judge is NOT used in this spec** (findings are deterministic; deterministic scorers suffice and are reproducible/bias-free). LLM-as-judge is recorded as a later-sub-project tool (§9) for the subjective dimensions deterministic scoring cannot reach (faithfulness, action appropriateness).

---

## 9. Choices recorded for later sub-projects (not built here)

These are written down so this foundation is built toward them, and so the rationale (including deliberate omissions) is on record.

### Retrieval strategy — routed, multi-strategy (sub-project 3)

Three strategies, each chosen by **data shape**, not fashion:

| Query shape | Strategy | Rationale |
|---|---|---|
| Structured / cross-entity | **Graph traversal over the relational schema** (this layer) | Relationships (`Claim→Policy`, `incident→packet→citation`, `venue→incident`) are already exact DB rows — traverse them directly. |
| Policy / legal clause | **Vectorless tree navigation** (PageIndex-style) over the existing `PolicyDocument` hierarchical tree | Policy docs are highly structured; clause-level precision matters; embeddings blur it; the tree (`node_id`/`clause_id`/`tree_json`) already exists. |
| Comms / freeform unstructured text | **Hybrid embeddings + lexical (RRF)** | Chatty, low-structure text; semantic+lexical fusion is the right baseline. Wires the currently dead embedding providers (OpenAI `text-embedding-3-small` / Gemini); vectors on pgvector (Neon) + portable Python cosine for local SQLite. |

**Deliberately NOT used, and why:**
- **GraphRAG (LLM-extracted entity graph from text):** the graph is already structured as exact DB rows. Using an LLM to reconstruct it would be less accurate (hallucinated edges) and slower. Graph *traversal* over the relational model beats graph *extraction*.
- **Reranking (default):** off unless retrieval eval shows lift (the Vault assignment learned this — the reranker added no benefit). Add behind an eval flag only.
- **LLM-wiki (index-time synthesis):** optional enhancement for stable high-value docs (bound policies) only; staleness + per-doc cost make it overkill as a default.

### Conversational copilot (sub-project 2)

Provider-agnostic streaming + tool-call seam (`ChatProvider` ABC: Anthropic → Gemini → deterministic, keyless CI via the deterministic path). **Bounded agentic tool-use**, not open-ended: tools are (a) the intelligence-layer queries and (b) the routed retriever; act-tools are **confirm-gated** and execute only through existing `_transition_*` lifecycle helpers, so an invalid state change is impossible and every action emits an `AuditEvent`. `<<<META>>>`-style structured tail for `answer_type`/citations/followups; grounding downgrade; faithfulness guard. Connectors-as-grounding (comms) is in scope for retrieval; **outbound** is **draft-only** (copilot composes, human sends) — autonomous send is cut.

### Closed-loop feedback (sub-project 4)

Scores `RiskFindingRecord.prediction` against reality using the `calibration.py` metric style (did the thin-evidence incident get denied? did the renewal lapse?), feeding recalibration. **LLM-as-judge** is introduced here for subjective dimensions, used surgically and sharing one judge definition between serve path and evals.

---

## 10. Attention / outreach success criteria (build toward these)

This project is the user's builder-identity / networking artifact. The build must yield concrete, linkable hooks to drop into founder outreach (lead with *shipped/live + depth*; never cite test counts as credibility). Two are promoted to **explicit deliverables** because they are the outreach currency:

1. **A live, linkable hero flow** — one 2-sentence, stranger-legible story, clickable in ~30s on `nightline-app.vercel.app`. The candidate hero: *the system spots a thin-evidence incident, flags it as a claim-defense exposure with the cited gap, and recommends the fix — later (sub-project 4) the calibration loop confirms the prediction.* Design toward this one flow, not a feature tour.
2. **A public-facing trust/eval surface** — extend the existing `/evals` page into a live, public eval + calibration dashboard ("faithfulness scores, calibration curve vs. real outcomes, techniques rejected and why"). This is the single highest-leverage outreach link: a 10-second click that *proves* correctness instead of asserting it, which almost no candidate portfolio has.

Per-recipient hook menu the overall program supports: **eval/correctness** founders → the trust dashboard; **agentic** founders → the gated action flow (sub-project 2); **insurance-domain** founders → the operator exposure demo (this spec).

---

## 11. Explicit YAGNI cuts for this spec

- No LLM judgments (deterministic findings only).
- No copilot / no streaming / no tool-calling.
- No retrieval / embeddings / vectors / vectorless navigation (no text grounding in sub-project 1).
- No outcome *scoring* (only prediction *capture*).
- No real-time push (computed on load/refresh).
- No underwriter / carrier judgment kinds.
- No outbound actions.

All are later sub-projects on these seams.

---

## 12. Testing

- **Unit:** each judgment module in isolation — gating (no cross-persona leakage), correct findings, correct severity, no false alarms on clean fixtures.
- **Engine:** persona scope resolution, module isolation on failure (partial results, no 500), dedup, ranking order.
- **API:** persona gating (403/401), venue-scoping param honored for both broker + operator, JSON read-boundary coercion on Postgres-shaped data.
- **Eval:** intelligence gold scenarios + committed baseline gate.
- **Frontend:** vitest + Playwright for the exposure panel (web); mobile parity check. Grep `frontend/e2e/` on any copy/selector touch.
- Full backend suite green (`cd backend && python -m pytest -q`).
