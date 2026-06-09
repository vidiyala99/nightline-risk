from app.copilot.anthropic_provider import get_chat_provider, AnthropicChatProvider
from app.copilot.openai_compatible_provider import OpenAICompatibleChatProvider
from app.copilot.provider import DeterministicChatProvider


def _clear_llm_env(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "COPILOT_LLM_BASE_URL", "COPILOT_LLM_MODEL", "COPILOT_LLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)


def test_selector_returns_deterministic_without_config(monkeypatch):
    _clear_llm_env(monkeypatch)
    assert isinstance(get_chat_provider(), DeterministicChatProvider)


def test_selector_returns_anthropic_with_key(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert isinstance(get_chat_provider(), AnthropicChatProvider)


def test_openai_compatible_takes_precedence_when_configured(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")  # even with a key present…
    monkeypatch.setenv("COPILOT_LLM_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("COPILOT_LLM_MODEL", "llama3.1:8b")
    assert isinstance(get_chat_provider(), OpenAICompatibleChatProvider)
