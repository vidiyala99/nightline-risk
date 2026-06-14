# LLM-as-Judge: Memo Faithfulness + Meta-Eval — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Related:** [`docs/research/llm-usage-gap-analysis.md`](../../research/llm-usage-gap-analysis.md) §4 #1 (the one verified gap, post-correction). Field bar: Roots "Verifier model" (grounded-to-source + confidence), Nirvana "Beyond the Vibe Check" (LLM-as-judge, **meta-evaluated judges**).

## Motivation

Every scorer in `app/evals/` is deterministic by design — `intelligence_scorers.py` states outright: *"No LLM-judge here … LLM-as-judge is reserved for the copilot's subjective dimensions in a later sub-project."* After correcting the gap analysis (calibration, confidence routing, and document extraction all turned out to already exist), the **single verified gap** is an LLM-as-judge for open-ended quality.

Deterministic scorers can check memo *shape* (`score_structural`), *factor coverage* (`score_factor_recognition`), and *citation presence* (`score_citation_coverage`), but none can judge whether the memo's **prose asserts a claim not supported by its citations or risk signal** — the exact failure mode (a fluent, plausible, unsupported sentence) that the field's leaders built Verifier models to catch.

The differentiator is not the judge — it's the **meta-eval**: proving the judge itself is trustworthy by measuring its accuracy against known-labeled memos. A judge you can't grade is vibes; a meta-evaluated judge is the Nirvana bar.

## Goals / Non-goals

**Goals**
- An LLM judge that flags unsupported claims in an underwriting memo summary, with structured output.
- A `memo_faithfulness` scorer, opt-in (only when a judge LLM is configured), baseline-gated per stack.
- A meta-eval that measures the judge's accuracy against programmatically-labeled gold memos.
- All judge/parse/scorer logic unit-tested with a **mocked** client — no live LLM calls in CI.

