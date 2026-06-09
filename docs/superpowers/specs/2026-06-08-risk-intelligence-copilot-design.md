# Risk Intelligence Copilot (Sub-project 2) — Design

**Status:** Approved (brainstorm 2026-06-08).
**Parent program:** Risk Intelligence Loop. Sub-project 1 (deterministic Exposure Panel) shipped; this is sub-project 2. Sub-project 3 (routed retriever) and 4 (closed-loop feedback) remain future specs.
**Parent spec:** [`2026-06-08-risk-intelligence-layer-design.md`](2026-06-08-risk-intelligence-layer-design.md) §210-212 records the copilot's architectural intent; this spec is the buildable v1.

---

## 1. Summary

A persona-aware **conversational copilot** for the venue operator, surfaced at a dedicated `/copilot` page. It answers grounded questions about the operator's exposure / risk / claims / compliance and can take **one of two confirm-gated actions** (send a recommendation to the broker; resolve a compliance item by uploading evidence). It is **deterministic-first**: even with no API key it produces useful, grounded answers by routing intent → tool → templated response; an LLM provider behind the same seam is an optional, key-gated enhancement held to the same faithfulness contract.

The headline is the same as the rest of Nightline: **it cannot hallucinate, because the provider only ever speaks from tool results** — and that guarantee is enforced by an eval harness wired into the regression gate.

## 2. Goals & non-goals

**Goals**
- Subscription-free: the CI suite and the local/live demo run the **deterministic** provider (no key).
- Zero-hallucination by construction: every asserted fact traces to a tool result + citation.
- One seam for deterministic ↔ LLM providers (one env var flips it), mirroring the existing memo-drafter pattern (`AnthropicProvider` → `DeterministicProvider`).
- Bounded agentic action: exactly two confirm-gated actions, each executing only through an existing audited service path, never autonomously.
- Eval-gated: a deterministic gold set + scorers wired into `--compare-baseline` and the `/evals` scoreboard.

**Non-goals (YAGNI cuts for v1)**
- No streaming (return the full reply; the seam does not preclude streaming later).
- No retrieval / embeddings / vector or tree navigation (that is sub-project 3; v1 grounds only on the deterministic intelligence layer + bounded structured DB lookups).
- No conversation/transcript persistence (stateless single-turn; the only carried state is a pending action descriptor).
- No broker or carrier personas (operator only; the seam generalizes later).
- No outbound email/SMS/Slack (the broker action creates the **in-app** `ClaimProposal`, not a message).
- Web only (mobile parity is a thin follow-on against the same `/api/copilot/message`).

## 3. Architecture — the seam (`app/copilot/`)

A decoupled package mirroring `app/intelligence/`.

- **`app/copilot/provider.py` — `ChatProvider` ABC**: `respond(turn: CopilotTurn) -> CopilotReply`. The provider receives the turn (message + persona scope + the available tool catalog + any echoed `confirm_action`) and returns a structured reply. **The provider never touches the database** — it only calls tools. This boundary is what makes both providers faithful and independently testable.
- **`DeterministicChatProvider`** — the keyless CI/demo path (see §9).
- **`AnthropicChatProvider`** — real but key-gated; raises `ProviderNotConfiguredError` without `ANTHROPIC_API_KEY` (same shape as the existing `app/providers/anthropic_provider.py`). Held to the faithfulness guard.
- **`get_chat_provider()`** — selector: LLM when a key is present, else deterministic.
- **`app/copilot/tools.py` — the tool layer**: each tool is a pure, typed function `run(scope: CopilotScope, args: dict) -> ToolResult`. `CopilotScope` carries the authenticated operator + venue gate. `ToolResult` carries `data` + `citations` (provenance), so grounding travels with every tool result.
- **`app/copilot/engine.py` — `respond_to_message(user, session, message, confirm_action=None)`**: resolves persona scope, builds the tool catalog, invokes the selected provider, runs the faithfulness guard over the reply, and (when a `confirm_action` is echoed) re-validates and executes it. Isolated-failure discipline like `intelligence/engine.py`.

## 4. Tools (operator v1)

**Read tools** (persona-gated; reuse existing services — no new business logic):

| Tool | Source | Answers |
|---|---|---|
| `get_exposure` | `intelligence.compute_exposure` | "what needs my attention / what's exposed" |
| `get_risk_score` | venue risk-score service | "why is my risk a C / top drivers" |
| `list_open_claims` | venue claims (venue-scoped) | "what claims are open / their status" |
| `list_incidents` | venue incident-status feed | "what's the status of my reports" |

**Act-tools — two-phase, confirm-gated.** Phase 1 returns a typed `ProposedAction` descriptor (id, human summary, the gating it passed); the client echoes it back as `confirm_action`; the server **re-validates gating before executing** (never trusts the client echo). Execution flows through the existing audited service.

| Act-tool | Phase-1 validation | On confirm |
|---|---|---|
| `propose_send_to_broker(incident_id)` | borderline routing **and** `has_active_policy` **and** no existing proposal | `create_proposal(...)` (idempotency-guarded) → `claim.proposed` AuditEvent → "Awaiting broker" |
| `propose_resolve_compliance(item_id)` | item exists **and** is unresolved; the required evidence is named | upload the **attached** file via `upload_compliance_evidence(...)` (which resolves the item) → existing compliance audit |

`propose_resolve_compliance` requires a file attachment (operator compliance resolution is evidence-backed; there is no pure "mark resolved" path). The copilot surfaces the item and the required evidence; the operator attaches the file and confirms.

## 5. Grounding & faithfulness contract

Every `CopilotReply`:
- `answer_type ∈ {answer, clarify, refuse, propose_action}`
- `text` — the grounded natural-language reply
- `citations: list[Citation]` — provenance carried from the tool results the text draws on
- `proposed_action: ProposedAction | None` — present iff `answer_type == propose_action`
- `followups: list[str]` — suggested next questions

**Faithfulness guard** (`app/copilot/faithfulness.py`): the reply text may assert only facts present in the tool results it cites. The deterministic provider is faithful by construction (it templates from tool results). The LLM provider is *checked*: an ungrounded assertion downgrades the reply to a grounded subset ("I can only speak to …"), never shipped as a guess. The same guard function backs the `faithfulness` eval scorer (one definition, serve + eval).

**Refusal is deterministic**: out-of-scope intent or no matching tool → a fixed refusal naming what the copilot *can* do. Never a guess.

**LLM META tail**: the `AnthropicChatProvider` emits a trailing `<<<META>>>{json}` block (answer_type / citations / followups) parsed off the response; the deterministic provider builds the same struct directly. The text-vs-META split keeps the human-facing text clean while machine fields stay structured.

## 6. API & data flow

- **`POST /api/copilot/message`** (operator-gated via `require_venue_access` on the resolved venue). Body: `{ message: str, confirm_action?: ProposedAction, attachment?: <multipart file for compliance resolve> }`. Returns `CopilotReply`.
- **Two-phase action flow:**
  1. Operator asks → copilot returns `answer_type=propose_action` + a `ProposedAction` (typed descriptor: `kind`, `target_id`, `summary`, `gating_passed`).
  2. Client renders Confirm / Dismiss → on Confirm, re-POSTs with `confirm_action` (and the attachment for compliance).
  3. Server **re-validates** the gating from scratch (the descriptor is a hint, not authority), executes through the service, returns an `answer` reply confirming the audited outcome.
- **Stateless**: no conversation row in v1. Each turn is independent except the action round-trip, which is fully described by the echoed `ProposedAction`.

## 7. Frontend — dedicated `/copilot` page

- **`frontend/src/app/copilot/page.tsx`** — operator-gated route; its own `layout.tsx` so it renders inside the AppShell (per the per-page-layout convention).
- **`frontend/src/components/copilot/CopilotPanel.tsx`** — the chat surface: message list, grounded replies with **click-through citation chips** (to the cited incident / claim / compliance item), the **Confirm / Dismiss** affordance for a `proposed_action`, and a **file-attach** control that appears only for the compliance-resolve action.
- **Entry point**: a "Copilot" item in the operator nav (`AppShell`) + a launcher affordance on the dashboard.
- House styles (`lc-card`, design tokens); web-only v1.

