"""Interface-level tests for the transcription and embedding provider scaffolds.

These are interface contracts only — the real OpenAI implementations are not
wired into runtime code yet. When audio inputs or vector retrieval land, the
swap is provider construction in one place, with these tests still passing.
"""

import pytest

from app.providers import (
    DeterministicEmbeddingProvider,
    DeterministicTranscriptionProvider,
    GeminiEmbeddingProvider,
    GeminiTranscriptionProvider,
    OpenAIEmbeddingProvider,
    OpenAITranscriptionProvider,
    ProviderMode,
    get_default_embedding_provider,
    get_default_transcription_provider,
)
from app.providers.openai_provider import ProviderNotConfiguredError


def test_deterministic_transcription_returns_unavailable_marker():
    """Audit trail should reflect that audio arrived but wasn't transcribed — never
    return an empty string that downstream code might confuse with a real transcript."""
    provider = DeterministicTranscriptionProvider()
    output = provider.transcribe(file_path="/tmp/anything.wav", content_type="audio/wav")
    assert "unavailable" in output.text.lower()
    assert output.mode == ProviderMode.DETERMINISTIC
    assert output.provider == "deterministic-transcription-v1"
    assert output.language is None
    assert output.duration_seconds is None


def test_deterministic_embedding_raises_on_embed():
    """Embeddings have no meaningful local fallback — raise loudly so the retriever
    isn't silently fed garbage vectors."""
    provider = DeterministicEmbeddingProvider()
    assert provider.dimensions == 0
    with pytest.raises(NotImplementedError, match="OPENAI_API_KEY"):
        provider.embed(["any text"])


def test_transcription_factory_falls_back_to_deterministic_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    provider = get_default_transcription_provider()
    assert isinstance(provider, DeterministicTranscriptionProvider)


def test_transcription_factory_selects_openai_when_key_set(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    provider = get_default_transcription_provider()
    assert isinstance(provider, OpenAITranscriptionProvider)
    assert provider.provider_name == "openai/gpt-4o-mini-transcribe"
    assert provider.mode == ProviderMode.LLM


def test_transcription_factory_falls_through_to_gemini_when_only_gemini_key_set(monkeypatch):
    """Realistic Railway deployment shape: GEMINI_API_KEY set, no OpenAI key."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-not-real")
    provider = get_default_transcription_provider()
    assert isinstance(provider, GeminiTranscriptionProvider)
    assert provider.provider_name == "gemini/gemini-2.5-flash"


def test_embedding_factory_falls_back_to_deterministic_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    provider = get_default_embedding_provider()
    assert isinstance(provider, DeterministicEmbeddingProvider)


def test_embedding_factory_selects_openai_when_key_set(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    provider = get_default_embedding_provider()
    assert isinstance(provider, OpenAIEmbeddingProvider)
    assert provider.provider_name == "openai/text-embedding-3-small"
    assert provider.dimensions == 1536


def test_embedding_factory_falls_through_to_gemini_when_only_gemini_key_set(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-not-real")
    provider = get_default_embedding_provider()
    assert isinstance(provider, GeminiEmbeddingProvider)
    assert provider.provider_name == "gemini/text-embedding-004"
    assert provider.dimensions == 768


def test_openai_transcription_constructor_raises_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ProviderNotConfiguredError):
        OpenAITranscriptionProvider()


def test_openai_embedding_constructor_raises_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ProviderNotConfiguredError):
        OpenAIEmbeddingProvider()
