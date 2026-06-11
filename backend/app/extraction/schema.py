"""Typed loss-run extraction primitives — pure, no I/O."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal


@dataclass
class RawTable:
    """Format-agnostic handoff from a reader to the parser."""
    header: list[str]
    rows: list[list[str]]


@dataclass
class ExtractedLossRunRow:
    """One canonical loss row. `field_confidence` maps canonical field -> 0..1;
    `raw_values` retains the original cell text per mapped field (audit)."""
    date_of_loss: date | None = None
    coverage_line: str | None = None
    claim_status: str | None = None
    claimant: str | None = None
    description: str | None = None
    carrier_claim_number: str | None = None
    reserve: Decimal | None = None
    paid: Decimal | None = None
    incurred: Decimal | None = None
    field_confidence: dict = field(default_factory=dict)
    raw_values: dict = field(default_factory=dict)
