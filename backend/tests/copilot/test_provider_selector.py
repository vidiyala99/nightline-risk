from app.copilot.anthropic_provider import get_chat_provider, AnthropicChatProvider
from app.copilot.provider import DeterministicChatProvider


def test_selector_returns_deterministic_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert isinstance(get_chat_provider(), DeterministicChatProvider)


def test_selector_returns_anthropic_with_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert isinstance(get_chat_provider(), AnthropicChatProvider)
