"""xAI Grok providers for memo drafting and risk classification.

Grok's API is OpenAI-compatible, so we drive it through the `openai` SDK pointed
at the xAI base URL — no new vendor SDK. Configured purely by env vars (added to
backend/.env alongside the existing COPILOT_LLM_* namespace used by the copilot):

    LLM_API_KEY    xai-...                        (required)
    LLM_BASE_URL   https://api.x.ai/v1            (default if unset)
    LLM_MODEL      grok-4                          (default if unset)

These intentionally do NOT participate in `get_default_provider`'s resolution
chain (Anthropic > Gemini > Deterministic). Grok is opt-in — selected explicitly
via the eval runner's `--provider grok` flag or the copilot selector — so a dev
machine with LLM_API_KEY set in .env never starts making live calls inside the
deterministic test suite. The deterministic provider remains the fallback.

Output is stored as draft text only. The rubric engine and citation validator
run independently and are not affected by this provider — same contract as the
Anthropic provider.
"""
from __future__ import annotations

import json
import os

from app.providers.anthropic_provider import (
    CLASSIFIER_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    ProviderNotConfiguredError,
)
from app.providers.base import (
    ALLOWED_RISK_TYPES,
    ALLOWED_SEVERITIES,
    MemoOutput,
    MemoProvider,
    ProviderMode,
    RiskClassification,
    RiskClassifierProvider,
)

DEFAULT_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-4"


def _client(api_key: str, base_url: str):
    """Construct an OpenAI SDK client aimed at the xAI endpoint.

    Deferred import keeps the module loadable where the openai package is absent.
    """
    from openai import OpenAI

    return OpenAI(api_key=api_key, base_url=base_url)


def _strip_fences(raw: str) -> str:
    """Some models wrap JSON in ```json fences despite response_format — strip them."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return raw.strip()


class _GrokConfig:
    """Shared env resolution + name derivation for both Grok providers."""

    def __init__(self) -> None:
        api_key = os.getenv("LLM_API_KEY")
        if not api_key:
            raise ProviderNotConfiguredError(
                "LLM_API_KEY is not set. Use the deterministic provider instead."
            )
        self._api_key: str = api_key
        self._base_url = (os.getenv("LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self._model = os.getenv("LLM_MODEL") or DEFAULT_MODEL

    @property
    def provider_name(self) -> str:
        return f"grok/{self._model}"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM


class GrokProvider(_GrokConfig, MemoProvider):
    """LLM-assisted underwriting memo drafting via xAI Grok."""

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
        citations_block = "\n".join(f"- {excerpt}" for excerpt in citation_excerpts)
        user_prompt = f"""Draft an underwriting memo for this incident:

Incident: {incident_summary}
Location: {incident_location}
Risk type: {risk_type}
Severity: {severity} (confidence: {confidence:.0%})

Supporting citations:
{citations_block}

Return JSON with keys: summary (string), open_questions (list of strings)."""

        client = _client(self._api_key, self._base_url)
        response = client.chat.completions.create(
            model=self._model,
            max_tokens=512,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )

        raw = response.choices[0].message.content or ""
        parsed = json.loads(_strip_fences(raw))
        return MemoOutput(
            summary=parsed["summary"],
            open_questions=parsed.get("open_questions", []),
            provider=self.provider_name,
            mode=self.mode,
            model=self._model,
        )


_CLASSIFY_TOOL = {
    "type": "function",
    "function": {
        "name": "classify_incident",
        "description": "Return the risk classification for this incident.",
        "parameters": {
            "type": "object",
            "properties": {
                "risk_type": {"type": "string", "enum": list(ALLOWED_RISK_TYPES)},
                "base_severity": {"type": "string", "enum": list(ALLOWED_SEVERITIES)},
                "base_confidence": {"type": "number", "minimum": 0.5, "maximum": 0.99},
                "rationale": {"type": "string"},
            },
            "required": ["risk_type", "base_severity", "base_confidence", "rationale"],
        },
    },
}


class GrokRiskClassifier(_GrokConfig, RiskClassifierProvider):
    """LLM-assisted incident classification via xAI Grok.

    Uses OpenAI-style tool-calling for guaranteed structured output. Does not
    catch its own errors — the runtime's try/except handles fallback.
    """

    def classify(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        citation_excerpts: list[str],
    ) -> RiskClassification:
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

Call the classify_incident tool with your output."""

        client = _client(self._api_key, self._base_url)
        response = client.chat.completions.create(
            model=self._model,
            max_tokens=512,
            temperature=0,
            tools=[_CLASSIFY_TOOL],  # type: ignore[arg-type]  # OpenAI-style tool param
            tool_choice={"type": "function", "function": {"name": "classify_incident"}},
            messages=[
                {"role": "system", "content": CLASSIFIER_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )

        tool_calls = response.choices[0].message.tool_calls or []
        if not tool_calls:
            raise RuntimeError("Grok response missing classify_incident tool call")
        parsed = json.loads(tool_calls[0].function.arguments)  # type: ignore[union-attr]
        return RiskClassification(
            risk_type=parsed["risk_type"],
            base_severity=parsed["base_severity"],
            base_confidence=float(parsed["base_confidence"]),
            rationale=parsed["rationale"],
            provider=self.provider_name,
            mode=self.mode,
            model=self._model,
        )
