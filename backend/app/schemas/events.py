from typing import List, Optional
from pydantic import BaseModel, Field
from .base import BaseEvent, SourceType

# --- POS SCHEMAS ---

class POSItem(BaseModel):
    sku: str
    name: str
    quantity: int
    price_total: float
    category: str  # e.g., "alcohol", "water", "food"

class POSEventPayload(BaseModel):
    order_id: str
    total_amount: float
    currency: str = "USD"
    items: List[POSItem]
    payment_method: str
    staff_id: Optional[str] = None

class POSEvent(BaseEvent):
    source_type: SourceType = SourceType.POS
    payload: POSEventPayload

# --- CAMERA SCHEMAS ---

class Detection(BaseModel):
    label: str  # e.g., "person", "security-uniform", "bottle"
    confidence: float
    box: List[float]  # [x1, y1, x2, y2]

class CameraEventPayload(BaseModel):
    zone_id: str  # e.g., "dance-floor", "rear-bar"
    person_count: int
    detections: List[Detection]
    aggression_score: float = Field(0.0, ge=0.0, le=1.0)
    anomaly_detected: bool = False

class CameraEvent(BaseEvent):
    source_type: SourceType = SourceType.CAMERA
    payload: CameraEventPayload

# --- STAFFING SCHEMAS ---

class StaffingEventPayload(BaseModel):
    staff_id: str
    name: str
    role: str  # e.g., "security", "bartender", "manager"
    action: str  # e.g., "clock-in", "clock-out", "location-update"
    location_zone: Optional[str] = None

class StaffingEvent(BaseEvent):
    source_type: SourceType = SourceType.STAFFING
    payload: StaffingEventPayload
