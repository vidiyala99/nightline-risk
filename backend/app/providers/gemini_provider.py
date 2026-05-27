from app.providers.base import (
    ALLOWED_RISK_TYPES,
    ALLOWED_SEVERITIES,
    EmbeddingOutput,
    EmbeddingProvider,
    MemoOutput,
    MemoProvider,
    ProviderMode,
    RiskClassification,
    RiskClassifierProvider,
    TranscriptionOutput,
    TranscriptionProvider,
)
from app.providers.anthropic_provider import (
    CLASSIFIER_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    ProviderNotConfiguredError,
)


class GeminiProvider(MemoProvider):
    """
    LLM-assisted memo drafting via Google Gemini.

    Requires GEMINI_API_KEY environment variable. Free tier on Google AI Studio
    is generous enough for development and demo traffic. Calls the REST API
    directly to avoid pulling in the google-generativeai SDK.

    Output is stored as draft text only. The rubric engine and citation
    validator run independently and are not affected by this provider.
    """

    MODEL = "gemini-2.5-flash"
    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("GEMINI_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "GEMINI_API_KEY is not set. Use DeterministicProvider instead."
            )

    @property
    def provider_name(self) -> str:
        return f"gemini/{self.MODEL}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    def draft_memo(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        risk_type: str,
        severity: str,
        confidence: float,
        citation_excerpts: list[str],
        open_questions: list[str] | None = None,
    ) -> MemoOutput:
        import httpx
        import json

        citations_block = "\n".join(f"- {excerpt}" for excerpt in citation_excerpts)
        user_prompt = f"""Draft an underwriting memo for this incident:

Incident: {incident_summary}
Location: {incident_location}
Risk type: {risk_type}
Severity: {severity} (confidence: {confidence:.0%})

Supporting citations:
{citations_block}

Return JSON with keys: summary (string), open_questions (list of strings)."""

        url = f"{self.BASE_URL}/{self.MODEL}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                # 2048 to leave headroom for Gemini 2.5 Flash's reasoning tokens —
                # 512 was too tight and produced truncated JSON that failed to parse
                "maxOutputTokens": 2048,
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "open_questions": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["summary"],
                },
            },
        }

        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                url,
                json=payload,
                headers={"x-goog-api-key": self._api_key},
            )
            response.raise_for_status()
            data = response.json()

        # Gemini returns the JSON-mode output as a string in parts[0].text
        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError) as exc:
            raise RuntimeError(f"Unexpected Gemini response shape: {json.dumps(data)[:400]}") from exc
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Gemini returned invalid JSON ({exc.msg} at char {exc.pos}). "
                f"First 400 chars: {text[:400]!r}"
            ) from exc

        return MemoOutput(
            summary=parsed["summary"],
            open_questions=parsed.get("open_questions", []),
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )


class GeminiRiskClassifier(RiskClassifierProvider):
    """LLM-assisted incident classification via Google Gemini.

    Mirrors AnthropicRiskClassifier but uses Gemini's responseSchema for
    structured output (Gemini's function-calling has rougher edges than
    responseSchema for fixed-shape JSON returns).
    """

    MODEL = "gemini-2.5-flash"
    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("GEMINI_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "GEMINI_API_KEY is not set. Use DeterministicRiskClassifier instead."
            )

    @property
    def provider_name(self) -> str:
        return f"gemini/{self.MODEL}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    def classify(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        citation_excerpts: list[str],
    ) -> RiskClassification:
        import httpx
        import json

        citations_block = (
            "\n".join(f"- {excerpt}" for excerpt in citation_excerpts)
            if citation_excerpts
            else "(none retrieved)"
        )
        user_prompt = f"""Classify this incident.

Summary: {incident_summary}
Location: {incident_location}

Retrieved policy/compliance excerpts that may inform the classification:
{citations_block}

Return JSON with keys: risk_type, base_severity, base_confidence, rationale."""

        url = f"{self.BASE_URL}/{self.MODEL}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": CLASSIFIER_SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                "maxOutputTokens": 1024,
                "temperature": 0.1,
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "risk_type": {"type": "string", "enum": list(ALLOWED_RISK_TYPES)},
                        "base_severity": {"type": "string", "enum": list(ALLOWED_SEVERITIES)},
                        "base_confidence": {"type": "number"},
                        "rationale": {"type": "string"},
                    },
                    "required": ["risk_type", "base_severity", "base_confidence", "rationale"],
                },
            },
        }

        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                url, json=payload, headers={"x-goog-api-key": self._api_key},
            )
            response.raise_for_status()
            data = response.json()

        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Unexpected Gemini classifier response: {str(exc)[:200]}") from exc

        # Clamp confidence to [0.5, 0.99] in case the model returns out-of-range
        confidence = max(0.5, min(0.99, float(parsed["base_confidence"])))

        return RiskClassification(
            risk_type=parsed["risk_type"],
            base_severity=parsed["base_severity"],
            base_confidence=confidence,
            rationale=parsed["rationale"],
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )


