# backend/app/ingestion/comms/types.py
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

CommsKind = Literal["incident", "compliance", "noise"]


@dataclass
class CommsItem:
    """One raw message/ticket/text pulled from a source (pre-classification)."""
    source: str            # "slack" | "tickets" | "sms"
    venue_id: str
    external_id: str       # stable id from the source — the dedupe key
    text: str
    occurred_at: datetime
    author: str | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class CommsClassification:
    kind: CommsKind
    confidence: float
    fields: dict = field(default_factory=dict)
    rationale: str = ""
    model_version: str = "comms-clf-v1"
