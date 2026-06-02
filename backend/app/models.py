from sqlmodel import SQLModel, Field, Relationship
from typing import Optional
from datetime import date, datetime
from decimal import Decimal
from sqlalchemy import Column, ForeignKey, JSON, Numeric

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
    # Onboarding "knowns" — structured source of truth, overlaid onto venue_data
    # at hydration (see app/api/v1/venues.py:_resolve_venue). Dates/JSON stored as
    # TEXT per the project's migration convention.
    current_carrier: Optional[str] = Field(default=None)    # carrier name OR "uninsured"/"unsure"
    renewal_date: Optional[str] = Field(default=None)       # ISO date string
    coverage_interest: Optional[str] = Field(default=None)  # JSON-encoded list of CoverageLine ids
    onboarding_complete: bool = Field(default=False)

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
    # A&B / liquor structured facts (all optional; legacy incidents leave them null).
    incident_category: Optional[str] = Field(default=None)
    parties: list = Field(default_factory=list, sa_column=Column(JSON))
    witnesses: list = Field(default_factory=list, sa_column=Column(JSON))
    security_response: list = Field(default_factory=list, sa_column=Column(JSON))
    weapon_involved: Optional[bool] = Field(default=None)
    refused_service_or_overserved: Optional[str] = Field(default=None)
    injury_detail: Optional[str] = Field(default=None)
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


class ComplianceSignal(SQLModel, table=True):
    """Persisted compliance item — the system of record the operator queue and
    the compliance risk factor both read. Replaces the transient in-memory
    ComplianceItem queue. Mirrors IncidentRecord."""
    id: str = Field(primary_key=True)
    venue_id: str = Field(index=True, foreign_key="venue.id")
    title: str
    description: str
    provenance: str  # auto_generated|operator_reported|underwriter_verified|ingested
    severity: str    # low|medium|high|urgent
    status: str = Field(default="open")  # open|resolved
    created_at: datetime = Field(default_factory=now_utc)
    resolved_at: Optional[datetime] = Field(default=None)
    evidence_ref: Optional[str] = Field(default=None)


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
    # Structured corroboration verdict (set on the v2 packet after vision runs;
    # previously only prose in memo.summary).
    corroboration_status: Optional[str] = Field(default=None)
    corroboration_flags: list = Field(default_factory=list, sa_column=Column(JSON))


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


class OpenQuestionResponse(SQLModel, table=True):
    """Operator's answer to an AI underwriting-memo open question, plus the
    broker's resolve flag. One row per (packet_id, question_index): answering or
    resolving the same question upserts. Closes the loop the read-only memo never
    had — operator answers → broker sees → broker resolves."""
    id: str = Field(primary_key=True)
    packet_id: str = Field(foreign_key="underwritingpacket.id", index=True)
    question_index: int
    question_text: str
    answer: str = ""
    answered_by: Optional[str] = None
    answered_at: Optional[datetime] = None
    resolved: bool = False
    resolved_by: Optional[str] = None
    resolved_at: Optional[datetime] = None