class GeminiTranscriptionProvider(TranscriptionProvider):
    """Audio → text via Gemini 2.5 Flash inline audio input.

    Gemini's multimodal endpoint accepts audio the same way it accepts images —
    base64-encoded inline_data with the audio mime type. Free-tier-friendly:
    one call per incident audio file, well under daily quota for demo traffic.

    For files larger than ~15MB, returns a marker indicating the file was too
    large for inline upload (Gemini's File API path is the next upgrade).
    """

    MODEL = "gemini-2.5-flash"
    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
    _MAX_INLINE_BYTES = 15 * 1024 * 1024

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("GEMINI_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "GEMINI_API_KEY is not set. Use DeterministicTranscriptionProvider instead."
            )

    @property
    def provider_name(self) -> str:
        return f"gemini/{self.MODEL}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    def transcribe(self, *, file_path: str, content_type: str) -> TranscriptionOutput:
        import base64
        import json
        import httpx

        from app.storage import get_storage

        data = get_storage().read(file_path)
        size = len(data)
        if size > self._MAX_INLINE_BYTES:
            raise RuntimeError(
                f"Audio file too large for inline upload ({size} bytes > {self._MAX_INLINE_BYTES}). "
                "Use the File API path."
            )

        b64 = base64.b64encode(data).decode("ascii")

        prompt = (
            "Transcribe this audio recording from a nightlife venue incident report. "
            "Return strictly factual transcription — do not paraphrase or interpret. "
            "Include speaker turns if multiple voices are present, marked as 'Speaker 1:', "
            "'Speaker 2:', etc. If no speech is audible, return an empty transcript field."
        )

        url = f"{self.BASE_URL}/{self.MODEL}:generateContent"
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"inline_data": {"mime_type": content_type, "data": b64}},
                        {"text": prompt},
                    ],
                }
            ],
            "generationConfig": {
                "maxOutputTokens": 4096,
                "temperature": 0.0,
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "transcript": {"type": "string"},
                        "language": {"type": "string"},
                    },
                    "required": ["transcript"],
                },
            },
        }

        with httpx.Client(timeout=120.0) as client:
            response = client.post(
                url, json=payload, headers={"x-goog-api-key": self._api_key},
            )
            response.raise_for_status()
            data = response.json()

        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Unexpected Gemini transcription response: {str(exc)[:200]}") from exc

        return TranscriptionOutput(
            text=parsed.get("transcript", ""),
            language=parsed.get("language"),
            duration_seconds=None,  # Gemini doesn't surface audio duration
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )


class GeminiEmbeddingProvider(EmbeddingProvider):
    """Text → 768-dim vectors via Gemini text-embedding-004.

    Free tier covers a generous embedding quota — enough to embed several
    hundred policy chunks per day. Uses the dedicated :embedContent endpoint
    (different URL pattern than generateContent).
    """

    MODEL = "text-embedding-004"
    DIMENSIONS = 768
    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("GEMINI_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "GEMINI_API_KEY is not set. Configure to use Gemini embeddings."
            )

    @property
    def provider_name(self) -> str:
        return f"gemini/{self.MODEL}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    @property
    def dimensions(self) -> int:
        return self.DIMENSIONS

    def embed(self, texts: list[str]) -> EmbeddingOutput:
        import httpx

        if not texts:
            return EmbeddingOutput(
                vectors=[],
                dimensions=self.DIMENSIONS,
                provider=self.provider_name,
                mode=self.mode,
                model=self.MODEL,
            )

        # Gemini's batchEmbedContents accepts up to 100 inputs per request
        url = f"{self.BASE_URL}/{self.MODEL}:batchEmbedContents"
        vectors: list[list[float]] = []
        for start in range(0, len(texts), 100):
            batch = texts[start:start + 100]
            payload = {
                "requests": [
                    {
                        "model": f"models/{self.MODEL}",
                        "content": {"parts": [{"text": t}]},
                    }
                    for t in batch
                ],
            }
            with httpx.Client(timeout=60.0) as client:
                response = client.post(
                    url, json=payload, headers={"x-goog-api-key": self._api_key},
                )
                response.raise_for_status()
                data = response.json()
            for emb in data.get("embeddings", []):
                vectors.append(emb["values"])

        return EmbeddingOutput(
            vectors=vectors,
            dimensions=self.DIMENSIONS,
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )
