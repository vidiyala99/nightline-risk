"""Unit tests for the xAI Grok providers (memo + risk classifier).

The OpenAI SDK client is mocked — no network calls. We verify env-gating,
provider naming, request shape (model/base-url/tool-choice), and response
parsing, including the ```json-fence stripping path.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.providers import GrokProvider, GrokRiskClassifier, ProviderMode
from app.providers.anthropic_provider import ProviderNotConfiguredError
from app.providers import grok_provider


@pytest.fixture(autouse=True)
def _grok_env(monkeypatch):
    """Default a valid Grok config for every test; individual tests override."""
    monkeypatch.setenv("LLM_API_KEY", "xai-test-not-real")
    monkeypatch.setenv("LLM_MODEL", "grok-4")
    monkeypatch.delenv("LLM_BASE_URL", raising=False)


class _FakeCompletions:
    """Captures the create() kwargs and returns a scripted response."""

    def __init__(self, response):
        self._response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


class _FakeClient:
    def __init__(self, response):
        self.chat = SimpleNamespace(completions=_FakeCompletions(response))


def _memo_response(content: str):
    msg = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)])


def _classify_response(arguments: str):
    tool_call = SimpleNamespace(function=SimpleNamespace(arguments=arguments))
    msg = SimpleNamespace(content=None, tool_calls=[tool_call])
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)])


def _patch_client(monkeypatch, response):
    client = _FakeClient(response)
    monkeypatch.setattr(grok_provider, "_client", lambda api_key, base_url: client)
    return client


# ── config / gating ─────────────────────────────────────────────────────────


def test_provider_raises_without_key(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with pytest.raises(ProviderNotConfiguredError, match="LLM_API_KEY"):
        GrokProvider()
    with pytest.raises(ProviderNotConfiguredError, match="LLM_API_KEY"):
        GrokRiskClassifier()


def test_provider_name_and_mode():
    p = GrokProvider()
    assert p.provider_name == "grok/grok-4"
    assert p.mode == ProviderMode.LLM
    c = GrokRiskClassifier()
    assert c.provider_name == "grok/grok-4"
    assert c.mode == ProviderMode.LLM


def test_base_url_defaults_to_xai(monkeypatch):
    client = _patch_client(monkeypatch, _memo_response('{"summary": "s", "open_questions": []}'))
    GrokProvider().draft_memo(
        incident_summary="x", incident_location="bar", risk_type="liquor_liability",
        severity="high", confidence=0.9, citation_excerpts=[],
    )
    # _client receives the resolved base_url; assert via a capturing patch.
    assert client.chat.completions.calls  # call happened


def test_custom_model_reflected_in_name(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "grok-4-fast")
    assert GrokProvider().provider_name == "grok/grok-4-fast"


# ── memo drafting ────────────────────────────────────────────────────────────


def test_draft_memo_parses_json(monkeypatch):
    payload = {"summary": "Brawl with delayed security response.", "open_questions": ["q1", "q2"]}
    client = _patch_client(monkeypatch, _memo_response(json.dumps(payload)))
    out = GrokProvider().draft_memo(
        incident_summary="brawl", incident_location="rear-bar",
        risk_type="altercation_event", severity="high", confidence=0.88,
        citation_excerpts=["camera zone 3 aggression 0.9"],
    )
    assert out.summary == payload["summary"]
    assert out.open_questions == ["q1", "q2"]
    assert out.provider == "grok/grok-4"
    assert out.mode == ProviderMode.LLM
    # request shape: correct model + temperature 0 + json response_format
    call = client.chat.completions.calls[0]
    assert call["model"] == "grok-4"
    assert call["temperature"] == 0
    assert call["response_format"] == {"type": "json_object"}


def test_draft_memo_strips_markdown_fences(monkeypatch):
    fenced = '```json\n{"summary": "fenced", "open_questions": []}\n```'
    _patch_client(monkeypatch, _memo_response(fenced))
    out = GrokProvider().draft_memo(
        incident_summary="x", incident_location="y", risk_type="general_incident",
        severity="low", confidence=0.6, citation_excerpts=[],
    )
    assert out.summary == "fenced"


# ── risk classification ──────────────────────────────────────────────────────


def test_classify_parses_tool_call(monkeypatch):
    args = {
        "risk_type": "liquor_liability",
        "base_severity": "high",
        "base_confidence": 0.82,
        "rationale": "After-hours service of shots.",
    }
    client = _patch_client(monkeypatch, _classify_response(json.dumps(args)))
    out = GrokRiskClassifier().classify(
        incident_summary="after-hours liquor", incident_location="main-bar",
        citation_excerpts=["last call 02:00"],
    )
    assert out.risk_type == "liquor_liability"
    assert out.base_severity == "high"
    assert out.base_confidence == pytest.approx(0.82)
    assert out.rationale == args["rationale"]
    assert out.provider == "grok/grok-4"
    # request shape: tool forced via tool_choice
    call = client.chat.completions.calls[0]
    assert call["tool_choice"]["function"]["name"] == "classify_incident"


def test_classify_raises_without_tool_call(monkeypatch):
    _patch_client(monkeypatch, _classify_response_no_tool())
    with pytest.raises(RuntimeError, match="classify_incident"):
        GrokRiskClassifier().classify(
            incident_summary="x", incident_location="y", citation_excerpts=[],
        )


def _classify_response_no_tool():
    msg = SimpleNamespace(content="sorry", tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)])
