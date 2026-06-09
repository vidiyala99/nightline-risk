"""OpenAI-compatible copilot provider — works against Ollama / Groq / OpenRouter /
vLLM / any OpenAI-compatible chat endpoint via env vars. The HTTP layer is
mocked here so the tool-calling loop is exercised without a live model.

The provider only ever lets the model CALL the read tools — the model never sees
raw data it could paraphrase wrongly, and the engine's faithfulness guard still
checks the final text against the tool results. On any failure it falls back to
the deterministic provider so the copilot never hard-fails.
"""
import pytest

from app.copilot.openai_compatible_provider import OpenAICompatibleChatProvider
from app.copilot.schemas import AnswerType, ToolResult


class _Bridge:
    """Mimics the engine's tool bridge: run(name, args) -> ToolResult."""
    def __init__(self, data=None):
        self.last_results = []
        self._data = data or {
            "count": 292, "nav_href": "/incidents", "nav_label": "View active incidents"
        }

    def run(self, name, args):
        res = ToolResult(tool=name, data=self._data, citations=[])
        self.last_results.append(res)
        return res


def _provider(monkeypatch):
    monkeypatch.setenv("COPILOT_LLM_BASE_URL", "http://fake/v1")
    monkeypatch.setenv("COPILOT_LLM_MODEL", "test-model")
    return OpenAICompatibleChatProvider()


def test_runs_the_tool_the_model_picks_and_links(monkeypatch):
    p = _provider(monkeypatch)
    turns = []

    def fake_chat(messages, tools=None):
        turns.append(messages)
        if len(turns) == 1:
            return {"choices": [{"message": {
                "role": "assistant", "content": None,
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "list_incidents", "arguments": "{}"}}],
            }}]}
        return {"choices": [{"message": {"role": "assistant",
                                         "content": "You have 292 active incidents."}}]}

    monkeypatch.setattr(p, "_chat_completion", fake_chat)
    bridge = _Bridge()
    reply = p.respond("how many incidents are open right now?", tools=bridge)

    assert reply.answer_type == AnswerType.answer
    assert "292" in reply.text
    assert reply.link and reply.link.href == "/incidents"
    assert len(bridge.last_results) == 1  # the model's chosen tool actually ran


def test_no_tool_call_refuses(monkeypatch):
    p = _provider(monkeypatch)
    monkeypatch.setattr(
        p, "_chat_completion",
        lambda messages, tools=None: {"choices": [{"message": {"content": "I'm not sure."}}]},
    )
    reply = p.respond("what's the weather tonight?", tools=_Bridge())
    assert reply.answer_type == AnswerType.refuse


def test_http_error_falls_back_to_deterministic(monkeypatch):
    p = _provider(monkeypatch)

    def boom(messages, tools=None):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(p, "_chat_completion", boom)
    risk = _Bridge(data={"score": 46, "tier": "C", "top_factor": "incident_history",
                         "nav_href": "/risk-profile/v1", "nav_label": "View risk profile"})
    reply = p.respond("why is my risk a C?", tools=risk)
    # deterministic fallback answered, grounded in the tool data
    assert reply.answer_type == AnswerType.answer
    assert "46" in reply.text
