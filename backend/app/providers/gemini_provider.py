from app.providers.base import MemoOutput, MemoProvider, ProviderMode
from app.providers.anthropic_provider import SYSTEM_PROMPT, ProviderNotConfiguredError


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
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)

        return MemoOutput(
            summary=parsed["summary"],
            open_questions=parsed.get("open_questions", []),
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )
