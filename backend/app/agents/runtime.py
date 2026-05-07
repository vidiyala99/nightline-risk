from dataclasses import dataclass
from pathlib import Path

from app.rag_v2 import SemanticKnowledgeBase as VenueKnowledgeBase
from app.providers import MemoProvider, get_default_provider
from app.schemas import ActionItem, Citation, IncidentCreate, RiskSignal, TimelineEvent, UnderwritingMemo


CONTRACT_VERSION = "2026-05-03"
REQUIRED_CONTRACTS = {
    "retrieval_agent": "retrieval_agent.md",
    "risk_evaluator_agent": "risk_evaluator_agent.md",
    "customer_action_agent": "customer_action_agent.md",
    "claims_timeline_agent": "claims_timeline_agent.md",
    "underwriter_memo_agent": "underwriter_memo_agent.md",
}


class AgentContractError(RuntimeError):
    """Raised when runtime agent contracts cannot be loaded."""


@dataclass(frozen=True)
class AgentExecutionStep:
    agent_name: str
    contract_version: str
    contract_path: str
    execution_mode: str = "deterministic"


@dataclass(frozen=True)
class UnderwritingPacketAgentResult:
    citations: list[Citation]
    risk_signal: RiskSignal
    action_plan: list[ActionItem]
    claims_timeline: list[TimelineEvent]
    underwriting_memo: UnderwritingMemo
    execution_trace: list[AgentExecutionStep]


