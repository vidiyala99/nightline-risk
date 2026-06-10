"""Shared AI-provenance primitive.

Every AI artifact (vision finding, underwriting memo, fraud signal, copilot
reply) should record *what produced it* — provider, model, prompt/contract
version, and a fingerprint of its inputs. This is the sibling of
`decision_source`: it turns "we have evals" into "every AI output carries its
lineage" (the NAIC model-governance story) and gives the correction flywheel a
stable key to attach a human override to.

Design notes:
- It rides inside the JSON dicts artifacts already persist (`EvidenceAnalysis.
  findings`, `UnderwritingPacket.fraud_signal`, memo payloads) and the
  free-form `AuditEvent.event_metadata` — so stamping needs **no migration**.
- The input hash follows the house snapshot-hash discipline (canonical JSON,
  **list order doesn't matter**), so a Postgres JSON re-order can't change a
  fingerprint (the exact rationale behind `Policy.snapshot_hash` sorting lists).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from pydantic import BaseModel


class AIProvenance(BaseModel):
    """What produced an AI artifact. Embedded in the artifact + its audit event."""

    provider: str        # "gemini" | "anthropic" | "groq" | "deterministic"
    model: str           # "gemini-2.5-flash" | "template-v1" | "fraud-scorer-v1" ...
    prompt_version: str   # the agent's prompt/contract version (bump on change)
    input_hash: str       # 16-hex SHA-256 of the canonical inputs
    fallback_reason: Optional[str] = None  # set when a primary LLM path degraded


def _canonicalize(obj: Any) -> Any:
    """Recursively normalize so the fingerprint is order-insensitive.

    Dict keys are sorted by `json.dumps(sort_keys=True)` downstream; list
    contents are sorted by their canonical string form here, so a re-ordered
    list (e.g. a Postgres JSON round-trip) hashes identically.
    """
    if isinstance(obj, dict):
        return {k: _canonicalize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        items = [_canonicalize(v) for v in obj]
        return sorted(items, key=lambda x: json.dumps(x, sort_keys=True, default=str))
    return obj


def canonical_input_hash(inputs: Any) -> str:
    """16-hex SHA-256 of the canonical (order-insensitive) JSON of `inputs`."""
    canonical = json.dumps(
        _canonicalize(inputs), sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def make_provenance(
    *,
    provider: str,
    model: str,
    prompt_version: str,
    inputs: Any,
    fallback_reason: str | None = None,
) -> AIProvenance:
    """Build an `AIProvenance` stamp, computing `input_hash` from `inputs`."""
    return AIProvenance(
        provider=provider,
        model=model,
        prompt_version=prompt_version,
        input_hash=canonical_input_hash(inputs),
        fallback_reason=fallback_reason,
    )
