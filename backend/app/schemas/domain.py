from pydantic import BaseModel, Field
from typing import List, Optional

class IncidentCreate(BaseModel):
    occurred_at: str
    location: str
    summary: str
    reported_by: str
    injury_observed: bool
    police_called: bool
    ems_called: bool
    # A&B / liquor structured facts — all optional so existing intake is unaffected.
    incident_category: Optional[str] = None
    parties: List[dict] = Field(default_factory=list)
    witnesses: List[dict] = Field(default_factory=list)
    security_response: List[dict] = Field(default_factory=list)
    weapon_involved: Optional[bool] = None
    refused_service_or_overserved: Optional[str] = None
    injury_detail: Optional[str] = None

class Citation(BaseModel):
    source_id: str
    source_type: str
    excerpt: str
    # PageIndex-derived locators. All optional so existing callers stay green;
    # populated when the underlying SourceRecord was ingested with a tree-build
    # (see app.policy_document.build_policy_tree).
    doc_id: Optional[str] = None
    node_id: Optional[str] = None
    page_start: Optional[int] = None
    page_end: Optional[int] = None
    path: Optional[str] = None  # breadcrumb e.g. "Coverage > 4.2 Premises Liability"
    clause_id: Optional[str] = None

class Incident(BaseModel):
    id: str
    venue_id: str
    occurred_at: str
    location: str
    summary: str
    reported_by: str
    injury_observed: bool
    police_called: bool
    ems_called: bool
    status: str = "open"  # open | under_review | closed
    # A&B / liquor structured category (e.g. "assault_battery", "slip_and_fall").
    # Optional so legacy incidents stay valid; drives the detail-page H1 label.
    incident_category: Optional[str] = None
    # Set when a floor-staff user filed this incident in-app — drives the
    # "staff-reported" attribution badge. None for operator/broker-filed ones.
    reported_by_staff_id: Optional[str] = None

class RiskSignal(BaseModel):
    type: str
    severity: str
    confidence: float = Field(ge=0, le=1)
    explanation: str
    review_status: str
    citations: List[Citation]

class ActionItem(BaseModel):
    title: str
    rationale: str
    evidence_needed: List[str]

class TimelineEvent(BaseModel):
    at: str
    label: str
    source: str

class ClaimsTimelineMeta(BaseModel):
    """Summary of the reconstructed timeline — answers the questions the
    underwriter would otherwise have to compute manually:
      - what's missing (gaps)
      - how trustworthy the chronology is (defensibility_notes)
      - can this be auto-finalized or does a human need to look (review_status)
    """
    gaps: List[str] = []
    defensibility_notes: List[str] = []
    review_status: str = "needs_review"  # complete | needs_review | blocked

class UnderwritingMemo(BaseModel):
    summary: str
    open_questions: List[str]
    review_status: str
    citations: List[Citation]
    provider: Optional[str] = None  # e.g. "gemini/gemini-2.5-flash" or "deterministic/template-v1"
    model: Optional[str] = None
    fallback_reason: Optional[str] = None  # populated when LLM call failed and we fell back

class UnderwritingRecommendation(BaseModel):
    """Carrier submission-underwriting decision support (distinct from the
    incident-layer UnderwritingMemo). Advisory: the carrier always confirms."""
    posture: str          # "quote" | "quote_with_conditions" | "decline"
    summary: str
    rationale: str
    subjectivities: List[str] = []
    rate_adequacy: str    # "adequate" | "lean_debit" | "lean_credit"
    rate_adequacy_note: str
    confidence: float
    grounding: dict = {}
    provider: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None          # "deterministic" | "llm"
    fallback_reason: Optional[str] = None
    # Unified AI lineage {provider, model, prompt_version, input_hash} — sibling of
    # fraud_signal/vision provenance; rides inside the persisted JSON (no migration).
    provenance: Optional[dict] = None

class InfrastructureItem(BaseModel):
    name: str
    status: str
    detail: str
    is_degraded: bool

class ComplianceItem(BaseModel):
    id: str
    title: str
    description: str
    severity: str

class LiveVenueState(BaseModel):
    venue_id: str
    current_capacity: int
    max_capacity: int
    premium_impact: float
    infrastructure: List[InfrastructureItem]
    compliance_queue: List[ComplianceItem]

class IncidentFlowResponse(BaseModel):
    incident: Incident
    risk_signal: RiskSignal
    action_plan: List[ActionItem]
    claims_timeline: List[TimelineEvent]
    claims_timeline_meta: Optional[ClaimsTimelineMeta] = None
    underwriting_memo: UnderwritingMemo

class StreamEvent(BaseModel):
    event_id: str
    event_type: str
    timestamp: str
    payload: dict
