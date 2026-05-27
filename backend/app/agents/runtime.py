from dataclasses import dataclass
from pathlib import Path

from app.rag import SemanticKnowledgeBase as VenueKnowledgeBase
from app.providers import (
    MemoProvider,
    RiskClassifierProvider,
    get_default_provider,
    get_default_risk_classifier,
)
from app.schemas import ActionItem, Citation, ClaimsTimelineMeta, IncidentCreate, RiskSignal, TimelineEvent, UnderwritingMemo


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
    claims_timeline_meta: ClaimsTimelineMeta
    underwriting_memo: UnderwritingMemo
    execution_trace: list[AgentExecutionStep]


class UnderwritingPacketAgentRuntime:
    def __init__(
        self,
        contracts_dir: Path | None = None,
        memo_provider: MemoProvider | None = None,
        risk_classifier: RiskClassifierProvider | None = None,
    ):
        self._contracts_dir = contracts_dir or Path(__file__).resolve().parent
        self._memo_provider = memo_provider or get_default_provider()
        self._risk_classifier = risk_classifier or get_default_risk_classifier()
        self._last_risk_evaluator_mode = "deterministic"
        self._last_memo_mode = "deterministic"

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
        trace.append(self._trace_step(
            "risk_evaluator_agent", contracts, execution_mode=self._last_risk_evaluator_mode,
        ))

        action_plan = self._run_customer_action_agent(incident=incident, risk_signal=risk_signal)
        trace.append(self._trace_step("customer_action_agent", contracts))

        claims_timeline, claims_timeline_meta = self._run_claims_timeline_agent(
            venue_id=venue_id,
            incident=incident,
            stream_events=stream_events,
        )
        trace.append(self._trace_step("claims_timeline_agent", contracts))

        underwriting_memo = self._run_underwriter_memo_agent(
            incident=incident, risk_signal=risk_signal, citations=citations
        )
        trace.append(self._trace_step(
            "underwriter_memo_agent", contracts, execution_mode=self._last_memo_mode,
        ))

        return UnderwritingPacketAgentResult(
            citations=citations,
            risk_signal=risk_signal,
            action_plan=action_plan,
            claims_timeline=claims_timeline,
            claims_timeline_meta=claims_timeline_meta,
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

    def _trace_step(
        self,
        agent_name: str,
        contracts: dict[str, Path],
        execution_mode: str = "deterministic",
    ) -> AgentExecutionStep:
        return AgentExecutionStep(
            agent_name=agent_name,
            contract_version=CONTRACT_VERSION,
            contract_path=str(contracts[agent_name]),
            execution_mode=execution_mode,
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
        """Classify (LLM or deterministic) then apply hard-signal escalation.

        The classifier picks (risk_type, base_severity, base_confidence). The
        injury/police/EMS escalation runs in code so the model can never relax
        a severity that the hard signals imply.
        """
        injury = getattr(incident, "injury_observed", False) if incident else False
        police = getattr(incident, "police_called", False) if incident else False
        ems = getattr(incident, "ems_called", False) if incident else False
        summary = getattr(incident, "summary", "") if incident else ""
        location = getattr(incident, "location", "") if incident else ""

        classification = self._classify_with_fallback(
            incident_summary=summary,
            incident_location=location,
            citation_excerpts=[c.excerpt for c in citations],
        )
        self._last_risk_evaluator_mode = classification.mode.value

        severity_order = ["low", "medium", "high", "critical"]
        severity = classification.base_severity
        if severity not in severity_order:
            severity = "low"  # defensive — should be impossible via enum schema
        if ems and severity_order.index(severity) < severity_order.index("critical"):
            severity = severity_order[severity_order.index(severity) + 1]
        if injury and police and severity_order.index(severity) < severity_order.index("high"):
            severity = "high"
        confidence = min(
            classification.base_confidence + (0.04 if police else 0) + (0.03 if ems else 0),
            0.99,
        )

        severity_explanations = {
            "critical": "Multiple aggravating factors present. Immediate carrier escalation and legal hold recommended.",
            "high": "Significant liability exposure identified. Evidence preservation and underwriter review required.",
            "medium": "Moderate exposure detected. Staffing and capacity controls may mitigate premium impact if evidence is preserved.",
            "low": "Limited liability exposure. Standard documentation and follow-up recommended.",
        }

        review_status = "approved" if severity == "low" else "needs_review"

        return RiskSignal(
            type=classification.risk_type,
            severity=severity,
            confidence=round(confidence, 2),
            explanation=severity_explanations[severity],
            review_status=review_status,
            citations=citations,
        )

    def _classify_with_fallback(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        citation_excerpts: list[str],
    ):
        """Call the configured classifier; fall back to deterministic on any error.

        A transient LLM hiccup must never block a packet — the deterministic
        keyword ladder is a complete classifier on its own.
        """
        try:
            return self._risk_classifier.classify(
                incident_summary=incident_summary,
                incident_location=incident_location,
                citation_excerpts=citation_excerpts,
            )
        except Exception as exc:
            import logging
            primary = getattr(self._risk_classifier, "provider_name", "unknown")
            logging.warning(
                "Risk classifier %s failed (%s); using deterministic.",
                primary, exc.__class__.__name__,
            )
            from app.providers.deterministic import DeterministicRiskClassifier
            return DeterministicRiskClassifier().classify(
                incident_summary=incident_summary,
                incident_location=incident_location,
                citation_excerpts=citation_excerpts,
            )

    def _run_customer_action_agent(
        self,
        *,
        incident: IncidentCreate,
        risk_signal: RiskSignal,
    ) -> list[ActionItem]:
        """Produce a venue-facing action plan keyed to the incident type and
        the hard signals (injury / police / EMS).

        The first action is always the universal preservation task — existing
        consumers (frontend, brawl-flow tests) pin to that position. Subsequent
        items are added based on:
          1) risk_signal.type   — defensibility tasks specific to the claim
                                   family (altercation/premises/liquor/medical).
          2) hard signals       — police, EMS, injury each demand specific
                                   third-party records.
          3) severity           — critical/high incidents add an
                                   immediate-escalation task.
        """
        actions: list[ActionItem] = [
            ActionItem(
                title="Preserve incident evidence",
                rationale="A clean evidence package makes the event defensible if a claim appears later.",
                evidence_needed=[
                    "Camera footage covering the incident window (±15 min)",
                    "Completed witness / contact section",
                    "Security lead narrative",
                ],
            ),
            ActionItem(
                title="Complete same-night manager follow-up",
                rationale="Underwriters value contemporaneous records over reconstructed notes.",
                evidence_needed=[
                    "Manager sign-off",
                    "Police / EMS confirmation fields",
                    "Removal / trespass outcome",
                ],
            ),
        ]

        actions.extend(self._risk_type_actions(risk_signal))
        actions.extend(self._hard_signal_actions(incident))

        if risk_signal.severity in ("critical", "high"):
            actions.append(ActionItem(
                title="Escalate to broker on-call within 24 hours",
                rationale=(
                    f"Severity={risk_signal.severity} incidents typically trigger "
                    "carrier reserve set-aside; broker engagement before the next "
                    "business day prevents reserve disputes later."
                ),
                evidence_needed=[
                    "Broker on-call acknowledgement",
                    "Reserve / notice-of-occurrence intent",
                ],
            ))

        return actions

    @staticmethod
    def _risk_type_actions(risk_signal: RiskSignal) -> list[ActionItem]:
        """Risk-type-specific defensibility tasks. Mirrors the taxonomy in
        DeterministicProvider.draft_memo so the action plan and memo agree
        on what the claim family is."""
        risk_type = risk_signal.type
        if risk_type == "altercation_event":
            return [ActionItem(
                title="Isolate involved parties and document security response",
                rationale=(
                    "Altercation claims hinge on whether security separated "
                    "parties promptly. A documented isolation timeline + a "
                    "trespass / removal outcome blocks the 'failure to intervene' "
                    "argument carriers see most."
                ),
                evidence_needed=[
                    "Timestamped security action log (intervention, removal)",
                    "Trespass or 86 list update for involved patrons",
                    "Door-staff narrative on re-entry attempts",
                ],
            )]
        if risk_type == "premises_liability":
            return [ActionItem(
                title="Document site condition and hazard inspection",
                rationale=(
                    "Premises claims turn on whether the venue had notice of the "
                    "hazard. Photo evidence of the location, plus the latest "
                    "inspection log, defends against constructive-notice claims."
                ),
                evidence_needed=[
                    "Site photos taken within 30 minutes of the incident",
                    "Most recent floor / stairs / lighting inspection log",
                    "Maintenance ticket history for the area (last 30 days)",
                ],
            )]
        if risk_type == "liquor_liability":
            return [ActionItem(
                title="Pull pour log and cutoff documentation for involved patrons",
                rationale=(
                    "Liquor-liability defenses require evidence the venue did not "
                    "over-serve and applied a cutoff. POS pour history + bartender "
                    "training records are the standard ask."
                ),
                evidence_needed=[
                    "POS service log for involved patron(s)",
                    "Bartender's account of cutoff timing",
                    "Current bartender alcohol-service training certificates",
                ],
            )]
        if risk_type == "medical_emergency":
            return [ActionItem(
                title="Request hospital release and EMS transport documentation",
                rationale=(
                    "Medical-emergency packets need third-party medical records "
                    "to align the venue's account with the patient's outcome. "
                    "Without these, the claim sits with reserve set-aside but "
                    "no quantified loss."
                ),
                evidence_needed=[
                    "Hospital admission / discharge confirmation",
                    "EMS transport run sheet",
                    "Signed release authorizing carrier review of records",
                ],
            )]
        return []

    @staticmethod
    def _hard_signal_actions(incident: IncidentCreate) -> list[ActionItem]:
        items: list[ActionItem] = []
        if incident.police_called:
            items.append(ActionItem(
                title="Request police report and officer contact",
                rationale=(
                    "Police-involved incidents require the official report number "
                    "to anchor the timeline; carriers will not finalize reserves "
                    "without it."
                ),
                evidence_needed=[
                    "Police report number",
                    "Responding officer name / badge",
                    "Booking outcome (if any patron arrested)",
                ],
            ))
        if incident.ems_called:
            items.append(ActionItem(
                title="Obtain EMS / paramedic transport documentation",
                rationale=(
                    "EMS dispatch logs prove the venue called for help promptly "
                    "and document patient acuity on scene — both are levers "
                    "against negligence claims."
                ),
                evidence_needed=[
                    "EMS dispatch call timestamp",
                    "Paramedic / ambulance run sheet",
                    "Receiving hospital name",
                ],
            ))
        if incident.injury_observed:
            items.append(ActionItem(
                title="Lock witness contact details same-night",
                rationale=(
                    "Witness recall degrades within 48 hours; an injury-observed "
                    "incident demands signed witness contact records before the "
                    "shift ends."
                ),
                evidence_needed=[
                    "Witness name, phone, email (minimum two witnesses)",
                    "Witness statement on what they directly observed",
                    "Manager-signed contemporaneous witness log",
                ],
            ))
        return items

    def _run_claims_timeline_agent(
        self,
        *,
        venue_id: str,
        incident: IncidentCreate,
        stream_events: list[dict],
    ) -> tuple[list[TimelineEvent], ClaimsTimelineMeta]:
        """Reconstruct an ordered chronology AND characterize it.

        Returns the event list (unchanged shape for backwards compat) plus a
        ClaimsTimelineMeta carrying gaps, defensibility_notes, review_status
        — the fields the contract describes that were previously ignored.
        """
        venue_events = [e for e in stream_events if e.get("venue_id") == venue_id]

        timeline: list[TimelineEvent] = [
            TimelineEvent(at=event["at"], label=event["label"], source=event["source_id"])
            for event in venue_events
        ]
        timeline.append(
            TimelineEvent(
                at=incident.occurred_at,
                label=f"Incident logged by {incident.reported_by}: {incident.summary}",
                source="venue:incident-report",
            )
        )

        meta = self._reconstruct_timeline_meta(incident=incident, venue_events=venue_events)
        return timeline, meta

    @staticmethod
    def _reconstruct_timeline_meta(
        *,
        incident: IncidentCreate,
        venue_events: list[dict],
    ) -> ClaimsTimelineMeta:
        """Compute gaps + defensibility + review_status. Pure function over
        the venue-filtered stream events + the incident report."""
        from datetime import datetime, timedelta

        from app.time import as_utc

        def _parse(ts: str):
            if not ts:
                return None
            try:
                # Normalize to tz-aware UTC so naive incident timestamps (seed
                # data stores occurred_at without a tz) compare cleanly against
                # aware stream-event times that carry 'Z'.
                return as_utc(datetime.fromisoformat(ts.replace("Z", "+00:00")))
            except ValueError:
                return None

        incident_at = _parse(incident.occurred_at)
        if incident_at is None:
            # Contract: blocked if the reported incident can't be anchored in time.
            return ClaimsTimelineMeta(
                gaps=["Incident report has no parseable timestamp."],
                defensibility_notes=["Cannot reconstruct chronology without an incident time."],
                review_status="blocked",
            )

        parsed_events = [(_parse(e.get("at", "")), e) for e in venue_events]
        # Drop events with unparseable timestamps but flag them as a gap.
        unparseable = sum(1 for ts, _ in parsed_events if ts is None)
        valid = [(ts, e) for ts, e in parsed_events if ts is not None]

        before = [(ts, e) for ts, e in valid if ts < incident_at]
        after = [(ts, e) for ts, e in valid if ts > incident_at]

        # ─── Gaps ─────────────────────────────────────────────────────────
        gaps: list[str] = []
        if not before:
            gaps.append("No pre-incident telemetry: nothing in the venue's event stream before the reported time.")
        if not after:
            gaps.append("No post-incident telemetry: no follow-up events from cameras, POS, or door-count.")

        # 30-min capacity blind spot
        window_start = incident_at - timedelta(minutes=30)
        capacity_in_window = [
            (ts, e) for ts, e in valid
            if window_start <= ts <= incident_at and "door" in e.get("source_id", "").lower()
        ]
        if not capacity_in_window:
            gaps.append("Capacity blind spot: no door-count reading in the 30 minutes leading up to the incident.")

        # Camera coverage at incident time
        camera_near_incident = [
            (ts, e) for ts, e in valid
            if abs((ts - incident_at).total_seconds()) <= 600 and "camera" in e.get("source_id", "").lower()
        ]
        if not camera_near_incident and valid:
            gaps.append("No camera coverage within ±10 minutes of the incident; visual corroboration unavailable.")

        if unparseable:
            gaps.append(
                f"{unparseable} stream event(s) had unparseable timestamps and were excluded from the chronology."
            )

        # ─── Defensibility scoring ────────────────────────────────────────
        # Count distinct source families ("door", "pos", "camera", ...)
        source_families: set[str] = set()
        for _, e in valid:
            sid = e.get("source_id", "")
            family = sid.split(":")[1].split("-")[0] if ":" in sid else sid
            source_families.add(family.lower())

        # Hard signals on the report itself widen evidence ask (and weaken the
        # 'operator-only narrative' case even if no streams exist).
        hard_signals = sum([incident.injury_observed, incident.police_called, incident.ems_called])

        defensibility_notes: list[str] = []
        if len(source_families) >= 3:
            defensibility_notes.append(
                f"Strong defensibility: chronology corroborated by {len(source_families)} independent source types "
                f"({', '.join(sorted(source_families))})."
            )
        elif len(source_families) == 2:
            defensibility_notes.append(
                f"Moderate defensibility: corroborated by 2 source types ({', '.join(sorted(source_families))}). "
                "A third independent source would harden the timeline."
            )
        elif len(source_families) == 1:
            family = next(iter(source_families))
            defensibility_notes.append(
                f"Limited defensibility: only one source type ({family}) backs the timeline outside the operator's account."
            )
        else:
            defensibility_notes.append(
                "Weak defensibility: only the operator's narrative exists — no independent stream events corroborate the timeline."
            )

        if hard_signals >= 2:
            defensibility_notes.append(
                f"Hard signals ({hard_signals} of injury/police/EMS) require third-party records "
                "(police report, EMS run sheet, hospital release) to close the evidence gap."
            )

        # ─── Review status ────────────────────────────────────────────────
        review_status = "complete"
        # Weak defensibility OR any gaps -> needs_review
        if not valid:
            review_status = "needs_review"
        elif gaps:
            review_status = "needs_review"
        elif len(source_families) < 2 and hard_signals == 0:
            review_status = "needs_review"

        return ClaimsTimelineMeta(
            gaps=gaps,
            defensibility_notes=defensibility_notes,
            review_status=review_status,
        )

    def _run_underwriter_memo_agent(
        self,
        *,
        incident: IncidentCreate,
        risk_signal: RiskSignal,
        citations: list[Citation],
    ) -> UnderwritingMemo:
        # Try the configured provider; fall back to deterministic so a transient
        # LLM hiccup (network, rate limit, malformed JSON) never blocks an
        # incident from getting a packet. Capture the failure reason so it's
        # visible in the response (and not just buried in logs).
        fallback_reason: str | None = None
        try:
            memo_output = self._memo_provider.draft_memo(
                incident_summary=incident.summary,
                incident_location=incident.location,
                risk_type=risk_signal.type,
                severity=risk_signal.severity,
                confidence=risk_signal.confidence,
                citation_excerpts=[c.excerpt for c in citations],
            )
        except Exception as exc:
            import logging
            primary_provider = getattr(self._memo_provider, "provider_name", "unknown")
            fallback_reason = f"{primary_provider} failed: {exc.__class__.__name__}: {str(exc)[:200]}"
            logging.warning("Memo: %s — falling back to deterministic.", fallback_reason)
            from app.providers.deterministic import DeterministicProvider
            memo_output = DeterministicProvider().draft_memo(
                incident_summary=incident.summary,
                incident_location=incident.location,
                risk_type=risk_signal.type,
                severity=risk_signal.severity,
                confidence=risk_signal.confidence,
                citation_excerpts=[c.excerpt for c in citations],
            )
        self._last_memo_mode = memo_output.mode.value
        return UnderwritingMemo(
            summary=memo_output.summary,
            open_questions=memo_output.open_questions,
            review_status="draft",
            citations=citations,
            provider=memo_output.provider,
            model=memo_output.model,
            fallback_reason=fallback_reason,
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