**Non-goals (YAGNI)**
- Jury / N-judge consensus (documented later step).
- Judging copilot answers (a separate later sub-project — the codebase's other earmarked surface).
- Any change to the request path or to memo *generation*.
- Running the judge on the keyless CI lane.

## Architecture

### Component 1 — `backend/app/evals/judge.py` (the judge, mockable)

```
@dataclass(frozen=True)
class FaithfulnessVerdict:
    faithful: bool
    unsupported_claims: list[str]   # empty when faithful

def build_faithfulness_prompt(summary: str, citations: list[str], risk_signal: dict) -> str: ...

def parse_verdict(tool_arguments: str) -> FaithfulnessVerdict: ...

def judge_memo_faithfulness(
    *, summary: str, citations: list[str], risk_signal: dict, client,
    model: str,
) -> FaithfulnessVerdict: ...
```

- `judge_memo_faithfulness` builds the prompt, calls `client.chat.completions.create(...)` with a forced `judge_faithfulness` tool (OpenAI-style structured output — same pattern as `app/providers/grok_provider.py::GrokRiskClassifier`), and returns the parsed verdict. The `client` and `model` are **injected** so unit tests pass a fake client. A real run constructs the client via the existing Grok plumbing (`grok_provider._client(api_key, base_url)`).
- Tool schema: `{faithful: bool, unsupported_claims: string[]}`, both required. `parse_verdict` raises `RuntimeError` on a missing/empty tool call (mirrors `GrokRiskClassifier`).
- The prompt instructs: *"A claim is unsupported if it states a fact, number, or conclusion that does not appear in, and cannot be directly inferred from, the provided citations or risk signal. List each unsupported claim verbatim; if none, return faithful=true."*

### Component 2 — `score_memo_faithfulness` in `backend/app/evals/scorers.py`

```
def score_memo_faithfulness(actual, ideal, *, judge) -> ScorerResult:
    verdict = judge(actual.underwriting_memo.summary,
                    [c.excerpt for c in actual.underwriting_memo.citations],
                    _risk_signal_dict(actual.risk_signal))
    detail = "ok" if verdict.faithful else "; ".join(verdict.unsupported_claims)
    return ScorerResult(name="memo_faithfulness", passed=verdict.faithful,
                        score=1.0 if verdict.faithful else 0.0, detail=detail)
```

- `judge` is a callable `(summary, citations, risk_signal) -> FaithfulnessVerdict` so the scorer is testable with a fake judge and decoupled from the provider.
- The runner builds the real `judge` partial (binding client+model) and threads it into `_score_standard_scenario` **only when a judge LLM is configured** (`LLM_API_KEY` set). When unset, the scorer is omitted — so the keyless CI lane is unchanged and the deterministic baseline never expects it.

### Component 3 — meta-eval: `backend/app/evals/judge_meta.py` + `docs/evals/judge_gold.json`

- `docs/evals/judge_gold.json`: a list of `{id, summary, citations, risk_signal, expected_faithful}`. **Built without LLM-authored labels:** authored faithful memos, plus variants where an unsupported claim is **programmatically injected** (e.g. a fabricated dollar figure / a risk type not in the signal) → `expected_faithful=false`. The injection is explicit in the fixture so the ground truth is auditable.
- `run_judge_meta(judge, gold) -> JudgeMetaReport{accuracy, n, confusion}` where `confusion = {tp, fp, tn, fn}` (positive = "unfaithful caught"). Pure over the gold list + an injected `judge` callable.
- Exposed via a script flag (e.g. `scripts/run_calibration.py`-style or a small `scripts/run_judge_meta.py`), key-gated. It is a **quality ratchet** (judge accuracy must not regress), surfaced as a number — not a per-commit CI gate.

### Data flow

```
packet eval run ──► actual.underwriting_memo.summary + citations + risk_signal
                          │  (only if LLM_API_KEY set)
        judge(summary, citations, risk_signal) ──► FaithfulnessVerdict
                          │
        score_memo_faithfulness ──► ScorerResult(memo_faithfulness) ──► baseline-gated (LLM stack)

meta-eval (offline, key-gated):
  judge_gold.json (injected-hallucination labels) ──► run_judge_meta(judge) ──► {accuracy, confusion}
```

## Cost / gating / error handling

- One Grok key; `temperature=0`, tight `max_tokens` (≤256). Judge runs only when configured.
- **No deterministic fallback for the judge** — if the judge call errors, the `memo_faithfulness` scorer is skipped for that scenario (logged), never blocking the packet eval. (Contrast the memo *generator*, which must fall back; the *scorer* may simply abstain.)
- `memo_faithfulness` is baseline-gated like any scorer (pass_rate, higher-better) but only on stacks where it runs; the keyless lane neither computes nor expects it (a new scorer absent from a baseline is not a regression).
- Meta-eval accuracy is reported and ratcheted manually, not gated per-commit (LLM non-determinism + cost).

## Testing (TDD — all CI-safe, mocked client)

**`judge.py`:**
- `build_faithfulness_prompt` includes the summary and each citation excerpt.
- `parse_verdict` on `{"faithful": false, "unsupported_claims": ["$2M reserve"]}` → `FaithfulnessVerdict(False, ["$2M reserve"])`; on `{"faithful": true, ...}` → faithful, empty claims.
- `judge_memo_faithfulness` with a fake client (captures kwargs, returns a scripted tool call) → correct verdict; asserts `tool_choice` forces `judge_faithfulness` and `temperature == 0`.
- Missing tool call → `RuntimeError`.

**`scorers.py`:**
- `score_memo_faithfulness` with a fake judge returning faithful → `passed=True`; unfaithful with claims → `passed=False`, claims in `detail`.

**`judge_meta.py`:**
- `run_judge_meta` with a fake judge that returns canned verdicts over a 4-item gold (2 faithful, 2 unfaithful) → correct `accuracy` and `confusion` counts (verify a tp, fp, tn, fn each).

## Rollout

1. `judge.py` + unit tests (TDD, mocked client).
2. `score_memo_faithfulness` + tests.
3. `judge_meta.py` + `judge_gold.json` + tests.
4. Wire the runner: build the real judge when `LLM_API_KEY` is set; thread into `_score_standard_scenario`; seed the LLM-stack baseline.
5. Full backend `pytest -q` green (keyless lane unaffected) before push.
