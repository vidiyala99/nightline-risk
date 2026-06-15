"""
Nightline Risk — LLM Provider Abstraction Layer

Providers sit at the agent boundary. Swapping providers requires only changing
the one returned by get_default_provider — the packet builder, citation
validator, and audit trail are untouched.

Resolution order (first hit wins):
  1. ANTHROPIC_API_KEY → AnthropicProvider (Claude Haiku 4.5)
  2. GEMINI_API_KEY    → GeminiProvider    (Gemini 2.5 Flash)
  3. (no key)          → DeterministicProvider (template-based)
"""

from app.providers.base import (
    EmbeddingProvider,
    MemoProvider,
    ProviderMode,
    RiskClassification,
    RiskClassifierProvider,
    TranscriptionProvider,
)
from app.providers.deterministic import (
    DeterministicEmbeddingProvider,
    DeterministicProvider,
    DeterministicRiskClassifier,
    DeterministicTranscriptionProvider,
)
from app.providers.anthropic_provider import AnthropicProvider, AnthropicRiskClassifier
from app.providers.grok_provider import GrokProvider, GrokRiskClassifier
from app.providers.gemini_provider import (
    GeminiEmbeddingProvider,
    GeminiProvider,
    GeminiRiskClassifier,
    GeminiTranscriptionProvider,
)
from app.providers.openai_provider import (
    OpenAIEmbeddingProvider,
    OpenAITranscriptionProvider,
)


def get_default_provider() -> MemoProvider:
    """Return the active memo provider based on which API key is configured."""
    import os
    if os.getenv("ANTHROPIC_API_KEY"):
        return AnthropicProvider()
    if os.getenv("GEMINI_API_KEY"):
        return GeminiProvider()
    return DeterministicProvider()


def get_default_risk_classifier() -> RiskClassifierProvider:
    """Return the active risk classifier provider.

    Resolution order: Anthropic (tool-use) → Gemini (responseSchema) → deterministic.
    """
    import os
    if os.getenv("ANTHROPIC_API_KEY"):
        return AnthropicRiskClassifier()
    if os.getenv("GEMINI_API_KEY"):
        return GeminiRiskClassifier()
    return DeterministicRiskClassifier()


def get_default_transcription_provider() -> TranscriptionProvider:
    """Return the active transcription provider.

    Resolution order: OpenAI (gpt-4o-mini-transcribe) → Gemini (inline audio) → sentinel.
    """
    import os
    if os.getenv("OPENAI_API_KEY"):
        return OpenAITranscriptionProvider()
    if os.getenv("GEMINI_API_KEY"):
        return GeminiTranscriptionProvider()
    return DeterministicTranscriptionProvider()


def get_default_embedding_provider() -> EmbeddingProvider:
    """Return the active embedding provider.

    Resolution order: OpenAI (text-embedding-3-small, 1536-dim) → Gemini
    (text-embedding-004, 768-dim) → sentinel-that-raises.
    """
    import os
    if os.getenv("OPENAI_API_KEY"):
        return OpenAIEmbeddingProvider()
    if os.getenv("GEMINI_API_KEY"):
        return GeminiEmbeddingProvider()
    return DeterministicEmbeddingProvider()


__all__ = [
    "MemoProvider",
    "ProviderMode",
    "RiskClassification",
    "RiskClassifierProvider",
    "TranscriptionProvider",
    "EmbeddingProvider",
    "DeterministicProvider",
    "DeterministicRiskClassifier",
    "DeterministicTranscriptionProvider",
    "DeterministicEmbeddingProvider",
    "AnthropicProvider",
    "AnthropicRiskClassifier",
    "GrokProvider",
    "GrokRiskClassifier",
    "GeminiProvider",
    "GeminiRiskClassifier",
    "GeminiTranscriptionProvider",
    "GeminiEmbeddingProvider",
    "OpenAITranscriptionProvider",
    "OpenAIEmbeddingProvider",
    "get_default_provider",
    "get_default_risk_classifier",
    "get_default_transcription_provider",
    "get_default_embedding_provider",
]
