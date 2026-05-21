"""Pydantic shapes for Endorsement.terms_diff.

Each endorsement_type carries a different payload structure. Rather than
leaving Endorsement.terms_diff as free-form JSON (which forces every
consumer to hand-parse), we define one Pydantic model per type and a
discriminated union that picks the right shape automatically.

The service layer (`app.services.policies.issue_endorsement`) validates
the incoming payload against the union before persisting to the JSON
column. Downstream consumers can rely on the stored dict matching the
declared shape for its `endorsement_type`.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


# ─── Per-type payloads ──────────────────────────────────────────────────


class ChangeLimitDiff(BaseModel):
    """Adjust a per-line limit (per-occurrence or aggregate) or deductible."""
    endorsement_type: Literal["change_limit"] = "change_limit"
    coverage_line: str                                 # "gl" | "liquor" | ...
    field: Literal["per_occurrence", "aggregate", "deductible"]
    before: Decimal
    after: Decimal


class AddInsuredDiff(BaseModel):
    """Add an additional-insured party (landlord, event client, contractor)."""
    endorsement_type: Literal["add_insured"] = "add_insured"
    insured_name: str
    insured_address: str
    relationship: str          # "landlord" | "event_client" | "contract_counterparty"
    scope: Literal["ongoing_operations", "completed_operations", "single_event"]
    # Maps to ISO endorsement forms CG 20 10 / CG 20 26 / CG 20 37.


class AddCoverageDiff(BaseModel):
    """Add a new coverage line mid-term (e.g., EPLI added after hire-spike)."""
    endorsement_type: Literal["add_coverage"] = "add_coverage"
    coverage_line: str
    per_occurrence_limit: Decimal
    aggregate_limit: Decimal | None = None
    deductible: Decimal = Decimal("0.00")


class RemoveCoverageDiff(BaseModel):
    """Drop a coverage line mid-term. Returns pro-rated refund."""
    endorsement_type: Literal["remove_coverage"] = "remove_coverage"
    coverage_line: str
    reason: str


class AddLocationDiff(BaseModel):
    """Insured opens a new venue location during the policy term."""
    endorsement_type: Literal["add_location"] = "add_location"
    location_name: str
    location_address: str
    venue_type: str
    capacity: int | None = None


class ChangeClassDiff(BaseModel):
    """Operational class change (e.g., venue starts hosting live music)."""
    endorsement_type: Literal["change_class"] = "change_class"
    coverage_line: str
    before_class: str
    after_class: str
    reason: str


class CancellationDiff(BaseModel):
    """Used when an endorsement records the cancellation reason on the
    audit trail (the cancellation itself is a separate Policy state
    transition; this captures the *why*)."""
    endorsement_type: Literal["cancellation"] = "cancellation"
    method: Literal["pro_rata", "short_rate"]
    cancellation_date: str                              # ISO date
    reason: str


class CorrectionDiff(BaseModel):
    """Admin correction — typo in name, address, etc. No premium impact
    by definition."""
    endorsement_type: Literal["correction"] = "correction"
    field_corrected: str
    before: str
    after: str
    explanation: str


# ─── Discriminated union ────────────────────────────────────────────────

EndorsementDiff = Annotated[
    Union[
        ChangeLimitDiff,
        AddInsuredDiff,
        AddCoverageDiff,
        RemoveCoverageDiff,
        AddLocationDiff,
        ChangeClassDiff,
        CancellationDiff,
        CorrectionDiff,
    ],
    Field(discriminator="endorsement_type"),
]


# ─── Helpers ─────────────────────────────────────────────────────────────

class EndorsementValidationError(ValueError):
    """Raised when a payload doesn't match the declared endorsement_type."""


def validate_endorsement_diff(endorsement_type: str, payload: dict) -> dict:
    """Validate `payload` against the Pydantic shape for `endorsement_type`.

    Returns the JSON-ready dict (with Decimals serialized as strings)
    suitable for the Endorsement.terms_diff JSON column. Raises
    EndorsementValidationError if the payload is malformed.

    Callers should always go through this — direct writes to terms_diff
    skip the type discipline and silently corrupt the column shape."""
    if "endorsement_type" not in payload:
        payload = {**payload, "endorsement_type": endorsement_type}
    elif payload["endorsement_type"] != endorsement_type:
        raise EndorsementValidationError(
            f"endorsement_type mismatch: argument={endorsement_type!r}, "
            f"payload={payload['endorsement_type']!r}"
        )

    try:
        # Find the right model class by discriminator
        model_cls = _MODEL_BY_TYPE.get(endorsement_type)
        if model_cls is None:
            raise EndorsementValidationError(
                f"unknown endorsement_type {endorsement_type!r}. "
                f"Known types: {sorted(_MODEL_BY_TYPE.keys())}"
            )
        validated = model_cls.model_validate(payload)
    except EndorsementValidationError:
        raise
    except Exception as exc:
        raise EndorsementValidationError(
            f"payload validation failed for {endorsement_type!r}: {exc}"
        )

    # mode='json' serializes Decimal as string (json-safe).
    return validated.model_dump(mode="json")


_MODEL_BY_TYPE: dict[str, type[BaseModel]] = {
    "change_limit": ChangeLimitDiff,
    "add_insured": AddInsuredDiff,
    "add_coverage": AddCoverageDiff,
    "remove_coverage": RemoveCoverageDiff,
    "add_location": AddLocationDiff,
    "change_class": ChangeClassDiff,
    "cancellation": CancellationDiff,
    "correction": CorrectionDiff,
}
