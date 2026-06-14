# Nightline — LLM-Usage Gap Analysis vs. the Insurtech AI-Native Field

**Prepared:** 2026-06-14 · **Companion to:** [`insurtech-ai-native-landscape.md`](./insurtech-ai-native-landscape.md)
**Grounding:** the 28-company dossier + direct read of our LLM-touching code (`agents/runtime.py`, `copilot/engine.py`, `copilot/faithfulness.py`, `intelligence/engine.py`+`finding.py`, `rag.py`, `providers/__init__.py`, `copilot/openai_compatible_provider.py`, `evals/runner.py`).

> **BLUF.** We are architecturally aligned with the modal funded-leader design (deterministic core + LLM annotation + grounding guard), and we already ship a portable, baseline-gated eval harness with adversarial scorers — something two whole field segments (pricing, claims) document *nobody* shipping. Our genuine deficits are narrow and solo-closable: (1) no calibration of confidence against realized outcomes; (2) no per-output confidence/provenance object; (3) no LLM-as-judge/jury meta-eval. Everything else we "lack" is either a deliberate, defensible non-gap or a commoditized me-too to decline.

## §1 — Field-wide LLM-usage taxonomy

| # | Category | Exemplars | Prevalence |
|---|----------|-----------|------------|
| 1 | Document/submission extraction → structured output | Kalepa, Cytora, Sixfold, Counterpart, Roots, Comulate | **Table stakes** |
| 2 | Classification / triage / risk-selection | Sixfold, Federato, Gradient, Qantev | Table stakes → rising |
| 3 | Retrieval-grounded Q&A copilots | Indemn, Roots/Bevaya, Liberate | Rising |
| 4 | Agentic action-taking (HITL on irreversible step) | Sixfold, Cytora, Comulate, Liberate | **Differentiator** |
| 5 | **Correctness/eval infrastructure** | Kalepa (run-time confidence intervals), Cytora (7-exec inter-agent confidence), Nirvana (LLM-as-jury, meta-eval'd judges), Roots (Verifier model) | **The frontier** — pricing & claims segments have NOBODY |
| 6 | Multi-provider routing / model abstraction | Roots, Outmarket | Rising |
| 7 | Conversational voice agents | Liberate, Nirvana | Differentiator (segment-specific) |
| 8 | Net-new fuzzy detection | Sixfold, Cytora, Gradient | Differentiator |
| 9 | **Deterministic-core + LLM-annotation** | Tesora, Federato, Gradient, Akur8 | **Unclaimed ground Nightline can own** |

Two load-bearing refinements: **AI-native ≠ LLM-native** (a deterministic engine annotated by an LLM is a recognized native shape), and **surface novelty is gone** ("we cite sources / have confidence scores" is shipped by Sixfold/Cytora/Roots/Nirvana — we must claim *superior rigor* or *vertical reach*, not novelty).

## §2 — Where Nightline sits today (code-grounded)

| Category | What we do today | Tier | Status |
|---|---|---|---|
| 1 Extraction | Nothing — inputs arrive pre-structured (`IncidentCreate`) | Absent | — |
| 2 Classification | `RiskClassifierProvider` → then **hard-signal escalation in code** (model can't relax a real severity); `general_incident`→`needs_review` | Strong / differentiated | Live |
| 3 RAG copilot | Read-tool calls + `assert_grounded` numeric check downgrades ungrounded answers | Strong | Live (TF-IDF retrieval) |
| 4 Agentic actions | **Deliberately deterministic** — regex-intercepted, validator-gated, confirm-required | Defensible non-LLM | Live |
| 5 Eval infra | `evals/runner.py`: gold+adversarial scenarios, scorer suite + NDCG/MRR + safety scorers, **baseline.json gating per stack-signature**; findings persist as falsifiable `Prediction`s | Differentiated harness, missing 2 pieces | Live |
| 6 Multi-provider | Anthropic→Gemini→deterministic (packet); COPILOT_LLM_*→Grok→Anthropic→deterministic (copilot), 429 backoff | At/above bar | Live |
| 7 Voice | Transcription providers exist; no voice agent | Absent | Dormant |
| 8 Fuzzy detection | TF-IDF cosine + LLM risk-typing | Partial | Live |
| 9 Deterministic-core + annotation | `intelligence/engine.py` 100% deterministic, persona-gated in code, failure-isolated — the trust foundation | Differentiated (rarest) | Live |

## §3 — What we're lacking

**(a) Genuine gaps to close**
- **A1 — Confidence is heuristic, not calibrated.** We persist findings as falsifiable predictions and resolve them, but nothing compares predicted confidence to realized outcomes; the `0.04·police` weights are guessed. *Field bar: Kalepa tracks confidence over time to detect silent regressions.* **[HIGHEST LEVERAGE]**
- **A2 — No per-output confidence/provenance object.** Pieces exist (`RiskSignal.confidence`, `assert_grounded`, citations) but no unified `{value, confidence, provenance, routing_decision}` envelope. Without it our "confidence-routing" GTM claim is asserted, not demonstrable.
- **A3 — No LLM-as-judge/jury meta-eval.** Scorers compare against fixed gold strings; blind to open-ended quality (memo faithfulness). *Field bar: Nirvana's meta-evaluated judge — the dossier's most rigorous eval artifact.*
- **A4 — No document extraction.** Table stakes everywhere; only matters for the **Clearform** broker-intake pivot. Defer otherwise.

**(b) Deliberate non-gaps — DEFEND**
- TF-IDF retrieval (correct for small corpus; embeddings = cost/ops with no justification; interface already swappable)
- Deterministic findings engine (the trust thesis)
- Deterministic copilot actions (matches field HITL-on-irreversible norm)
- Hard-signal escalation in code (the "model can't relax a real severity" guarantee)

**(c) Commoditized — decline/defer:** marketing citations as novel (have them, don't lead with it); voice agents (off-thesis); multi-provider routing as a selling point (have it, it's bar not differentiator).

## §4 — Prioritized roadmap (value × low-risk × low-cost)

Constraints: solo builder; one Grok key → all judge/extraction work offline/batched/CI-bounded, never per-request; deterministic intelligence engine stays the trust foundation; every item ties to a measurable eval exploiting the findings-as-falsifiable-predictions loop.

🥇 **#1 — Close the calibration loop (A1).** Calibration report (reliability curve + Brier/ECE per persona-kind) comparing each `RiskFindingRecord.prediction` confidence vs. realized `resolved`/open outcome, wired into `evals/runner.py` as a baseline-gated scorer. ~Zero LLM cost (arithmetic over data we already persist), minimal risk (additive measurement), uniquely ours (exploits a seam nobody else in the dossier has). Turns "confidence-calibrated deterministic risk scoring" from claim → number. Prerequisite for #2 and #3.

2. **Per-output `ConfidenceEnvelope` (A2)** — assemble from inputs in hand; eval = routing-decision accuracy vs. gold `review_status` + calibration via #1.
3. **Meta-evaluated LLM-judge scorer (A3)** — opt-in memo-faithfulness judge, meta-eval'd against deterministic scorers (inverse-Nirvana); offline, one Grok key, CI-only.
4. **Structured-extraction provider (A4)** — only if Clearform proceeds; reuse the `RiskClassifierProvider` tool-use pattern with per-field confidence.

❌ **Do NOT:** swap TF-IDF for embeddings; let the LLM own a decision number or execute a mutation; build voice agents; run any judge/extraction work in the request path.
