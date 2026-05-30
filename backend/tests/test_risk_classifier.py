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


# ─── Off-topic detection (eval ADV-005 / ADV-006) ─────────────────────────
#
# A non-incident note misrouted into the incident form must classify as
# general_incident (→ never auto-approved), NOT get false-matched to a real
# exposure by an incidental keyword. ADV-006 reads "...crowd was well-behaved
# ... No incidents to report" — without this guard the bare word "crowd"
# lands it as crowd_management/high, polluting the risk signal and passing the
# safety scorer only by the accident of high→needs_review.


@pytest.mark.parametrize("summary", [
    # ADV-006: positive end-of-night note (note the "crowd" decoy word)
    "Great night, crowd was well-behaved, security ran a tight ship. "
    "No incidents to report. Just wanted to log a positive shift.",
    # explicit no-incident declarations
    "Quiet evening, nothing to report.",
    "All good tonight, no incident at all.",
])
def test_off_topic_no_incident_notes_classify_general(summary):
    result = DeterministicRiskClassifier().classify(
        incident_summary=summary, incident_location="venue", citation_excerpts=[],
    )
    assert result.risk_type == "general_incident"
    assert result.base_severity != "high"


def test_real_crowd_incident_still_classifies_crowd_management():
    # Guard: the off-topic check must not swallow a genuine crowd incident.
    result = DeterministicRiskClassifier().classify(
        incident_summary="Crowd surge near the stage; two patrons fainted.",
        incident_location="floor", citation_excerpts=[],
    )
    assert result.risk_type == "crowd_management"
    assert result.base_severity == "high"


# ─── Severity modifiers: deterministic aggravator/mitigator reasoning ─────
#
# The keyword ladder picks a coarse base severity from the incident *type*.
# Real underwriting severity also depends on aggravating circumstances
# (regulatory breach, foreseeable-and-preventable harm, negligent security)
# and mitigating ones (proactive controls, containment). These tests pin the
# modifier's behavior on the *substance* of the summary — phrased generically,
# never by scenario id — so the eval gains can't be faked by string-matching
# the gold set.


@pytest.mark.parametrize("summary,expected_severity", [
    # Aggravators that should escalate to critical
    (
        "Liquor service of tequila shots continuing after legal cutoff time, dram shop exposure",
        "critical",  # service past cutoff
    ),
    (
        "Bartender served draft beer to a patron whose wristband was issued without an ID scan, dram shop and license compliance exposure",
        "critical",  # underage / missing-ID service
    ),
    (
        "Patron assaulted in venue parking lot off-premises, venue advertises lot security, no security staff present in zone",
        "critical",  # advertised-but-absent security (negligent security)
    ),
    (
        "Patron physically assaulted at rear exit, three prior similar assaults documented in 60 days, no security staff detected in zone",
        "critical",  # foreseeable repeat harm
    ),
    (
        "Patron showed acute respiratory distress consistent with allergic reaction at main bar, staff delayed calling EMS for several minutes",
        "critical",  # life-threatening medical + delayed EMS
    ),
    # Single-step aggravator: documented overcapacity bumps medium -> high
    (
        "Patron slipped and fell in main corridor with documented overcapacity, 250 patrons in zone exceeding posted limit",
        "high",
    ),
    # Mitigators that should downgrade to low
    (
        "Crowd management on dance floor with security present and proactive water distribution",
        "low",  # proactive controls
    ),
    (
        "Small kitchen fire behind the line, staff deployed extinguisher within 30 seconds, no evacuation required, no injuries reported",
        "low",  # containment, no harm
    ),
])
def test_severity_modifiers_adjust_for_circumstances(summary, expected_severity):
    result = DeterministicRiskClassifier().classify(
        incident_summary=summary, incident_location="venue", citation_excerpts=[]
    )
    assert result.base_severity == expected_severity, result.rationale


@pytest.mark.parametrize("summary,expected_severity", [
    # Generalization guards: NOVEL summaries (not in the gold set) carrying the
    # same signals must move the same way.
    (
        "Bouncer assaulted a patron at the door, four prior similar assaults this quarter, no security posted",
        "critical",  # foreseeable repeat, generalized
    ),
    (
        "Small electrical fire flared at the bar, staff extinguished it within seconds, no injuries, no evacuation needed",
        "low",  # containment, generalized
    ),
    # Guards that the modifier does NOT over-fire on plain incidents
    (
        "Bartender continued serving an intoxicated patron.",
        "high",  # plain over-service: stays high, NOT critical
    ),
    (
        "Crowd surge near the front of the stage.",
        "high",  # plain crowd surge: no mitigators, stays high
    ),
    (
        "Two patrons began fighting near the rear bar.",
        "medium",  # plain brawl: no aggravators, stays medium
    ),
])
def test_severity_modifiers_generalize_without_overfitting(summary, expected_severity):
    result = DeterministicRiskClassifier().classify(
        incident_summary=summary, incident_location="venue", citation_excerpts=[]
    )
    assert result.base_severity == expected_severity, result.rationale


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


def _signal_for(summary: str, **flags):
    incident = IncidentCreate(
        occurred_at="2026-05-02T23:13:00Z",
        location="venue",
        summary=summary,
        reported_by="shift-lead",
        injury_observed=flags.get("injury_observed", False),
        police_called=flags.get("police_called", False),
        ems_called=flags.get("ems_called", False),
    )
    runtime = UnderwritingPacketAgentRuntime(risk_classifier=DeterministicRiskClassifier())
    return runtime._run_risk_evaluator_agent(citations=[], incident=incident)


def test_unrecognized_input_routes_to_review_not_auto_approved():
    """Safety: an off-topic / non-incident input the classifier can't place
    must NOT auto-approve — it routes to needs_review so a human catches the
    misroute. (ADV-005 menu-question regression.)"""
    signal = _signal_for("Can the bar team get more limes for the weekend? Cocktail menu needs them.")
    assert signal.type == "general_incident"
    assert signal.severity == "low"
    assert signal.review_status == "needs_review"


def test_recognized_low_incident_still_auto_approves():
    """Guard: a *recognized* low-severity incident (mitigated crowd event)
    still auto-approves — the review gate only opens for unrecognized input,
    not every low-severity packet."""
    signal = _signal_for("Crowd management on dance floor with security present and proactive water distribution")
    assert signal.type == "crowd_management"
    assert signal.severity == "low"
    assert signal.review_status == "approved"


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
