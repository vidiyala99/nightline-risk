from sqlmodel import SQLModel, Field, Relationship
from typing import Optional
from datetime import datetime
from decimal import Decimal
from sqlalchemy import Column, JSON, Numeric

from app.time import now_utc

class UserRecord(SQLModel, table=True):
    id: str = Field(primary_key=True)
    email: str = Field(index=True)
    password_hash: str
    name: str
    role: str
    tenant_id: Optional[str] = Field(default=None)
    extra_venue_ids: Optional[str] = Field(default=None)  # JSON-encoded list of extra venue IDs


class Venue(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    venue_data: Optional[str] = Field(default=None)  # JSON-encoded full venue dict

class IncidentRecord(SQLModel, table=True):
    id: str = Field(primary_key=True)
    venue_id: str = Field(foreign_key="venue.id")
    occurred_at: str
    location: str
    summary: str
    reported_by: str
    injury_observed: bool
    police_called: bool
    ems_called: bool
    status: str = Field(default="open")
    created_at: datetime = Field(default_factory=datetime.utcnow)

    evaluation: Optional["IncidentEvaluation"] = Relationship(back_populates="incident")

class IncidentEvaluation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    incident_id: str = Field(foreign_key="incidentrecord.id", unique=True)
    
    # Store complex AI-generated structures as JSON for flexibility in the MVP
    risk_signal: dict = Field(default_factory=dict, sa_column=Column(JSON))
    action_plan: list = Field(default_factory=list, sa_column=Column(JSON))
    underwriting_memo: dict = Field(default_factory=dict, sa_column=Column(JSON))
    claims_timeline: list = Field(default_factory=list, sa_column=Column(JSON))

    incident: IncidentRecord = Relationship(back_populates="evaluation")


class WorkflowExecution(SQLModel, table=True):
    id: str = Field(primary_key=True)
    workflow_name: str
    status: str
    context: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class WorkflowTask(SQLModel, table=True):
    id: str = Field(primary_key=True)
    execution_id: str = Field(foreign_key="workflowexecution.id")
    task_index: int
    task_name: str
    status: str
    output: dict = Field(default_factory=dict, sa_column=Column(JSON))
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class SourceRecord(SQLModel, table=True):
    id: str = Field(primary_key=True)
    venue_id: str = Field(index=True)
    incident_id: Optional[str] = Field(default=None, index=True)
    source_type: str
    origin_system: Optional[str] = None
    external_ref: Optional[str] = None
    excerpt: str
    content_hash: Optional[str] = None
    source_metadata: dict = Field(default_factory=dict, sa_column=Column(JSON))
    retention_policy: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class PolicyDocument(SQLModel, table=True):
    """Full hierarchical tree of a broker-uploaded policy doc.

    Leaves of this tree are also flattened into SourceRecord rows (one per
    leaf) for the retrieval layer; tree_json here is the canonical source for
    PageIndex deep-retrieve and for citation rendering.
    """
    id: str = Field(primary_key=True)
    venue_id: str = Field(index=True)
    source_file: str
    content_type: str = "text/markdown"
    page_count: int = 0
    tree_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="ready", index=True)  # indexing | ready | failed
    indexed_at: datetime = Field(default_factory=datetime.utcnow)
    error: Optional[str] = None


