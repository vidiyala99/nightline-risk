"""CoverageAdviceRecord service — persist + lifecycle the broker E&O advice trail.

A coverage finding (gap / exclusion) is ephemeral; when the broker acts on it we
freeze a `CoverageAdviceRecord` carrying the cited clause node_ids. The
acknowledge→action transition is the defensible "I advised, on this clause, at
this time" documentation that protects the broker against a failure-to-inform
E&O claim.

Conventions (broker-platform):
  - typed lifecycle in app.lifecycles (CoverageAdviceStatus / TRANSITIONS),
  - every state change goes through `_transition_coverage_advice`, which calls
    `assert_valid_transition` and emits an audit event,
  - typed `CoverageAdviceError` for validation; `InvalidTransitionError` for
    illegal lifecycle moves (router maps these to 400/404 and 422),
  - the router owns commit/rollback — this layer only adds/flushes.
"""
from __future__ import annotations

import hashlib
from typing import Optional

from sqlmodel import Session

from app.lifecycles import COVERAGE_ADVICE_TRANSITIONS, assert_valid_transition
from app.models import CoverageAdviceRecord, Policy
from app.packet_core import _add_audit_event
from app.time import now_utc


class CoverageAdviceError(Exception):
    """Validation / not-found error for the coverage-advice service."""


# Mirrors the finding kinds that produce advice (coverage_gap_eo → "gap",
# coverage_exclusion_review → "exclusion_review", claim-time → "exclusion_bite").
VALID_KINDS: frozenset[str] = frozenset(
    {"gap", "exclusion_review", "exclusion_bite", "renewal_drift"}
)


def _advice_id(venue_id: str, policy_id: str, kind: str, node_ids: list[str]) -> str:
    # Sort node_ids before hashing — list-order drift on Postgres must not mint
    # a duplicate advice row (snapshot-hash convention, CLAUDE.md).
    basis = f"{venue_id}|{policy_id}|{kind}|{'|'.join(sorted(node_ids))}"
    return f"covadvice-{hashlib.sha256(basis.encode('utf-8')).hexdigest()[:16]}"


def _transition_coverage_advice(
    session: Session,
    rec: CoverageAdviceRecord,
    *,
    to: str,
    actor_id: str,
    metadata: Optional[dict] = None,
) -> CoverageAdviceRecord:
    from_status = rec.status
    assert_valid_transition(
        COVERAGE_ADVICE_TRANSITIONS, from_status, to, entity_name="CoverageAdviceRecord"
    )
    rec.status = to
    rec.actor_id = actor_id
    rec.updated_at = now_utc()
    session.add(rec)
    _add_audit_event(
        session=session,
        actor_id=actor_id, actor_type="user",
        entity_type="coverage_advice", entity_id=rec.id,
        event_type=f"coverage_advice.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )
    return rec


def record_coverage_advice(
    session: Session,
    *,
    venue_id: str,
    policy_id: str,
    kind: str,
    summary: str,
    cited_node_ids: list[str],
    loss_category: Optional[str] = None,
    actor_id: Optional[str] = None,
) -> CoverageAdviceRecord:
    """Freeze a coverage advice item in 'surfaced'. Idempotent on
    (venue, policy, kind, sorted node_ids) — re-recording returns the existing
    row rather than duplicating."""
    if kind not in VALID_KINDS:
        raise CoverageAdviceError(
            f"Invalid kind {kind!r}. Must be one of: {sorted(VALID_KINDS)}"
        )
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise CoverageAdviceError(f"Policy {policy_id!r} not found")

    node_ids = sorted(cited_node_ids or [])
    advice_id = _advice_id(venue_id, policy_id, kind, node_ids)
    existing = session.get(CoverageAdviceRecord, advice_id)
    if existing is not None:
        return existing

    rec = CoverageAdviceRecord(
        id=advice_id,
        venue_id=venue_id,
        policy_id=policy_id,
        kind=kind,
        loss_category=loss_category,
        cited_node_ids=node_ids,
        summary=summary,
        status="surfaced",
        actor_id=actor_id,
    )
    session.add(rec)
    session.flush()
    return rec


def transition_coverage_advice(
    session: Session,
    *,
    advice_id: str,
    to: str,
    actor_id: str,
    note: Optional[str] = None,
) -> CoverageAdviceRecord:
    rec = session.get(CoverageAdviceRecord, advice_id)
    if rec is None:
        raise CoverageAdviceError(f"Coverage advice {advice_id!r} not found")
    metadata = {"note": note} if note else None
    return _transition_coverage_advice(
        session, rec, to=to, actor_id=actor_id, metadata=metadata
    )
