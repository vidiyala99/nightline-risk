# LLM-as-Judge: Memo Faithfulness + Meta-Eval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in LLM judge that flags unsupported claims in an underwriting memo summary, a `memo_faithfulness` eval scorer, and a meta-eval that measures the judge's own accuracy against programmatically-labeled gold memos.

**Architecture:** A mockable `judge.py` calls xAI Grok via forced tool-calling for a structured `FaithfulnessVerdict`; a `memo_faithfulness` scorer wraps it (opt-in, only when `LLM_API_KEY` is set, so the keyless CI lane is untouched); a `judge_meta.py` measures judge accuracy/confusion against `judge_gold.json` (auditable injected-hallucination labels). All judge/parse/scorer/meta logic is unit-tested with a mocked client — no live LLM calls in CI.

**Tech Stack:** Python 3.11, pytest, `openai` SDK (OpenAI-compatible, pointed at xAI), existing `app/evals/` harness.

**Spec:** [`docs/superpowers/specs/2026-06-14-llm-judge-memo-faithfulness-design.md`](../specs/2026-06-14-llm-judge-memo-faithfulness-design.md)

---

### Task 1: The judge module

**Files:**
- Create: `backend/app/evals/judge.py`
- Test: `backend/tests/test_judge.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_judge.py
import json
from types import SimpleNamespace

import pytest

from app.evals.judge import (
    FaithfulnessVerdict,
    build_faithfulness_prompt,
    parse_verdict,
    judge_memo_faithfulness,
)


def _tool_response(arguments: str):
    tc = SimpleNamespace(function=SimpleNamespace(arguments=arguments))
    msg = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)])


class _FakeCompletions:
    def __init__(self, response):
        self._r = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._r


class _FakeClient:
    def __init__(self, response):
        self.chat = SimpleNamespace(completions=_FakeCompletions(response))


def test_prompt_includes_summary_and_citations():
    p = build_faithfulness_prompt(
        "Brawl memo with delayed response",
        ["camera zone 3 aggression 0.9"],
        {"type": "altercation_event", "severity": "high", "confidence": 0.88, "explanation": "x"},
    )
    assert "Brawl memo with delayed response" in p
    assert "camera zone 3 aggression 0.9" in p


def test_parse_verdict_unfaithful():
    v = parse_verdict(json.dumps({"faithful": False, "unsupported_claims": ["$2M reserve"]}))
    assert v == FaithfulnessVerdict(faithful=False, unsupported_claims=["$2M reserve"])


def test_parse_verdict_faithful():
    v = parse_verdict(json.dumps({"faithful": True, "unsupported_claims": []}))
    assert v.faithful is True
    assert v.unsupported_claims == []


def test_judge_forces_tool_and_temp_zero():
    client = _FakeClient(_tool_response(json.dumps({"faithful": True, "unsupported_claims": []})))
    v = judge_memo_faithfulness(
        summary="s", citations=[], risk_signal={}, client=client, model="grok-4",
    )
    assert v.faithful is True
    call = client.chat.completions.calls[0]
    assert call["temperature"] == 0
    assert call["tool_choice"]["function"]["name"] == "judge_faithfulness"


def test_judge_raises_without_tool_call():
    msg = SimpleNamespace(content="sorry", tool_calls=None)
    resp = SimpleNamespace(choices=[SimpleNamespace(message=msg)])
    client = _FakeClient(resp)
    with pytest.raises(RuntimeError, match="judge_faithfulness"):
        judge_memo_faithfulness(
            summary="s", citations=[], risk_signal={}, client=client, model="grok-4",
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_judge.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.evals.judge'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/evals/judge.py
"""LLM-as-judge for underwriting memo faithfulness.

Judges whether a drafted memo summary asserts a claim not supported by its
citations or risk signal. Calls an OpenAI-compatible LLM (xAI Grok) via forced
tool-calling for structured output. The ``client`` is injected so unit tests
mock it — no live calls in CI. Mirrors
``app/providers/grok_provider.py::GrokRiskClassifier``.

No deterministic fallback: a *scorer* may abstain (skip) on error, unlike the
memo *generator* which must fall back.
"""
from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class FaithfulnessVerdict:
    faithful: bool
    unsupported_claims: list[str]


_JUDGE_TOOL = {
    "type": "function",
    "function": {
        "name": "judge_faithfulness",
        "description": "Report whether the memo summary is faithful to its sources.",
        "parameters": {
            "type": "object",
            "properties": {
                "faithful": {"type": "boolean"},
                "unsupported_claims": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["faithful", "unsupported_claims"],
        },
    },
}

_SYSTEM_PROMPT = (
    "You are a strict underwriting-memo auditor. A claim is UNSUPPORTED if it "
    "states a fact, number, or conclusion that does not appear in, and cannot be "
    "directly inferred from, the provided citations or risk signal. List each "
    "unsupported claim verbatim. If none, return faithful=true with an empty list."
)


def build_faithfulness_prompt(
    summary: str, citations: list[str], risk_signal: dict
) -> str:
    citations_block = "\n".join(f"- {c}" for c in citations) if citations else "(none)"
    return f"""Risk signal:
- type: {risk_signal.get('type')}
- severity: {risk_signal.get('severity')}
- confidence: {risk_signal.get('confidence')}
- explanation: {risk_signal.get('explanation')}

Citations:
{citations_block}

Memo summary to audit:
{summary}

Call judge_faithfulness with your verdict."""


def parse_verdict(tool_arguments: str) -> FaithfulnessVerdict:
    parsed = json.loads(tool_arguments)
    return FaithfulnessVerdict(
        faithful=bool(parsed["faithful"]),
        unsupported_claims=list(parsed.get("unsupported_claims", [])),
    )


def judge_memo_faithfulness(
    *, summary: str, citations: list[str], risk_signal: dict, client, model: str,
) -> FaithfulnessVerdict:
    response = client.chat.completions.create(
        model=model,
        max_tokens=256,
        temperature=0,
        tools=[_JUDGE_TOOL],
        tool_choice={"type": "function", "function": {"name": "judge_faithfulness"}},
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": build_faithfulness_prompt(summary, citations, risk_signal)},
        ],
    )
    tool_calls = response.choices[0].message.tool_calls or []
    if not tool_calls:
        raise RuntimeError("Judge response missing judge_faithfulness tool call")
    return parse_verdict(tool_calls[0].function.arguments)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_judge.py -q`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/judge.py backend/tests/test_judge.py
