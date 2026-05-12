"""Tests for the LLM-backed risk classifier and its deterministic fallback."""

import pytest

from app.providers import (
    DeterministicRiskClassifier,
    GeminiRiskClassifier,
    get_default_risk_classifier,
)
from app.providers.base import (
    ProviderMode,
    RiskClassification,
    RiskClassifierProvider,
)
from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.schemas import IncidentCreate


@pytest.mark.parametrize("summary,expected_type,expected_severity", [
    ("Two patrons began fighting near the rear bar.", "altercation_event", "medium"),
    ("Patron slipped on the wet stairs.", "premises_liability", "medium"),
    ("Bartender continued serving an intoxicated patron.", "liquor_liability", "high"),
    ("Patron became unresponsive in the bathroom.", "medical_emergency", "critical"),
    ("Stage lighting caught fire during a set.", "property_damage", "medium"),
    ("Crowd surge near the front of the stage.", "crowd_management", "high"),
    ("Some chairs were broken by vandals.", "property_damage", "low"),
    ("A guest complained about the music.", "general_incident", "low"),
])
def test_deterministic_classifier_preserves_keyword_ladder(summary, expected_type, expected_severity):
    classifier = DeterministicRiskClassifier()
    result = classifier.classify(
        incident_summary=summary,
        incident_location="main floor",
        citation_excerpts=[],
    )
    assert result.risk_type == expected_type
    assert result.base_severity == expected_severity
    assert 0.5 <= result.base_confidence <= 0.99
    assert result.mode == ProviderMode.DETERMINISTIC


class _RaisingClassifier(RiskClassifierProvider):
    @property
    def provider_name(self) -> str:
        return "raising-mock"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    def classify(self, **_kwargs) -> RiskClassification:
        raise RuntimeError("simulated upstream LLM failure")


class _StubLLMClassifier(RiskClassifierProvider):
    @property
    def provider_name(self) -> str:
        return "stub-llm"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.LLM

    def classify(self, **_kwargs) -> RiskClassification:
        return RiskClassification(
            risk_type="liquor_liability",
            base_severity="high",
            base_confidence=0.92,
            rationale="Stub LLM classified as liquor_liability for test.",
            provider=self.provider_name,
            mode=self.mode,
            model="stub-1",
        )


DEMO_INCIDENT = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z",
    location="rear bar",
    summary="Two patrons began fighting near the rear bar.",
    reported_by="shift-lead",
    injury_observed=False,
    police_called=False,
    ems_called=False,
)


def test_runtime_falls_back_to_deterministic_when_classifier_raises():
    runtime = UnderwritingPacketAgentRuntime(risk_classifier=_RaisingClassifier())
    signal = runtime._run_risk_evaluator_agent(citations=[], incident=DEMO_INCIDENT)
    # Deterministic classifier would pick altercation_event/medium for the brawl summary
    assert signal.type == "altercation_event"
    assert signal.severity == "medium"
    assert runtime._last_risk_evaluator_mode == "deterministic"


def test_runtime_uses_llm_classifier_when_it_succeeds():
    runtime = UnderwritingPacketAgentRuntime(risk_classifier=_StubLLMClassifier())
    signal = runtime._run_risk_evaluator_agent(citations=[], incident=DEMO_INCIDENT)
    assert signal.type == "liquor_liability"
    assert signal.severity == "high"
    assert runtime._last_risk_evaluator_mode == "llm"


def test_classifier_factory_resolution_order(monkeypatch):
    """Anthropic > Gemini > Deterministic — mirrors get_default_provider for memo."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert isinstance(get_default_risk_classifier(), DeterministicRiskClassifier)

    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-not-real")
    assert isinstance(get_default_risk_classifier(), GeminiRiskClassifier)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test-not-real")
    # Anthropic wins when both are set
    from app.providers import AnthropicRiskClassifier
    assert isinstance(get_default_risk_classifier(), AnthropicRiskClassifier)


def test_hard_signal_escalation_overrides_classifier_severity():
    """Even if the classifier says 'low', EMS-called must escalate the final severity."""
    class _LowBallClassifier(RiskClassifierProvider):
        @property
        def provider_name(self) -> str: return "lowball"
        @property
        def mode(self) -> ProviderMode: return ProviderMode.LLM
        def classify(self, **_kwargs) -> RiskClassification:
            return RiskClassification(
                risk_type="general_incident",
                base_severity="low",
                base_confidence=0.7,
                rationale="lowball",
                provider="lowball",
                mode=ProviderMode.LLM,
            )

    incident = IncidentCreate(
        occurred_at=DEMO_INCIDENT.occurred_at,
        location=DEMO_INCIDENT.location,
        summary="Patron passed out at the bar.",
        reported_by="shift-lead",
        injury_observed=True,
        police_called=True,
        ems_called=True,
    )
    runtime = UnderwritingPacketAgentRuntime(risk_classifier=_LowBallClassifier())
    signal = runtime._run_risk_evaluator_agent(citations=[], incident=incident)
    # EMS bumps low → medium, then (injury AND police) gates severity ≥ high
    assert signal.severity == "high"