class RubricVersion(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    version: str
    rules: dict = Field(default_factory=dict, sa_column=Column(JSON))
    prohibited_fields: list = Field(default_factory=list, sa_column=Column(JSON))
    created_by: str = "system"
    effective_at: datetime = Field(default_factory=datetime.utcnow)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UnderwritingPacket(SQLModel, table=True):
    id: str = Field(primary_key=True)
    venue_id: str = Field(index=True)
    incident_id: str = Field(index=True)
    rubric_version_id: str = Field(foreign_key="rubricversion.id")
    status: str
    risk_signals: dict = Field(default_factory=dict, sa_column=Column(JSON))
    action_plan: list = Field(default_factory=list, sa_column=Column(JSON))
    claims_timeline: list = Field(default_factory=list, sa_column=Column(JSON))
    memo: dict = Field(default_factory=dict, sa_column=Column(JSON))
    citation_ids: list = Field(default_factory=list, sa_column=Column(JSON))
    validation: dict = Field(default_factory=dict, sa_column=Column(JSON))
    snapshot_hash: str
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class CitationRecord(SQLModel, table=True):
    id: str = Field(primary_key=True)
    packet_id: str = Field(foreign_key="underwritingpacket.id", index=True)
    source_id: str = Field(foreign_key="sourcerecord.id", index=True)
    claim_id: str
    citation_type: str
    field_path: Optional[str] = None
    excerpt: str
    validation_status: str
    validated_at: datetime = Field(default_factory=datetime.utcnow)


class ReviewDecision(SQLModel, table=True):
    id: str = Field(primary_key=True)
    packet_id: str = Field(foreign_key="underwritingpacket.id", index=True)
    reviewer_id: str
    decision: str
    override_reason: Optional[str] = None
    notes: Optional[str] = None
    decided_at: datetime = Field(default_factory=datetime.utcnow)


class ClaimProposal(SQLModel, table=True):
    """An operator's proposal to file a claim against an underwriting packet.

    Mirrors the audit shape of ReviewDecision (the broker side) but tracks the
    operator's upstream judgment about the recommender's verdict — including
    the override path when the operator disagrees with a "don't file" rec.

    State machine:
        pending_broker_review → approved → filed_with_carrier → paid | denied
                              → rejected_by_broker

    `filed_with_carrier` and below are reserved for the carrier-integration
    phase; the demo terminates at approved/rejected_by_broker.
    """
    id: str = Field(primary_key=True)
    packet_id: str = Field(foreign_key="underwritingpacket.id", index=True)
    venue_id: str = Field(index=True)
    proposed_by: str
    proposed_at: datetime = Field(default_factory=datetime.utcnow)
    override_recommendation: bool = False
    override_reason: Optional[str] = None
    override_freetext: Optional[str] = None
    state: str = Field(default="pending_broker_review", index=True)
    broker_decided_by: Optional[str] = None
    broker_decided_at: Optional[datetime] = None
    broker_notes: Optional[str] = None


class EvidenceAnalysis(SQLModel, table=True):
    id: str = Field(primary_key=True)
    evidence_id: str = Field(foreign_key="evidencefile.id", index=True)
    incident_id: str = Field(index=True)
    analysis_type: str  # image | video | audio
    findings: dict = Field(default_factory=dict, sa_column=Column(JSON))
    corroboration: str = "pending"  # pending | CONSISTENT | PARTIAL | CONTRADICTED | INCONCLUSIVE
    confidence_delta: float = 0.0
    raw_description: str = ""
    status: str = "processing"  # processing | complete | failed
    analyzed_at: Optional[datetime] = None


class EvidenceFile(SQLModel, table=True):
    id: str = Field(primary_key=True)
    incident_id: str = Field(foreign_key="incidentrecord.id", index=True)
    filename: str
    content_type: str
    file_path: str
    file_size: int = 0
    uploaded_by: str = "operator"
    uploaded_at: datetime = Field(default_factory=datetime.utcnow)


class ComplianceEvidence(SQLModel, table=True):
    """Files an operator uploads to resolve a compliance item.

    Compliance items themselves live in the in-memory LiveStateManager, so we
    don't FK on item_id — it's a string identifier we record alongside the file.
    Once compliance is persisted (a separate refactor), this can become a real FK.
    """
    id: str = Field(primary_key=True)
    venue_id: str = Field(index=True)
    compliance_item_id: str = Field(index=True)
    filename: str
    content_type: str
    file_path: str
    file_size: int = 0
    uploaded_by: str = "operator"
    uploaded_at: datetime = Field(default_factory=datetime.utcnow)
    # Citation linkage — the policy clause this evidence is being submitted
    # against. Stamped at upload time by retrieving against the compliance
    # item's description. All optional: pre-PageIndex evidence has none.
    cited_source_id: Optional[str] = Field(default=None, foreign_key="sourcerecord.id")
    cited_doc_id: Optional[str] = None
    cited_node_id: Optional[str] = None
    cited_page_start: Optional[int] = None
    cited_page_end: Optional[int] = None


class AuditEvent(SQLModel, table=True):
    id: str = Field(primary_key=True)
    actor_id: str
    actor_type: str
    entity_type: str
    entity_id: str = Field(index=True)
    event_type: str
    event_metadata: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CameraFeed(SQLModel, table=True):
    id: str = Field(primary_key=True)
    venue_id: str = Field(foreign_key="venue.id", index=True)
    zone: str  # entrance | bar | dance_floor | exit | other
    rtsp_url: str  # store as-is for MVP; encrypt at rest in production
    enabled: bool = Field(default=True)
    sample_interval_seconds: int = Field(default=8)  # how often to sample a frame
    created_at: datetime = Field(default_factory=datetime.utcnow)


class AlertEvent(SQLModel, table=True):
    id: str = Field(primary_key=True)
    venue_id: str = Field(foreign_key="venue.id", index=True)
    camera_id: str = Field(foreign_key="camerafeed.id", index=True)
    zone: str
    event_type: str   # altercation | crowd_crush | person_down | weapon | other
    severity: str     # critical | high | medium | low
    confidence: float
    frame_count: int = Field(default=1)  # consecutive frames that triggered this
    alerted: bool = Field(default=False)  # whether a push notification was sent
    feedback: Optional[str] = Field(default=None)  # false_alarm | confirmed | None
    description: str = Field(default="")
    detected_at: datetime = Field(default_factory=datetime.utcnow)


class PushSubscription(SQLModel, table=True):
    id: str = Field(primary_key=True)
    user_id: str = Field(foreign_key="userrecord.id", index=True)
    endpoint: str
    p256dh: str   # public key
    auth: str     # auth secret
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ─── Broker Platform — Phase 1 (Placement) ────────────────────────────────
# The broker-platform tables build on the existing claim/incident schema.
# All money is Decimal stored as Numeric(12,2). Money inside JSON columns
# is stored via app.money.usd_to_json / json_to_usd as strings — JSON's
# native float type silently corrupts cent precision. Timestamps use
# app.time.now_utc (not datetime.utcnow, which is deprecated). See the
# broker-platform build plan for the architectural context.


class Carrier(SQLModel, table=True):
    """An insurance company that writes paper. Surplus lines tax is NOT on
    this table — it's a per-state rate (NY = 3.76%), constant for all E&S
    carriers writing in that state. See app/underwriting/pricing.py for
    the NY_SURPLUS_LINES_TAX constant; promote to a StateTaxRule table
    when the brokerage expands beyond NY."""
    id: str = Field(primary_key=True)              # e.g. "markel-specialty"
    name: str                                       # "Markel Specialty"
    market_type: str = Field(index=True)            # "admitted" | "e&s"
    naic_code: Optional[str] = None                 # NAIC carrier registry id
    appetite: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # appetite shape:
    # {"venue_types": ["dive_bar","music_venue"],
    #  "max_capacity": 1500,
    #  "coverage_lines": ["gl","liquor","epli","property"]}
    am_best_rating: Optional[str] = None            # "A" | "A-" | "B++" etc.
    contact_email: Optional[str] = None
    submission_portal_url: Optional[str] = None
    created_at: datetime = Field(default_factory=now_utc)


class CoverageLine(SQLModel, table=True):
    """A standardized coverage product. GL = General Liability, etc.

    Limits are TWO numbers, not one: per-occurrence (max payout for a single
    claim) and aggregate (max total across the policy term). Some lines
    (property) only have per-occurrence; aggregate is then NULL."""
    id: str = Field(primary_key=True)               # "gl" | "liquor" | "epli" ...
    name: str                                        # "General Liability"
    iso_code: Optional[str] = None                   # carrier rating classification
    description: str
    is_required_by_default: bool = False             # GL + WC are usually required
    default_per_occurrence_limit: Decimal = Field(
        sa_column=Column(Numeric(12, 2), nullable=False)
    )
    default_aggregate_limit: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(12, 2), nullable=True)
    )
    default_deductible: Decimal = Field(
        default=Decimal("0.00"), sa_column=Column(Numeric(12, 2), nullable=False)
    )
