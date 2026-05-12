from app.providers.base import (
    ALLOWED_RISK_TYPES,
    ALLOWED_SEVERITIES,
    MemoOutput,
    MemoProvider,
    ProviderMode,
    RiskClassification,
    RiskClassifierProvider,
)


SYSTEM_PROMPT = """You are an underwriting memo assistant for Third Space Risk, an AI-powered
insurance broker for nightlife venues. You draft factual, neutral underwriting memos from
structured packet findings.

Rules:
- Ground every claim in the provided citation excerpts. Never invent facts.
- Use neutral, professional language appropriate for carrier review.
- Do not make coverage decisions — flag items for human review instead.
- Keep summaries under 120 words. Open questions should be specific and actionable."""


class AnthropicProvider(MemoProvider):
    """
    LLM-assisted memo drafting via Anthropic Claude.

    Requires ANTHROPIC_API_KEY environment variable. Falls back to raising
    ProviderNotConfiguredError — callers should catch this and fall back to
    DeterministicProvider if needed.

    Output is stored as draft text only. The rubric engine and citation
    validator run independently and are not affected by this provider.
    """

    MODEL = "claude-haiku-4-5-20251001"

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("ANTHROPIC_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "ANTHROPIC_API_KEY is not set. Use DeterministicProvider instead."
            )

    @property
    def provider_name(self) -> str:
        return f"anthropic/{self.MODEL}"

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
        import anthropic

        citations_block = "\n".join(f"- {excerpt}" for excerpt in citation_excerpts)
        user_prompt = f"""Draft an underwriting memo for this incident:

Incident: {incident_summary}
Location: {incident_location}
Risk type: {risk_type}
Severity: {severity} (confidence: {confidence:.0%})

Supporting citations:
{citations_block}

Return JSON with keys: summary (string), open_questions (list of strings)."""

        client = anthropic.Anthropic(api_key=self._api_key)
        # Mark the system prompt as cacheable. Anthropic prompt-cache TTL is
        # 5 minutes — back-to-back eval runs (15 scenarios) and bursts of
        # incident submissions both stay well within that window, so the
        # system block ends up amortized across the burst.
        response = client.messages.create(
            model=self.MODEL,
            max_tokens=512,
            system=[
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )

        import json
        raw = response.content[0].text.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        parsed = json.loads(raw.strip())

        return MemoOutput(
            summary=parsed["summary"],
            open_questions=parsed.get("open_questions", []),
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )


CLASSIFIER_SYSTEM_PROMPT = """You are a risk classifier for Third Space Risk, an underwriting
system for nightlife venues. You classify incident reports into a fixed taxonomy.

Rules:
- Output ONLY one of these risk_type values: altercation_event, premises_liability,
  liquor_liability, medical_emergency, crowd_management, property_damage, general_incident.
- Output ONLY one of these base_severity values: low, medium, high, critical.
- base_severity is the severity inherent to the incident type, BEFORE any escalation for
  observed injury / police / EMS — the runtime applies those gates separately.
- base_confidence reflects how clearly the summary fits the chosen risk_type, in [0.5, 0.99].
- rationale: one sentence explaining the classification, grounded in the summary.
- If uncertain between two types, prefer the more conservative (higher-severity) one."""


class AnthropicRiskClassifier(RiskClassifierProvider):
    """LLM-assisted incident classification via Anthropic Claude Haiku 4.5.

    Uses tool-use for guaranteed structured output. Falls back via the runtime's
    try/except — this class does not catch its own errors.
    """

    MODEL = "claude-haiku-4-5-20251001"

    def __init__(self) -> None:
        import os
        self._api_key = os.getenv("ANTHROPIC_API_KEY")
        if not self._api_key:
            raise ProviderNotConfiguredError(
                "ANTHROPIC_API_KEY is not set. Use DeterministicRiskClassifier instead."
            )

    @property
    def provider_name(self) -> str:
        return f"anthropic/{self.MODEL}"

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
        import anthropic

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

        classify_tool = {
            "name": "classify_incident",
            "description": "Return the risk classification for this incident.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "risk_type": {"type": "string", "enum": list(ALLOWED_RISK_TYPES)},
                    "base_severity": {"type": "string", "enum": list(ALLOWED_SEVERITIES)},
                    "base_confidence": {"type": "number", "minimum": 0.5, "maximum": 0.99},
                    "rationale": {"type": "string"},
                },
                "required": ["risk_type", "base_severity", "base_confidence", "rationale"],
            },
        }

        client = anthropic.Anthropic(api_key=self._api_key)
        response = client.messages.create(
            model=self.MODEL,
            max_tokens=512,
            system=[
                {
                    "type": "text",
                    "text": CLASSIFIER_SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            tools=[classify_tool],
            tool_choice={"type": "tool", "name": "classify_incident"},
            messages=[{"role": "user", "content": user_prompt}],
        )

        tool_use = next(
            (block for block in response.content if getattr(block, "type", None) == "tool_use"),
            None,
        )
        if tool_use is None:
            raise RuntimeError("Anthropic response missing classify_incident tool_use block")

        parsed = tool_use.input
        return RiskClassification(
            risk_type=parsed["risk_type"],
            base_severity=parsed["base_severity"],
            base_confidence=float(parsed["base_confidence"]),
            rationale=parsed["rationale"],
            provider=self.provider_name,
            mode=self.mode,
            model=self.MODEL,
        )


class ProviderNotConfiguredError(RuntimeError):
    pass