class UnderwritingPacketAgentRuntime:
    def __init__(
        self,
        contracts_dir: Path | None = None,
        memo_provider: MemoProvider | None = None,
    ):
        self._contracts_dir = contracts_dir or Path(__file__).resolve().parent
        self._memo_provider = memo_provider or get_default_provider()

    def execute(
        self,
        *,
        venue_id: str,
        venue: dict,
        incident: IncidentCreate,
        knowledge_sources: list[dict],
        stream_events: list[dict],
        policy_context: dict | None = None,
        prior_packet_outputs: dict | None = None,
    ) -> UnderwritingPacketAgentResult:
        contracts = self._load_contracts()
        trace: list[AgentExecutionStep] = []

        citations = self._run_retrieval_agent(
            venue_id=venue_id,
            incident=incident,
            knowledge_sources=knowledge_sources,
            stream_events=stream_events,
        )
        trace.append(self._trace_step("retrieval_agent", contracts))

        risk_signal = self._run_risk_evaluator_agent(citations=citations, incident=incident)
        trace.append(self._trace_step("risk_evaluator_agent", contracts))

        action_plan = self._run_customer_action_agent()
        trace.append(self._trace_step("customer_action_agent", contracts))

        claims_timeline = self._run_claims_timeline_agent(
            venue_id=venue_id,
            incident=incident,
            stream_events=stream_events,
        )
        trace.append(self._trace_step("claims_timeline_agent", contracts))

        underwriting_memo = self._run_underwriter_memo_agent(
            incident=incident, risk_signal=risk_signal, citations=citations
        )
        trace.append(self._trace_step("underwriter_memo_agent", contracts))

        return UnderwritingPacketAgentResult(
            citations=citations,
            risk_signal=risk_signal,
            action_plan=action_plan,
            claims_timeline=claims_timeline,
            underwriting_memo=underwriting_memo,
            execution_trace=trace,
        )

    def _load_contracts(self) -> dict[str, Path]:
        contracts: dict[str, Path] = {}
        for agent_name, file_name in REQUIRED_CONTRACTS.items():
            contract_path = self._contracts_dir / file_name
            if not contract_path.exists():
                raise AgentContractError(f"Missing required agent contract: {contract_path}")
            contract_text = contract_path.read_text(encoding="utf-8")
            if "## Current Runtime Status" not in contract_text:
                raise AgentContractError(f"Agent contract lacks runtime status section: {contract_path}")
            contracts[agent_name] = contract_path
        return contracts

    def _trace_step(self, agent_name: str, contracts: dict[str, Path]) -> AgentExecutionStep:
        return AgentExecutionStep(
            agent_name=agent_name,
            contract_version=CONTRACT_VERSION,
            contract_path=str(contracts[agent_name]),
        )

    def _run_retrieval_agent(
        self,
        *,
        venue_id: str,
        incident: IncidentCreate,
        knowledge_sources: list[dict],
        stream_events: list[dict],
    ) -> list[Citation]:
        knowledge_base = VenueKnowledgeBase(knowledge_sources, stream_events)
        summary_lower = incident.summary.lower()
        # Build a type-aware query so retrieved citations actually match the incident
        if any(k in summary_lower for k in ["brawl", "fight", "altercation", "assault", "force"]):
            type_keywords = "altercation security response duty of care footage staff"
        elif any(k in summary_lower for k in ["slip", "fell", "fall", "stairs"]):
            type_keywords = "premises liability hazard wet floor signage inspection"
        elif any(k in summary_lower for k in ["overdose", "unresponsive", "medical", "ems"]):
            type_keywords = "medical emergency duty of care ems response negligence"
        elif any(k in summary_lower for k in ["fire", "electrical", "smoke"]):
            type_keywords = "property damage fire suppression equipment inspection liability"
        elif any(k in summary_lower for k in ["liquor", "serving", "intoxicated", "cutoff"]):
            type_keywords = "liquor liability dram shop over-service POS compliance"
        elif any(k in summary_lower for k in ["vandal", "damage", "broken"]):
            type_keywords = "property damage vandalism third-party liability"
        else:
            type_keywords = "incident report policy compliance documentation"
        query = f"{incident.summary} {incident.location} {type_keywords}"
        return knowledge_base.retrieve(venue_id, query)

    def _run_risk_evaluator_agent(
        self, *, citations: list[Citation], incident: IncidentCreate | None = None
    ) -> RiskSignal:
        injury = getattr(incident, "injury_observed", False) if incident else False
        police = getattr(incident, "police_called", False) if incident else False
        ems = getattr(incident, "ems_called", False) if incident else False
        summary = (getattr(incident, "summary", "") or "").lower() if incident else ""

        # Determine type from summary keywords
        if any(k in summary for k in ["fire", "electrical"]):
            incident_type, base_severity, base_confidence = "property_damage", "medium", 0.82
        elif any(k in summary for k in ["overdose", "unresponsive", "hospital"]):
            incident_type, base_severity, base_confidence = "medical_emergency", "critical", 0.94
        elif any(k in summary for k in ["assault", "excessive force", "fight", "brawl", "fighting"]):
            incident_type, base_severity, base_confidence = "altercation_event", "medium", 0.78
        elif any(k in summary for k in ["slip", "fell", "fall", "stairs"]):
            incident_type, base_severity, base_confidence = "premises_liability", "medium", 0.81
        elif any(k in summary for k in ["serving", "liquor", "intoxicated", "cutoff", "dram"]):
            incident_type, base_severity, base_confidence = "liquor_liability", "high", 0.91
        elif any(k in summary for k in ["crowd", "surge", "faint"]):
            incident_type, base_severity, base_confidence = "crowd_management", "high", 0.87
        elif any(k in summary for k in ["vandal", "damage"]):
            incident_type, base_severity, base_confidence = "property_damage", "low", 0.74
        else:
            incident_type, base_severity, base_confidence = "general_incident", "low", 0.70

        # Escalate severity based on flags
        severity_order = ["low", "medium", "high", "critical"]
        severity = base_severity
        if ems and severity_order.index(severity) < severity_order.index("critical"):
            severity = severity_order[severity_order.index(severity) + 1]
        if injury and police and severity_order.index(severity) < severity_order.index("high"):
            severity = "high"
        confidence = min(base_confidence + (0.04 if police else 0) + (0.03 if ems else 0), 0.99)

        severity_explanations = {
            "critical": "Multiple aggravating factors present. Immediate carrier escalation and legal hold recommended.",
            "high": "Significant liability exposure identified. Evidence preservation and underwriter review required.",
            "medium": "Moderate exposure detected. Staffing and capacity controls may mitigate premium impact if evidence is preserved.",
            "low": "Limited liability exposure. Standard documentation and follow-up recommended.",
        }

        review_status = "approved" if severity == "low" else "needs_review"

        return RiskSignal(
            type=incident_type,
            severity=severity,
            confidence=round(confidence, 2),
            explanation=severity_explanations[severity],
            review_status=review_status,
            citations=citations,
        )

    def _run_customer_action_agent(self) -> list[ActionItem]:
        return [
            ActionItem(
                title="Preserve incident evidence",
                rationale="A clean evidence package makes the event defensible if a claim appears later.",
                evidence_needed=[
                    "Reviewed rear-bar clip from 23:10-23:18",
                    "Completed witness/contact section",
                    "Security lead narrative",
                ],
            ),
            ActionItem(
                title="Complete same-night manager follow-up",
                rationale="Underwriters value contemporaneous records over reconstructed notes.",
                evidence_needed=["Manager sign-off", "Police/EMS confirmation fields", "Removal/trespass outcome"],
            ),
        ]

    def _run_claims_timeline_agent(
        self,
        *,
        venue_id: str,
        incident: IncidentCreate,
        stream_events: list[dict],
    ) -> list[TimelineEvent]:
        claims_timeline = [
            TimelineEvent(at=event["at"], label=event["label"], source=event["source_id"])
            for event in stream_events
            if event["venue_id"] == venue_id
        ]
        claims_timeline.append(
            TimelineEvent(
                at=incident.occurred_at,
                label=f"Incident logged by {incident.reported_by}: {incident.summary}",
                source="venue:incident-report",
            )
        )
        return claims_timeline

    def _run_underwriter_memo_agent(
        self,
        *,
        incident: IncidentCreate,
        risk_signal: RiskSignal,
        citations: list[Citation],
    ) -> UnderwritingMemo:
        memo_output = self._memo_provider.draft_memo(
            incident_summary=incident.summary,
            incident_location=incident.location,
            risk_type=risk_signal.type,
            severity=risk_signal.severity,
            confidence=risk_signal.confidence,
            citation_excerpts=[c.excerpt for c in citations],
        )
        return UnderwritingMemo(
            summary=memo_output.summary,
            open_questions=memo_output.open_questions,
            review_status=risk_signal.review_status,
            citations=citations,
        )


def execute_underwriting_packet_agents(
    *,
    venue_id: str,
    venue: dict,
    incident: IncidentCreate,
    knowledge_sources: list[dict],
    stream_events: list[dict],
    policy_context: dict | None = None,
    prior_packet_outputs: dict | None = None,
) -> UnderwritingPacketAgentResult:
    runtime = UnderwritingPacketAgentRuntime()
    return runtime.execute(
        venue_id=venue_id,
        venue=venue,
        incident=incident,
        knowledge_sources=knowledge_sources,
        stream_events=stream_events,
        policy_context=policy_context,
        prior_packet_outputs=prior_packet_outputs,
    )
