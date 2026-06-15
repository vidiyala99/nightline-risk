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
