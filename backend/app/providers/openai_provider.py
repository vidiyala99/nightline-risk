"""OpenAI-backed providers for transcription and embeddings.

Both live in one module because they share OPENAI_API_KEY and the openai SDK.
Imports of the openai SDK are deferred to method bodies so callers without the
package installed (or without a key set) can still load this module.
"""

from app.providers.base import (
    EmbeddingOutput,
    EmbeddingProvider,
    ProviderMode,
    TranscriptionOutput,
    TranscriptionProvider,
)


class ProviderNotConfiguredError(RuntimeError):
    pass


class OpenAITranscriptionProvider(TranscriptionProvider):
    """Audio → text via OpenAI gpt-4o-mini-transcribe.

    Chosen over Whisper-1 (legacy, 2x the price), AssemblyAI (better diarization
    but expensive), Deepgram (lower latency, worse on noisy audio), and Gemini
    Speech (8x the price). gpt-4o-mini-transcribe is Whisper-family, so it
    handles nightclub-grade noisy audio better than the alternatives.

    Falls back via the call site's try/except — this class does not catch its
    own errors.
    """

    MODEL = "gpt-4o-mini-transcribe"

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("OPENAI_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "OPENAI_API_KEY is not set. Use DeterministicTranscriptionProvider instead."
            )

    @property
    def provider_name(self) -> str:
        return f"openai/{self.MODEL}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    def transcribe(self, *, file_path: str, content_type: str) -> TranscriptionOutput:
        import os

        from openai import OpenAI

        from app.storage import get_storage

        client = OpenAI(api_key=self._api_key)
        # The SDK accepts a (filename, bytes) tuple; the filename keeps the
        # original extension for format detection. Bytes come from storage so
        # the source can be local or a future remote backend.
        data = get_storage().read(file_path)
        response = client.audio.transcriptions.create(
            model=self.MODEL,
            file=(os.path.basename(file_path), data),
            response_format="verbose_json",
        )

        # response_format=verbose_json returns language and duration; gracefully
        # degrade if the SDK shape changes (it's evolved twice already).
        text = getattr(response, "text", None) or response["text"]
        language = getattr(response, "language", None) or response.get("language") if isinstance(response, dict) else getattr(response, "language", None)
        duration = getattr(response, "duration", None) or (response.get("duration") if isinstance(response, dict) else None)

        return TranscriptionOutput(
            text=text,
            language=language,
            duration_seconds=float(duration) if duration is not None else None,
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """Text → 1536-dim vectors via OpenAI text-embedding-3-small.

    Chosen for: cheapest at quality tier (~$0.02 / 1M tokens), 1536 dims is small
    enough to be free in pgvector / chroma overhead, and the API supports batch
    requests so a 500-chunk policy doc embeds in one round trip.

    Voyage (Anthropic's recommendation) is the alternative — slightly stronger
    on retrieval benchmarks but adds a fourth vendor key. Defer until our eval
    set actually shows a gap.
    """

    MODEL = "text-embedding-3-small"
    DIMENSIONS = 1536
    _BATCH_LIMIT = 96  # OpenAI accepts up to 2048 inputs per request; 96 keeps payloads small

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("OPENAI_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "OPENAI_API_KEY is not set. Use DeterministicEmbeddingProvider only as a "
                "configuration sentinel — it raises on .embed() by design."
            )

    @property
    def provider_name(self) -> str:
        return f"openai/{self.MODEL}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    @property
    def dimensions(self) -> int:
        return self.DIMENSIONS

    def embed(self, texts: list[str]) -> EmbeddingOutput:
        from openai import OpenAI

        if not texts:
            return EmbeddingOutput(
                vectors=[],
                dimensions=self.DIMENSIONS,
                provider=self.provider_name,
                mode=self.mode,
                model=self.MODEL,
            )

        client = OpenAI(api_key=self._api_key)
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._BATCH_LIMIT):
            batch = texts[start:start + self._BATCH_LIMIT]
            response = client.embeddings.create(model=self.MODEL, input=batch)
            vectors.extend(item.embedding for item in response.data)

        return EmbeddingOutput(
            vectors=vectors,
            dimensions=self.DIMENSIONS,
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )
