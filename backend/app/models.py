from sqlmodel import SQLModel, Field, Relationship
from typing import Optional
from datetime import datetime
from sqlalchemy import Column, JSON

class Venue(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str

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


class AuditEvent(SQLModel, table=True):
    id: str = Field(primary_key=True)
    actor_id: str
    actor_type: str
    entity_type: str
    entity_id: str = Field(index=True)
    event_type: str
    event_metadata: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)
