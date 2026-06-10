from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional
from uuid import UUID, uuid4
from pydantic import BaseModel, Field

from app.time import now_utc

class SourceType(str, Enum):
    POS = "pos"
    CAMERA = "camera"
    STAFFING = "staffing"
    IOT = "iot"

class BaseEvent(BaseModel):
    """The universal header for every signal entering the Nightline Risk Engine."""
    event_id: UUID = Field(default_factory=uuid4, description="Unique identifier for the event")
    venue_id: str = Field(..., description="The unique ID of the venue (e.g., elsewhere-brooklyn)")
    source_type: SourceType = Field(..., description="The type of data source")
    timestamp: datetime = Field(default_factory=now_utc, description="When the event occurred at the source")
    received_at: datetime = Field(default_factory=now_utc, description="When the event hit our ingestion API")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary source metadata (firmware, sensor IDs, etc.)")

class RiskLevel(str, Enum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"