class ClaimProposal(SQLModel, table=True):
    """An operator's proposal to file a claim against an underwriting packet.

    Mirrors the audit shape of ReviewDecision (the broker side) but tracks the
    operator's upstream judgment about the recommender's verdict — including
    the override path when the operator disagrees with a "don't file" rec.

    State machine:
        pending_broker_review → approved → filed_with_carrier → paid | denied
                              → rejected_by_broker
                              → needs_more_info → pending_broker_review

    `needs_more_info` is a non-terminal round-trip: the broker bounces the
    proposal back to the operator for more evidence; the operator responds,
    which re-queues it at `pending_broker_review`. The broker cannot approve
    or reject while it sits in `needs_more_info` (it's parked on the operator).

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
    # Request-more-info round-trip (broker asks → operator responds). All
    # nullable/additive; only populated when the broker requests more info.
    info_requested_by: Optional[str] = None
    info_requested_at: Optional[datetime] = None
    info_request_note: Optional[str] = None
    operator_response_note: Optional[str] = None
    operator_responded_at: Optional[datetime] = None
    # Snapshot of the ClaimRecommendation that drove routing, captured at
    # proposal creation so the broker inbox shows the exact number that
    # triggered routing (auditable; not recomputed). Nullable/additive — relies
    # on the per-engine schema self-healing, no manual migration.
    recommendation_snapshot: Optional[dict] = Field(
        default=None, sa_column=Column(JSON)
    )


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
    content_hash: Optional[str] = Field(default=None)   # SHA-256 of file bytes, at upload
    captured_at: Optional[str] = Field(default=None)     # client-supplied capture time, else upload time


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


from datetime import date  # noqa: E402  (importing here keeps section-local)


class Submission(SQLModel, table=True):
    """A broker's attempt to place coverage for one venue. The lifecycle
    is enforced by app.lifecycles.SUBMISSION_TRANSITIONS — direct status
    column writes are an anti-pattern; use `transition_submission()`
    in services/submissions.py."""
    id: str = Field(primary_key=True)               # "sub-<uuid12>"
    venue_id: str = Field(foreign_key="venue.id", index=True)
    assigned_producer_id: Optional[str] = Field(
        default=None, foreign_key="userrecord.id", index=True
    )
    status: str = Field(default="open", index=True)
    # See app.lifecycles.SubmissionStatus for the closed enum and
    # SUBMISSION_TRANSITIONS for the allowed transitions.
    effective_date: date                             # desired policy start
    coverage_lines: list = Field(default_factory=list, sa_column=Column(JSON))
    # ["gl","liquor","epli"] etc — references CoverageLine.id
    requested_limits: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Shape per line — money fields stored as STRINGS via app.money.usd_to_json:
    # {"gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "5000"}}
    prior_policy_id: Optional[str] = Field(default=None)
    # FK to policy.id once that table exists; populated on renewals so the
    # YoY context view can show prior-year terms.
    notes: str = ""
    submitted_at: Optional[datetime] = None          # when it went in_market
    bound_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class CarrierQuote(SQLModel, table=True):
    """One carrier's offer (or decline) for one Submission. A Submission can
    have many quotes; exactly one becomes 'bound' if the submission binds."""
    id: str = Field(primary_key=True)               # "q-<uuid12>"
    submission_id: str = Field(foreign_key="submission.id", index=True)
    carrier_id: str = Field(foreign_key="carrier.id", index=True)
    status: str = Field(default="requested", index=True)
    # See app.lifecycles.QuoteStatus + QUOTE_TRANSITIONS.

    # is_selected marks the broker's recommended pick — separate from
    # status='bound' which is the post-bind terminal state. A submission
    # in 'quoting' state can have one is_selected=True quote even before
    # the bind operation runs.
    is_selected: bool = False

    requested_at: datetime = Field(default_factory=now_utc)
    responded_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    decline_reason: Optional[str] = None             # populated when status=declined

    premium_breakdown: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # All money in this JSON column stored as STRINGS via app.money.usd_to_json.
    # Shape:
    # {"lines": {"gl": {"base":"5500.00","tier_multiplier":"0.7","premium":"3850.00"},
    #            "liquor": {...}},
    #  "fees": {"policy_fee":"150.00","surplus_lines_tax":"144.84"},
    #  "subtotal": "5500.00", "total": "5894.84",
    #  "commission_rate": "0.15", "commission_amount": "884.23"}
    coverage_terms: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Per-line limits, deductibles, sublimits, exclusions:
    # {"gl": {"per_occurrence":"1000000","aggregate":"2000000","deductible":"2500",
    #         "exclusions": ["AssaultAndBattery"]}, ...}

    inputs_snapshot: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Frozen copy of the risk_score, loss_run id, and venue features at
    # quote time. Required so Phase 7's `derive_premium_explanation` can
    # REPRODUCE the quote's math months later even when the underlying
    # risk score has since changed.

    underwriter_name: Optional[str] = None           # the human at the carrier
    info_request_note: Optional[str] = None
    info_response_note: Optional[str] = None
    info_requested_by: Optional[str] = None
    info_requested_at: Optional[str] = None   # ISO string, not datetime — the migration adds a TEXT column
    quote_pdf_path: Optional[str] = None             # uploaded carrier quote (blob storage)


# ─── Broker Platform — Phase 2 (Policy lifecycle) ────────────────────────


class Policy(SQLModel, table=True):
    """A bound contract. Created by bind_quote() on a selected CarrierQuote.

    Lifecycle (see app.lifecycles.PolicyStatus):
      bound_pending_number → active → {cancelled, non_renewed, lapsed, expired}
      lapsed → active (carrier reinstates after late premium payment)

    Snapshot semantics: terms_snapshot is the FROZEN copy of premium +
    coverage terms at bind time. It's re-hashed only when an Endorsement
    issues; status changes (cancel, expire) leave the hash alone so
    archived defense packages keep their referent."""
    id: str = Field(primary_key=True)                 # "pol-<uuid12>"
    # Carriers issue policy numbers AFTER bind (sometimes days later).
    # Optional so a Policy can exist as 'bound_pending_number' before
    # the number arrives.
    policy_number: Optional[str] = Field(default=None, index=True)
    submission_id: str = Field(foreign_key="submission.id", index=True)
    bound_quote_id: str = Field(foreign_key="carrierquote.id")
    venue_id: str = Field(foreign_key="venue.id", index=True)
    carrier_id: str = Field(foreign_key="carrier.id")
    status: str = Field(default="bound_pending_number", index=True)

    effective_date: date
    expiration_date: date

    annual_premium: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    commission_amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    commission_rate: Decimal = Field(sa_column=Column(Numeric(6, 4), nullable=False))
    commission_paid_at: Optional[datetime] = None

    coverage_lines: list = Field(default_factory=list, sa_column=Column(JSON))
    terms_snapshot: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Frozen snapshot of CarrierQuote.coverage_terms + premium_breakdown
    # at bind time. Re-hashed only on endorsement.

    snapshot_hash: str = Field(default="")            # default empty; computed before commit

    cancelled_at: Optional[datetime] = None
    cancellation_reason: Optional[str] = None
    cancellation_method: Optional[str] = None         # "pro_rata" | "short_rate"
    refund_amount: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(12, 2), nullable=True)
    )

    bound_at: datetime = Field(default_factory=now_utc)


class Endorsement(SQLModel, table=True):
    """A mid-term policy change. Each change_type has a corresponding
    Pydantic schema in app.schemas.policy that validates terms_diff
    before persistence — see app.services.policies.issue_endorsement."""
    id: str = Field(primary_key=True)                 # "end-<uuid12>"
    policy_id: str = Field(foreign_key="policy.id", index=True)
    endorsement_type: str
    # add_location | change_limit | add_insured | remove_coverage |
    # add_coverage | change_class | cancellation | correction
    effective_date: date
    description: str
    premium_change: Decimal = Field(
        default=Decimal("0.00"),
        sa_column=Column(Numeric(12, 2), nullable=False),
    )
    tax_change: Decimal = Field(
        default=Decimal("0.00"),
        sa_column=Column(Numeric(12, 2), nullable=False),
    )
    # Pre-validated discriminated-union payload — see app.schemas.policy.
    terms_diff: dict = Field(default_factory=dict, sa_column=Column(JSON))
    issued_at: datetime = Field(default_factory=now_utc)
    created_by: str = Field(foreign_key="userrecord.id")


class CertificateOfInsurance(SQLModel, table=True):
    """The doc venues send to landlords / event clients to prove coverage.
    Lifecycle: active → superseded | cancelled. New COIs to the same
    holder mark the prior one 'superseded' (audit-preserving)."""
    id: str = Field(primary_key=True)                 # "coi-<uuid12>"
    policy_id: str = Field(foreign_key="policy.id", index=True)
    certificate_holder: str                            # the landlord / event client name
    certificate_holder_address: str
    additional_insured: bool = False
    additional_insured_scope: Optional[str] = None
    # null when additional_insured=False; otherwise:
    # "ongoing_operations" | "completed_operations" | "single_event"
    # — invokes different ISO endorsement forms (CG 20 10 / 20 26 / 20 37).
    description_of_operations: str
    status: str = Field(default="active", index=True)
    # active | superseded | cancelled
    issued_at: datetime = Field(default_factory=now_utc)
    expires_on: date
    pdf_path: Optional[str] = None                     # blob-storage URL
    issued_by: str = Field(foreign_key="userrecord.id")


# ─── Broker Platform — Phase 3 (Claims integration) ──────────────────────


class Claim(SQLModel, table=True):
    """A carrier-side claim. Distinct from ClaimProposal (internal
    recommendation) — a Claim is what's been reported TO the carrier.

    Lifecycle (see app.lifecycles.ClaimStatus): claim states are never
    truly terminal — closed_paid / closed_denied / closed_dropped can
    transition to 'reopened' for subrogation or late-discovered info.

    Running totals (current_reserve, indemnity/expense/recoveries paid_to_date)
    are denormalized for query speed; ClaimPayment + ReserveChange rows
    are the actuarial source of truth.

    snapshot_hash anchors a tamper-evident view of the claim's financial
    state; re-hashed on every mutation of money or status."""
    id: str = Field(primary_key=True)                  # "clm-<uuid12>"
    policy_id: str = Field(foreign_key="policy.id", index=True)
    incident_id: Optional[str] = Field(default=None, foreign_key="incidentrecord.id")
    proposal_id: Optional[str] = Field(default=None, foreign_key="claimproposal.id")
    carrier_claim_number: Optional[str] = None
    coverage_line: str
    status: str = Field(default="notified", index=True)

    date_of_loss: date
    fnol_submitted_at: datetime = Field(default_factory=now_utc)

    current_reserve: Decimal = Field(
        default=Decimal("0.00"),
        sa_column=Column(Numeric(12, 2), nullable=False),
    )
    indemnity_paid_to_date: Decimal = Field(
        default=Decimal("0.00"),
        sa_column=Column(Numeric(12, 2), nullable=False),
    )
    expense_paid_to_date: Decimal = Field(
        default=Decimal("0.00"),
        sa_column=Column(Numeric(12, 2), nullable=False),
    )
    recoveries_to_date: Decimal = Field(
        default=Decimal("0.00"),
        sa_column=Column(Numeric(12, 2), nullable=False),
    )

    final_indemnity: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(12, 2), nullable=True)
    )
    total_incurred: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(12, 2), nullable=True)
    )

    closed_at: Optional[datetime] = None
    reopened_at: Optional[datetime] = None
    reopen_count: int = 0
    adjuster_name: Optional[str] = None
    adjuster_email: Optional[str] = None

    coverage_decision: Optional[str] = None      # null | "covered" | "denied" | "reservation_of_rights"
    coverage_rationale: Optional[str] = None
    coverage_decided_by: Optional[str] = None
    coverage_decided_at: Optional[str] = None     # ISO string (TEXT column — not datetime; avoids Postgres TEXT/datetime mismatch)

    # ON DELETE RESTRICT: packets referenced by claims cannot be deleted,
    # or the claim's frozen defense story loses its referent.
    defense_package_id: Optional[str] = Field(
        default=None,
        sa_column=Column(ForeignKey("underwritingpacket.id", ondelete="RESTRICT")),
    )
    snapshot_hash: str = Field(default="")


class ClaimPayment(SQLModel, table=True):
    """Individual payment event on a claim. Claim.indemnity_paid_to_date
    et al. are derived sums of these rows."""
    id: str = Field(primary_key=True)                  # "cpay-<uuid12>"
    claim_id: str = Field(foreign_key="claim.id", index=True)
    payment_type: str                                   # "indemnity" | "expense" | "recovery"
    amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    paid_on: date
    description: str = ""
    recorded_by: str = Field(foreign_key="userrecord.id")
    recorded_at: datetime = Field(default_factory=now_utc)


class ReserveChange(SQLModel, table=True):
    """Audit row for every reserve adjustment communicated by the carrier.
    Actuaries care about the trajectory, not just the current value."""
    id: str = Field(primary_key=True)                  # "rchg-<uuid12>"
    claim_id: str = Field(foreign_key="claim.id", index=True)
    from_amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    to_amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    change_reason: str
    received_from: str                                  # adjuster name / carrier letter ref
    received_at: datetime
    recorded_by: str = Field(foreign_key="userrecord.id")
    recorded_at: datetime = Field(default_factory=now_utc)


class PolicyRequest(SQLModel, table=True):
    """Operator→broker service request against an in-force policy.

    The operator can't transact policy lifecycle themselves (bind/cancel/
    renew/COI are all broker-gated). This is the structured way for them to
    *ask*: the operator raises a request, it lands in the broker's queue,
    and the broker approves or declines it — mirroring the ClaimProposal
    propose→decide pattern (see app.lifecycles.PolicyRequestStatus).

    `payload` carries type-specific detail as JSON (e.g. the desired
    cancellation date, the COI holder + operations description, the
    coverage change requested) — kept flexible so new request types don't
    need a schema migration. Money values inside payload follow the JSON
    contract: stored as strings, parsed only at render time."""
    id: str = Field(primary_key=True)                   # "preq-<uuid12>"
    policy_id: str = Field(foreign_key="policy.id", index=True)
    venue_id: str = Field(index=True)                   # denormalized from the policy for tenant filtering
    request_type: str                                   # "renewal" | "cancellation" | "coi" | "coverage_change"
    status: str = Field(default="pending", index=True)
    requested_by: str                                   # operator user id (token sub)
    note: str = ""
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))

    decided_by: Optional[str] = None                    # broker user id
    decision_note: Optional[str] = None
    decided_at: Optional[datetime] = None

    # What an *approval* actually created, so the UI can deep-link from the
    # decided request to its result. Populated only on approval that executes
    # an underlying action: "submission" (renewal), "certificate" (coi),
    # "policy" (cancellation). Null for coverage_change (decision-only) and
    # for declined/cancelled requests.
    result_entity_type: Optional[str] = None
    result_entity_id: Optional[str] = None

    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class BrokerTask(SQLModel, table=True):
    """Persisted overlay on the broker to-do feed (see app/api/v1/tasks.py).

    The feed itself is computed each request from renewals + pending
    PolicyRequests. This row layers per-item broker intent on top —
    dismiss / snooze / done — keyed by the feed item's stable id (`task_key`).
    A `manual` task is broker-authored and owns its own key (task_key == id).
    Lifecycle: see app.lifecycles.BrokerTaskStatus / BROKER_TASK_TRANSITIONS."""
    id: str = Field(primary_key=True)                   # "btask-<uuid12>"
    task_key: str = Field(index=True)                   # feed item id, or == id for manual tasks
    kind: str                                            # renewal | request | manual
    status: str = Field(default="open", index=True)
    ref_id: Optional[str] = None                        # underlying policy/request id (overlays)
    venue_id: Optional[str] = Field(default=None, index=True)
    title: str = ""
    note: str = ""
    due_date: Optional[date] = None
    snoozed_until: Optional[date] = None                 # set when status == "snoozed"
    created_by: str = ""                                 # broker user id (token sub)

    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class VenueOperationalEvent(SQLModel, table=True):
    """A single normalized operational signal ingested for a venue.

    The atomic unit of the ingestion spine: every connector (POS, ID scanner,
    staffing, …) transforms its raw feed into rows of this shape. `value` is a
    plain float because these are operational metrics (rates/ratios/counts),
    not money. `content_hash` is the dedupe key — a re-run that re-extracts the
    same logical event produces the same hash and is skipped, so ingestion is
    idempotent. `external_ref` ties a row back to its source record for audit.
    """
    id: str = Field(primary_key=True)                   # "voe-<uuid12>"
    venue_id: str = Field(index=True)
    source_system: str = Field(index=True)              # pos | id_scanner | staffing | nyc_open_data
    event_type: str
    metric_name: str                                    # e.g. over_pour_rate, id_rejection_rate
    value: float
    occurred_at: datetime                               # when the event happened at the source
    ingested_at: datetime = Field(default_factory=now_utc)
    content_hash: str = Field(index=True)               # SHA-256 of canonical event identity; dedupe key
    external_ref: Optional[str] = None                  # source-system record id, when available
    event_metadata: dict = Field(default_factory=dict, sa_column=Column(JSON))


class IngestionRun(SQLModel, table=True):
    """One execution of a connector — both the incremental cursor and the log.

    `watermark` records the max `occurred_at` seen for the source so the next
    run only pulls newer events (incremental). The counters + status + error
    make this the observability surface (`GET /api/ingestion/runs` in PR2).
    """
    id: str = Field(primary_key=True)                   # "ingest-<uuid12>"
    source_system: str = Field(index=True)
    status: str = Field(default="running")              # running | success | error
    started_at: datetime = Field(default_factory=now_utc)
    finished_at: Optional[datetime] = None
    extracted: int = Field(default=0)
    loaded: int = Field(default=0)
    skipped: int = Field(default=0)                     # deduped (already ingested)
    rejected: int = Field(default=0)                    # failed the data-quality filter
    rejected_reasons: Optional[str] = None              # JSON {reason_code: count}, explains `rejected`
    watermark: Optional[datetime] = None                # max occurred_at after this run
    error: Optional[str] = None
