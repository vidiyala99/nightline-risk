from app.providers.base import (
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


class DeterministicTranscriptionProvider(TranscriptionProvider):
    """Placeholder transcription used when OPENAI_API_KEY is not configured.

    Returns a clear "unavailable" marker so the downstream audit trail records
    that audio was received but not transcribed, rather than silently producing
    an empty string that could be mistaken for a real (empty) transcript.
    """

    @property
    def provider_name(self) -> str:
        return "deterministic-transcription-v1"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.DETERMINISTIC

    def transcribe(self, *, file_path: str, content_type: str) -> TranscriptionOutput:
        return TranscriptionOutput(
            text="[transcription unavailable — OPENAI_API_KEY not configured]",
            language=None,
            duration_seconds=None,
            provider=self.provider_name,
            mode=self.mode,
        )


class DeterministicEmbeddingProvider(EmbeddingProvider):
    """No-op embeddings — raises on use.

    Unlike memo / classifier / transcription, there is no meaningful local
    deterministic fallback for embeddings: a TF-IDF retriever already covers
    that gap (see app/rag.py). If you reach this provider, you have asked for
    embeddings without configuring an embedding API — which is a configuration
    error, not a fallback condition. Fail loudly so the retriever isn't fed
    garbage vectors.
    """

    DIMENSIONS = 0

    @property
    def provider_name(self) -> str:
        return "deterministic-embedding-v1"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.DETERMINISTIC

    @property
    def dimensions(self) -> int:
        return self.DIMENSIONS

    def embed(self, texts: list[str]) -> EmbeddingOutput:
        raise NotImplementedError(
            "DeterministicEmbeddingProvider does not produce vectors. "
            "Configure OPENAI_API_KEY for OpenAIEmbeddingProvider, or use the "
            "TF-IDF retriever in app/rag.py for keyword-similarity retrieval."
        )


_KEYWORD_LADDER = [
    (("fire", "electrical"), "property_damage", "medium", 0.82),
    (
        (
            "overdose", "unresponsive", "hospital", "respiratory distress",
            "allergic reaction", "anaphyla", "seizure", "cardiac", "collapsed",
            "unconscious",
        ),
        "medical_emergency",
        "critical",
        0.94,
    ),
    (("assault", "excessive force", "fight", "brawl", "fighting"), "altercation_event", "medium", 0.78),
    (("slip", "fell", "fall", "stairs"), "premises_liability", "medium", 0.81),
    (("serving", "liquor", "intoxicated", "cutoff", "dram"), "liquor_liability", "high", 0.91),
    (("crowd", "surge", "faint"), "crowd_management", "high", 0.87),
    (("vandal", "damage"), "property_damage", "low", 0.74),
]

_SEVERITY_ORDER = ("low", "medium", "high", "critical")


def _has_all(text: str, *needles: str) -> bool:
    return all(n in text for n in needles)


def _has_any(text: str, *needles: str) -> bool:
    return any(n in text for n in needles)


# Aggravating circumstances that, on their own, imply the worst exposure tier.
# Each predicate reads the *substance* of the summary, so a novel incident with
# the same signal escalates identically — this is the deterministic stand-in
# for the reasoning an LLM classifier would do natively.
def _is_critical_aggravator(text: str) -> str | None:
    if _has_any(text, "after legal cutoff", "after cutoff", "past cutoff", "after hours", "after-hours"):
        return "service past legal cutoff"
    if _has_any(text, "underage") or _has_any(
        text, "without an id scan", "without id scan", "no id scan", "missing id scan"
    ):
        return "underage / unverified-age service"
    if _has_all(text, "advertis", "security") and _has_any(
        text, "no security", "absent", "none present", "not present", "no staff"
    ):
        return "advertised security absent (negligent security)"
    if _has_any(text, "prior", "previous", "repeated", "history of") and _has_any(
        text, "assault", "fight", "incident", "similar"
    ):
        return "foreseeable repeat harm"
    if _has_all(text, "ems") and _has_any(text, "delayed", "delay") and _has_any(
        text, "respiratory", "allergic", "overdose", "unresponsive", "anaphyla",
        "cardiac", "seizure", "distress", "unconscious",
    ):
        return "delayed response to life-threatening medical event"
    return None


def _is_single_step_aggravator(text: str) -> str | None:
    if _has_any(
        text, "overcapacity", "over capacity", "capacity exceeded",
        "exceeding posted limit", "exceeded posted limit", "overcrowded",
    ):
        return "documented overcapacity"
    return None


def _is_mitigated(text: str) -> str | None:
    proactive = (_has_any(text, "security present", "proactive")) and _has_any(
        text, "water", "hydration", "within limits", "within stated", "under stated"
    )
    contained = _has_any(text, "extinguish", "contained", "within 30 seconds") and _has_any(
        text, "no evacuation", "no injur", "no one hurt", "nobody hurt", "no harm"
    )
    if proactive:
        return "proactive on-site controls"
    if contained:
        return "incident contained without harm"
    return None


def _apply_severity_modifiers(summary: str, base_severity: str) -> tuple[str, str | None]:
    """Adjust a coarse base severity for aggravating / mitigating circumstances.

    Returns (severity, note). Conservative by design: a critical aggravator
    always wins over a mitigator (insurance never relaxes a regulatory or
    foreseeable-harm exposure), and the function only moves severity when a
    specific signal is present — plain incidents pass through unchanged.
    """
    text = summary.lower()

    crit = _is_critical_aggravator(text)
    if crit:
        return "critical", f"aggravator: {crit}"

    mitig = _is_mitigated(text)
    if mitig:
        return "low", f"mitigator: {mitig}"

    bump = _is_single_step_aggravator(text)
    if bump:
        idx = _SEVERITY_ORDER.index(base_severity)
        stepped = _SEVERITY_ORDER[min(idx + 1, _SEVERITY_ORDER.index("high"))]
        if stepped != base_severity:
            return stepped, f"aggravator: {bump}"

    return base_severity, None


class DeterministicRiskClassifier(RiskClassifierProvider):
    """Keyword-ladder classifier. Used as fallback and in tests.

    Preserves the exact behavior the runtime had before the LLM provider was
    introduced, so swapping providers can't silently change scoring on the
    seeded scenarios.
    """

    @property
    def provider_name(self) -> str:
        return "deterministic-classifier-v1"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.DETERMINISTIC

    def classify(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        citation_excerpts: list[str],
    ) -> RiskClassification:
        summary = (incident_summary or "").lower()
        for keywords, risk_type, base_severity, confidence in _KEYWORD_LADDER:
            if any(k in summary for k in keywords):
                matched = next(k for k in keywords if k in summary)
                severity, mod_note = _apply_severity_modifiers(incident_summary or "", base_severity)
                rationale = f"Keyword match on {matched}"
                if mod_note:
                    rationale += f"; {mod_note} ({base_severity}->{severity})"
                return RiskClassification(
                    risk_type=risk_type,
                    base_severity=severity,
                    base_confidence=confidence,
                    rationale=rationale,
                    provider=self.provider_name,
                    mode=self.mode,
                )
        severity, mod_note = _apply_severity_modifiers(incident_summary or "", "low")
        rationale = "No keyword match — defaulting to general_incident."
        if mod_note:
            rationale += f" {mod_note} (low->{severity})"
        return RiskClassification(
            risk_type="general_incident",
            base_severity=severity,
            base_confidence=0.70,
            rationale=rationale,
            provider=self.provider_name,
            mode=self.mode,
        )


class DeterministicProvider(MemoProvider):
    """
    Template-based memo drafting with no external dependencies.

    Produces consistent, explainable output driven entirely by the structured
    packet findings. All output is traceable back to the rubric and citations.
    """

    @property
    def provider_name(self) -> str:
        return "deterministic-v1"

    @property
    def mode(self) -> ProviderMode:
        return ProviderMode.DETERMINISTIC

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
        risk_analysis = {
            "altercation_event": (
                "Physical altercation creates liquor-liability and negligent-security exposure. "
                "Key underwriting factors: security response time, staffing ratio at time of incident, "
                "and whether the venue can demonstrate Duty of Care compliance. "
                "This event requires underwriter review before coverage determination. "
                "If police were called, obtain the report number for the claims file."
            ),
            "premises_liability": (
                "Premises liability claim requires documented evidence of hazard conditions. "
                "Underwriter should verify: whether wet floor signage was posted, lighting standards "
                "were met, and whether the patron received a medical assessment. "
                "Slip-and-fall claims are highly litigation-prone without contemporaneous documentation."
            ),
            "liquor_liability": (
                "Liquor liability or dram shop exposure identified. "
                "Critical factor: whether staff can demonstrate the patron was served legally and "
                "showed no visible signs of impairment at point of service. "
                "POS logs and staff training records are the primary defense evidence."
            ),
            "medical_emergency": (
                "Medical emergency creates duty-of-care and potential negligence exposure. "
                "Underwriter must verify: EMS was called promptly, patron was not left unattended, "
                "and venue has an emergency response protocol on file. "
                "Delayed EMS notification significantly increases liability exposure."
            ),
            "crowd_management": (
                "Crowd management incident may indicate capacity control failure. "
                "Review door count records against permitted capacity at time of incident. "
                "If capacity was exceeded, this may void the relevant coverage section."
            ),
            "property_damage": (
                "Property damage incident. Assess whether third-party liability applies "
                "or whether this is a first-party property claim. "
                "Review fire suppression records and equipment inspection logs if applicable."
            ),
            "general_incident": (
                "Incident requires standard review. Confirm all witness statements have been "
                "collected and that the incident report was filed within the 24-hour policy window."
            ),
        }.get(risk_type.lower(), (
            "Incident requires underwriter review. Confirm evidence has been preserved "
            "and that the incident was reported within the required policy window."
        ))

        severity_action = {
            "low": "No immediate premium action recommended. File for record.",
            "medium": "Monitor for repeat incidents. Premium adjustment may apply at renewal.",
            "high": "Flag for renewal review. Consider requiring additional compliance documentation.",
            "critical": "Escalate to carrier. Legal hold on all related evidence recommended.",
        }.get(severity.lower(), "Standard review applies.")

        citation_note = (
            f"Supported by {len(citation_excerpts)} cited source(s) from the evidence registry."
            if citation_excerpts
            else "No corroborating sources retrieved — underwriter should request additional documentation."
        )

        summary = f"{risk_analysis} {severity_action} {citation_note}"

        questions_by_type = {
            "altercation_event": [
                "Was security response documented within 30 seconds of incident detection?",
                "Were all involved patrons identified and removed from the premises?",
                "Has rear-bar or relevant camera footage been secured and timestamped?",
            ],
            "premises_liability": [
                "Was wet floor or hazard signage posted at the time of the incident?",
                "Did the patron receive a medical assessment before leaving?",
                "Are lighting inspection records available for the area of the fall?",
            ],
            "liquor_liability": [
                "Can staff confirm the patron showed no visible impairment at last service?",
                "Are POS logs available showing exact time and items served?",
                "Has the bartender completed responsible service training this calendar year?",
            ],
            "medical_emergency": [
                "Was EMS called within 5 minutes of the patron becoming unresponsive?",
                "Was the patron left alone at any point before EMS arrival?",
                "Does the venue have a documented emergency response protocol?",
            ],
            "crowd_management": [
                "What was the door count at the time of the incident vs. permitted capacity?",
                "Were additional security staff deployed when crowd density elevated?",
                "Are guestlist and ticketing records available for cross-reference?",
            ],
        }

        default_questions = [
            "Was the incident reported within the 24-hour policy window?",
            "Has all relevant camera footage been preserved for at least 90 days?",
            "Were witness names and contact details collected before close of event?",
        ]

        return MemoOutput(
            summary=summary,
            open_questions=open_questions or questions_by_type.get(risk_type.lower(), default_questions),
            provider=self.provider_name,
            mode=self.mode,
        )
