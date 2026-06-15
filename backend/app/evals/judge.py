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
