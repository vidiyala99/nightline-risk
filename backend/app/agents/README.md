# Underwriting Packet Agent Contracts

This directory contains product runtime prompt contracts for the underwriting packet flow. They are not Codex instructions or local development instructions.

## Current Runtime Status

The contracts in this directory are loaded by `backend/app/agents/runtime.py` during the incident packet flow. Execution is **provider-backed with a deterministic fallback**, resolved per-process by which API key is set (`app/providers/__init__.py`): `ANTHROPIC_API_KEY` → Claude, else `GEMINI_API_KEY` → Gemini (`gemini-2.5-flash-lite`), else the deterministic template provider.

- The **risk-evaluator** and **underwriter-memo** steps route through the provider layer (`self._risk_classifier` / `self._memo_provider`). On any provider error they fall back to the deterministic provider, so a packet is never blocked by an LLM hiccup.
- The **retrieval**, **customer-action**, and **claims-timeline** steps still run deterministic Python over seeded sources and stream events.
- **Bulk startup backfill** (`app/main.py`) is pinned to the deterministic provider regardless of key, so booting never burns the LLM's free-tier quota in a burst. Live incident creation uses the configured provider, so a freshly submitted incident exercises the real LLM path.

The provider-backed wiring is gated by a regression eval harness (`app/evals/`, deterministic baseline + CI `--compare-baseline` gate) — the precondition this README originally deferred to.

## Shared Principles

- Every factual output must be traceable to reported incident facts or cited sources.
- Citations use `source_id` values from retrieved knowledge sources, stream events, or explicitly named packet inputs.
- Agents must separate venue/customer-facing tasks from underwriter-facing findings.
- Agents must state uncertainty, missing evidence, and open questions instead of inventing facts.
- Review status must be explicit when evidence is incomplete, contradictory, or high impact.
- Outputs should be JSON-compatible so deterministic code, future LLM calls, and eval fixtures can share the same contract.

## Contract Index

- `retrieval_agent.md`: decides source search intent and citation requirements.
- `risk_evaluator_agent.md`: maps incident facts and cited evidence to severity, confidence, and review status.
- `underwriter_memo_agent.md`: drafts underwriter-facing memo content from cited evidence.
- `customer_action_agent.md`: converts underwriting gaps into venue/customer-facing evidence tasks.
- `claims_timeline_agent.md`: reconstructs a source-backed claims defensibility chronology.

### Standalone agent contracts (not in `REQUIRED_CONTRACTS`)

These run outside the packet runtime (the evidence pipeline / claim routing), so
they are documented + eval-gated but not loaded by `runtime._load_contracts`:

- `fraud_agent.md`: deterministic fraud/SIU scoring; eval `app/evals/fraud_scorer.py`.
- `vision_agent.md`: Gemini 2.5 Flash (with deterministic template fallback) visual
  findings feeding risk scoring + fraud; eval `app/evals/vision_scorers.py`
  (routing / honesty / mapping, all key-free).

## Future Runtime Integration

Provider setup, the deterministic-fallback boundary, and regression evals now exist (done). Remaining work: route the still-deterministic steps (retrieval, customer-action, claims-timeline) through the provider layer where an LLM adds value. The vision agent is now folded into the eval-gated contract (`vision_agent.md` + `app/evals/vision_scorers.py`); the deterministic corroboration/orchestration workers are governed by code + tests (no `.md` warranted). Any new provider-backed step should land behind the eval baseline gate, same as the memo and risk-evaluator steps.