git commit -m "feat(evals): LLM-as-judge for memo faithfulness (mockable)"
```

---

### Task 2: The memo_faithfulness scorer

**Files:**
- Modify: `backend/app/evals/scorers.py` (append)
- Test: `backend/tests/test_judge.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_judge.py
from app.evals.scorers import score_memo_faithfulness


def _fake_actual(summary: str, excerpts: list[str]):
    memo = SimpleNamespace(
        summary=summary,
        citations=[SimpleNamespace(excerpt=e) for e in excerpts],
    )
    risk = SimpleNamespace(
        type="altercation_event", severity="high", confidence=0.88, explanation="x",
    )
    return SimpleNamespace(underwriting_memo=memo, risk_signal=risk)


def test_score_memo_faithfulness_pass():
    judge = lambda s, c, r: FaithfulnessVerdict(faithful=True, unsupported_claims=[])
    res = score_memo_faithfulness(_fake_actual("clean memo", ["e1"]), {}, judge=judge)
    assert res.name == "memo_faithfulness"
    assert res.passed is True
    assert res.score == 1.0


def test_score_memo_faithfulness_fail_lists_claims():
    judge = lambda s, c, r: FaithfulnessVerdict(faithful=False, unsupported_claims=["$2M reserve", "arson"])
    res = score_memo_faithfulness(_fake_actual("hallucinated memo", ["e1"]), {}, judge=judge)
    assert res.passed is False
    assert "$2M reserve" in res.detail
    assert "arson" in res.detail
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_judge.py::test_score_memo_faithfulness_pass -q`
Expected: FAIL — `ImportError: cannot import name 'score_memo_faithfulness'`

- [ ] **Step 3: Add the scorer to scorers.py**

Append to `backend/app/evals/scorers.py` (it already imports `ScorerResult` and `UnderwritingPacketAgentResult`):

```python
def _risk_signal_dict(risk) -> dict:
    return {
        "type": risk.type,
        "severity": risk.severity,
        "confidence": risk.confidence,
        "explanation": risk.explanation,
    }