## 8. Eval harness (the headline)

Mirrors the intelligence-layer eval shape so it slots into the existing gate.
- **`app/evals/copilot_scenarios.py`** — gold scenarios: DB fixtures + `{message → expected_tool(s), expected_answer_type, must_cite, must_refuse, must_propose_action?}`. Cover: each read intent, both act-tools (gating-pass and gating-fail cases), out-of-scope refusal, and ungrounded-question handling.
- **`app/evals/copilot_scorers.py`** — `intent_routing_accuracy`, `faithfulness` (no asserted fact without a backing tool-result citation; shares the §5 guard), `refusal_correctness` (out-of-scope → refuse), `action_appropriateness` (proposes the action **iff** gating passes — e.g. never offers send-to-broker on a no-policy incident).
- **`app/evals/copilot_runner.py`** + **`copilot_baseline.json`**, wired into `runner.py` aggregate, `--compare-baseline` (exit 1 on any drop), and the `/evals` scoreboard.
- Runs on the **deterministic** provider → reproducible, keyless, bias-free.

## 9. Provider behavior

**`DeterministicChatProvider`** (the CI/demo default):
1. **Intent classification** — a keyword/rule ladder (same discipline as `app/providers/deterministic.py`'s risk classifier, with over-fit guards) maps the message → an intent ∈ the tool catalog ∪ {refuse}.
2. **Tool dispatch** — calls the mapped tool with extracted args (e.g. an incident reference resolved from the message or from the most-relevant finding).
3. **Templated grounding** — formats a fixed, faithful template from the `ToolResult` (counts, names, citations). Action intents return a `ProposedAction` instead of prose.
4. **Refusal** — no confident intent → the deterministic refusal.

**`AnthropicChatProvider`** (key-gated): same tool catalog exposed as tool definitions; the model does NL understanding + phrasing and emits the `<<<META>>>` tail; the engine runs the faithfulness guard over its output. Only exercised when a key is set (never in CI).

## 10. Testing

TDD throughout.
- **Backend (pytest):** tool unit tests (each read tool's grounding + each act-tool's two-phase gating, incl. the no-policy / already-routed / unresolved-item negative cases); faithfulness-guard unit tests (grounded passes, ungrounded downgrades); engine tests (intent → tool → reply, refusal, action round-trip + re-validation); route tests (operator gate, two-phase POST, audit emission); the eval runner + baseline gate.
- **Frontend (vitest):** the typed client; CopilotPanel rendering (citation chips, confirm/dismiss, attach-only-for-compliance).

## 11. File structure

**Backend (create):** `app/copilot/__init__.py`, `provider.py`, `tools.py`, `engine.py`, `faithfulness.py`, `schemas.py` (`CopilotTurn`/`CopilotReply`/`ProposedAction`/`ToolResult`); `app/api/v1/copilot.py`; `app/evals/copilot_scenarios.py`, `copilot_scorers.py`, `copilot_runner.py`, `copilot_baseline.json`; `tests/copilot/…`.
**Backend (modify):** `app/main.py` (register router); `app/evals/runner.py` + `baseline.py` (+ `--compare-baseline`) to include copilot scorers.
**Frontend (create):** `src/lib/copilot.ts` (+ test), `src/app/copilot/page.tsx`, `src/app/copilot/layout.tsx`, `src/components/copilot/CopilotPanel.tsx`.
**Frontend (modify):** `AppShell` nav entry; a dashboard launcher.

## 12. Open questions / seams to later sub-projects

- **Retrieval (sub-project 3):** when the routed retriever lands, it becomes another read tool — no provider/engine change (the tool boundary absorbs it).
- **Personas:** broker/carrier are added by registering their findings + act-tools in the catalog; the seam, guard, and eval shape are unchanged.
- **Multi-turn + streaming:** both are additive on the existing seam; deferred until a real need.
- **LLM-as-judge** for subjective answer quality is recorded for sub-project 4; v1 uses only deterministic scorers.