def score_memo_faithfulness(actual: UnderwritingPacketAgentResult, ideal: dict, *, judge) -> ScorerResult:
    """LLM-judged: does the memo summary only assert claims supported by its
    citations + risk signal? `judge` is a (summary, citations, risk_signal) ->
    FaithfulnessVerdict callable so this scorer is provider-agnostic + testable.
    """
    memo = actual.underwriting_memo
    verdict = judge(
        memo.summary,
        [c.excerpt for c in memo.citations],
        _risk_signal_dict(actual.risk_signal),
    )
    detail = "ok" if verdict.faithful else "; ".join(verdict.unsupported_claims)
    return ScorerResult(
        name="memo_faithfulness",
        passed=verdict.faithful,
        score=1.0 if verdict.faithful else 0.0,
        detail=detail,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_judge.py -q`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/scorers.py backend/tests/test_judge.py
git commit -m "feat(evals): memo_faithfulness scorer wrapping the judge"
```

---

### Task 3: The meta-eval

**Files:**
- Create: `backend/app/evals/judge_meta.py`
- Create: `docs/evals/judge_gold.json` (repo root, sibling of `gold_standard.json` — `runner.py` resolves this dir via `parents[3]`)
- Test: `backend/tests/test_judge_meta.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_judge_meta.py
from app.evals.judge import FaithfulnessVerdict
from app.evals.judge_meta import run_judge_meta, JudgeMetaReport


def test_run_judge_meta_confusion_and_accuracy():
    gold = [
        {"id": "a", "summary": "clean", "citations": [], "risk_signal": {}, "expected_faithful": True},
        {"id": "b", "summary": "hallu", "citations": [], "risk_signal": {}, "expected_faithful": False},
        {"id": "c", "summary": "clean2", "citations": [], "risk_signal": {}, "expected_faithful": True},
        {"id": "d", "summary": "hallu2", "citations": [], "risk_signal": {}, "expected_faithful": False},
    ]
    # clean->faithful (tn), hallu->unfaithful (tp), clean2->unfaithful (fp), hallu2->faithful (fn)
    verdicts = {
        "clean": FaithfulnessVerdict(True, []),
        "hallu": FaithfulnessVerdict(False, ["x"]),
        "clean2": FaithfulnessVerdict(False, ["y"]),
        "hallu2": FaithfulnessVerdict(True, []),
    }
    judge = lambda s, c, r: verdicts[s]
    report = run_judge_meta(judge, gold)
    assert isinstance(report, JudgeMetaReport)
    assert report.n == 4
    assert report.confusion == {"tp": 1, "fp": 1, "tn": 1, "fn": 1}
    assert report.accuracy == 0.5


def test_run_judge_meta_empty():
    report = run_judge_meta(lambda s, c, r: FaithfulnessVerdict(True, []), [])
    assert report.n == 0
    assert report.accuracy == 0.0
    assert report.confusion == {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_judge_meta.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.evals.judge_meta'`

- [ ] **Step 3: Write the meta-eval module**

```python
# backend/app/evals/judge_meta.py
"""Meta-eval for the memo-faithfulness judge.

Measures whether the judge agrees with KNOWN labels (docs/evals/judge_gold.json).
Ground truth is auditable: faithful memos plus variants with a programmatically
injected unsupported claim (expected_faithful=false). This is the judge's own
trust number — a quality ratchet, not a per-commit gate. Positive class =
"unfaithful memo caught".
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class JudgeMetaReport:
    n: int
    accuracy: float
    confusion: dict  # {"tp", "fp", "tn", "fn"}


def run_judge_meta(judge, gold: list[dict]) -> JudgeMetaReport:
    tp = fp = tn = fn = 0
    for item in gold:
        verdict = judge(item["summary"], item["citations"], item["risk_signal"])
        predicted_unfaithful = not verdict.faithful
        actual_unfaithful = not item["expected_faithful"]
        if actual_unfaithful and predicted_unfaithful:
            tp += 1
        elif not actual_unfaithful and predicted_unfaithful:
            fp += 1
        elif not actual_unfaithful and not predicted_unfaithful:
            tn += 1
        else:
            fn += 1
    n = len(gold)
    accuracy = (tp + tn) / n if n else 0.0
    return JudgeMetaReport(n=n, accuracy=accuracy, confusion={"tp": tp, "fp": fp, "tn": tn, "fn": fn})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_judge_meta.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Create the gold fixture**

Create `docs/evals/judge_gold.json` (repo root `docs/`, alongside `gold_standard.json`). Each faithful memo is paired with an `-injected` variant where one unsupported claim (in **bold-marked prose**) is added — the only difference, so the label is auditable:

```json
[
  {
    "id": "jg-001-faithful",
    "summary": "Altercation near the rear bar with a delayed security response; camera footage shows elevated aggression. Underwriter review recommended before any reserve is set.",
    "citations": ["camera zone 3 aggression score 0.9", "security log: response after 4 minutes"],
    "risk_signal": {"type": "altercation_event", "severity": "high", "confidence": 0.88, "explanation": "Significant liability exposure identified."},
    "expected_faithful": true
  },
  {
    "id": "jg-001-injected",
    "summary": "Altercation near the rear bar with a delayed security response; camera footage shows elevated aggression. A $2,000,000 reserve has already been set by the carrier. Underwriter review recommended.",
    "citations": ["camera zone 3 aggression score 0.9", "security log: response after 4 minutes"],
    "risk_signal": {"type": "altercation_event", "severity": "high", "confidence": 0.88, "explanation": "Significant liability exposure identified."},
    "expected_faithful": false
  },
  {
    "id": "jg-002-faithful",
    "summary": "Patron slipped on a wet stairwell with no signage during a busy event; injury observed. Premises-liability exposure pending inspection-log review.",
    "citations": ["incident: wet stairs, no wet-floor signage", "injury_observed: true"],
    "risk_signal": {"type": "premises_liability", "severity": "high", "confidence": 0.82, "explanation": "Significant liability exposure identified."},
    "expected_faithful": true
  },
  {
    "id": "jg-002-injected",
    "summary": "Patron slipped on a wet stairwell with no signage during a busy event; injury observed. Three prior identical falls were documented at this location in the past 30 days. Premises-liability exposure pending inspection-log review.",
    "citations": ["incident: wet stairs, no wet-floor signage", "injury_observed: true"],
    "risk_signal": {"type": "premises_liability", "severity": "high", "confidence": 0.82, "explanation": "Significant liability exposure identified."},
    "expected_faithful": false
  }
]
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/evals/judge_meta.py backend/tests/test_judge_meta.py docs/evals/judge_gold.json
git commit -m "feat(evals): judge meta-eval + injected-hallucination gold set"
```

---

### Task 4: Wire the runner (opt-in)

**Files:**
- Modify: `backend/app/evals/runner.py` (`_score_standard_scenario` ~line 387; `run_all` ~line 436; `main` ~line 527; add `_build_memo_judge`)
- Test: `backend/tests/test_judge_meta.py` (append)

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_judge_meta.py
from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.evals import runner


def test_build_memo_judge_none_without_key(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    assert runner._build_memo_judge() is None


def test_run_all_includes_memo_faithfulness_when_judge_passed():
    runtime = UnderwritingPacketAgentRuntime()  # deterministic stack
    judge = lambda s, c, r: FaithfulnessVerdict(True, [])
    results = runner.run_all(runtime, judge=judge)
    standard = [r for r in results if r.scenario_type != "adversarial" and r.error is None]
    assert standard
    assert all(any(s.name == "memo_faithfulness" for s in r.scorers) for r in standard)


def test_run_all_omits_memo_faithfulness_without_judge():
    runtime = UnderwritingPacketAgentRuntime()
    results = runner.run_all(runtime)  # judge defaults to None
    assert all(all(s.name != "memo_faithfulness" for s in r.scorers) for r in results)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_judge_meta.py::test_build_memo_judge_none_without_key -q`
Expected: FAIL — `AttributeError: module 'app.evals.runner' has no attribute '_build_memo_judge'`

- [ ] **Step 3: Add `_build_memo_judge` to runner.py**

Add near the other helpers in `backend/app/evals/runner.py` (after `_risk_info`):

```python
def _build_memo_judge():
    """Return a (summary, citations, risk_signal) -> FaithfulnessVerdict callable,
    or None when no judge LLM is configured (keyless CI lane). Opt-in: only fires
    when LLM_API_KEY is set, so the deterministic baseline never expects it.
    """
    if not os.getenv("LLM_API_KEY"):
        return None
    from app.providers.grok_provider import _client, DEFAULT_BASE_URL, DEFAULT_MODEL
    from app.evals.judge import judge_memo_faithfulness

    api_key = os.getenv("LLM_API_KEY")
    base_url = (os.getenv("LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("LLM_MODEL") or DEFAULT_MODEL
    client = _client(api_key, base_url)

    def judge(summary, citations, risk_signal):
        return judge_memo_faithfulness(
            summary=summary, citations=citations, risk_signal=risk_signal,
            client=client, model=model,
        )

    return judge
```

- [ ] **Step 4: Thread the judge through `_score_standard_scenario` and `run_all`**

Change `_score_standard_scenario`'s signature to accept the judge and append its scorer (abstaining on error):

```python
def _score_standard_scenario(
    run: _RunOutput, scenario: dict, *, memo_provider_mode: str, judge=None
) -> list[ScorerResult]:
    """Apply the standard scorer suite (severity, citations, retrieval)."""
    ideal = scenario["ideal_output"]
    results: list[ScorerResult] = []
    results.append(scorers.score_structural(run.actual))
    results.append(scorers.score_severity_match(run.actual, ideal))
    results.append(scorers.score_citation_coverage(run.actual, ideal))
    results.append(scorers.score_review_status_match(run.actual, ideal))
    results.append(
        scorers.score_factor_recognition(
            run.actual, ideal, provider_mode=memo_provider_mode
        )
    )
    results.append(retrieval_scorers.score_ndcg_at_k(run.actual, ideal))
    results.append(retrieval_scorers.score_mrr(run.actual, ideal))
    if judge is not None:
        try:
            results.append(scorers.score_memo_faithfulness(run.actual, ideal, judge=judge))
        except Exception:
            pass  # judge abstains on error — never block the eval
    return results
```

Change `run_all`'s signature to accept `judge=None` and pass it down. Update the call inside the loop:

```python
def run_all(
    runtime: UnderwritingPacketAgentRuntime,
    gold_path: Path = GOLD_STANDARD_PATH,
    *,
    adversarial_path: Path | None = ADVERSARIAL_GOLD_PATH,
    memo_provider_mode: str = "deterministic",
    judge=None,
) -> list[ScenarioResult]:
    scenarios = _load_scenarios(gold_path, adversarial_path)
    results: list[ScenarioResult] = []
    for scenario in scenarios:
        run = run_scenario(scenario, runtime)
        scorer_results: list[ScorerResult] = []
        if run.actual is not None:
            if scenario.get("scenario_type") == "adversarial":
                scorer_results = _score_adversarial_scenario(run, scenario)
            else:
                scorer_results = _score_standard_scenario(
                    run, scenario, memo_provider_mode=memo_provider_mode, judge=judge
                )
        results.append(
            ScenarioResult(
                scenario_id=run.scenario_id,
                description=run.description,
                exposure_class=scenario.get("exposure_class", ""),
                difficulty=scenario.get("difficulty", ""),
                scenario_type=scenario.get("scenario_type", ""),
                error=run.error,
                scorers=scorer_results,
            )
        )
    return results
```

- [ ] **Step 5: Build the judge in `main` and pass it to `run_all`**

In `main`, replace the `results = run_all(runtime, memo_provider_mode=info.mode)` line with:

```python
    judge = _build_memo_judge()
    if judge is not None:
        print("Memo-faithfulness judge: enabled (LLM_API_KEY set)")
    results = run_all(runtime, memo_provider_mode=info.mode, judge=judge)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_judge_meta.py -q`
Expected: PASS (5 passed)

- [ ] **Step 7: Full suite (keyless lane unaffected)**

Run: `cd backend && python -m pytest -q`
Expected: PASS — existing suite green; new judge tests pass; no `memo_faithfulness` scorer on the deterministic run (so `baseline.json` is untouched).

- [ ] **Step 8: Commit**

```bash
git add backend/app/evals/runner.py backend/tests/test_judge_meta.py
git commit -m "feat(evals): wire opt-in memo-faithfulness judge into the runner"
```

---

## Notes for the implementer

- **No live LLM in CI:** every test injects a fake `client` or a fake `judge` callable. The only real-LLM paths (`_build_memo_judge` with a key, `main`) are never exercised by pytest.
- **Opt-in gating:** `_build_memo_judge` returns `None` without `LLM_API_KEY`, so `run_all`'s default and the deterministic CI lane never add `memo_faithfulness` — the committed `baseline.json` stays valid. When run WITH a key, the scorer appears and gets its own per-stack baseline via `--update-baseline` (manual, key-gated — out of scope here).
- **Abstain, don't fall back:** the scorer skips on judge error (a scorer may abstain); do not add a deterministic faithfulness fallback (that would mislabel the stack's measured rate).
- **Meta-eval is a ratchet, not a CI gate:** `run_judge_meta` is invoked manually with a key to track judge accuracy over time; it is not wired into per-commit CI (LLM non-determinism + cost).
- **DEFAULT_BASE_URL / DEFAULT_MODEL** live in `app/providers/grok_provider.py` (`https://api.x.ai/v1`, `grok-4`) — reuse them, don't redefine.
- **Meta-eval invocation:** `run_judge_meta` is the testable core; running it against `docs/evals/judge_gold.json` for real is `run_judge_meta(_build_memo_judge(), json.load(open("docs/evals/judge_gold.json")))` with a key set. A dedicated `scripts/run_judge_meta.py` CLI is a thin, deferred follow-on (out of scope here).
