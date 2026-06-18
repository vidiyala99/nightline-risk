"""Carrier claims adjudication — the adjuster's seat. Thin layer over the
existing claim services. The carrier OWNS these decisions (carrier_desk); the
broker's relay path (broker_relay) is untouched."""
from __future__ import annotations

from sqlmodel import Session

from app.models import Claim, Policy
from app.packet_core import _add_audit_event
from decimal import Decimal

from app.services.claims import (
    ClaimsError,
    _compute_claim_snapshot_hash,
    _transition_claim,
    close_claim,
    record_carrier_reserve,
    record_payment,
)
from app.time import now_utc

_COVERAGE_DECISIONS = {"covered", "denied", "reservation_of_rights"}


def decide_coverage(
    session: Session,
    claim_id: str,
    *,
    decision: str,
    rationale: str,
    adjuster_id: str,
) -> Claim:
    """The adjuster's 'do we owe?' determination.

    covered / reservation_of_rights  — advance the claim to under_investigation
                                       (implicit notified→acknowledged→under_investigation
                                       if needed) and stamp the decision fields.
    denied                            — same implicit transitions; stamps the denial
                                       and leaves the claim open. Closing is a
                                       separate explicit action (close_claim_as_carrier).

    Carrier-owned action (decision_source='carrier_desk').
    """
    if decision not in _COVERAGE_DECISIONS:
        raise ClaimsError(
            f"coverage decision {decision!r} invalid; must be one of "
            f"{sorted(_COVERAGE_DECISIONS)}"
        )
    rationale = (rationale or "").strip()
    if not rationale:
        raise ClaimsError("a coverage rationale is required")

    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if claim.status in {"closed_paid", "closed_denied", "closed_dropped"}:
        raise ClaimsError(
            f"Claim {claim_id!r} is {claim.status!r}; reopen before deciding coverage"
        )

    # Implicitly walk notified → acknowledged → under_investigation.
    if claim.status == "notified":
        _transition_claim(
            session, claim, to="acknowledged", actor_id=adjuster_id,
            metadata={"implicit": "adjuster_opened", "decision_source": "carrier_desk"},
        )
    if claim.status == "acknowledged":
        _transition_claim(
            session, claim, to="under_investigation", actor_id=adjuster_id,
            metadata={"implicit": "coverage_review", "decision_source": "carrier_desk"},
        )

    # Stamp decision fields.
    claim.coverage_decision = decision
    claim.coverage_rationale = rationale
    claim.coverage_decided_by = adjuster_id
    claim.coverage_decided_at = now_utc().isoformat()
    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session,
        actor_id=adjuster_id,
        actor_type="user",
        entity_type="claim",
        entity_id=claim.id,
        event_type="claim.coverage_decided",
        event_metadata={
            "coverage_decision": decision,
            "rationale": rationale,
            "decision_source": "carrier_desk",
        },
    )

    return claim


# ─── Task 4 additions ────────────────────────────────────────────────────

_COVERAGE_OK = {"covered", "reservation_of_rights"}


def adjust_reserve(session: Session, claim_id: str, *, new_reserve, change_reason: str, adjuster_id: str):
    """Carrier sets/adjusts the reserve (carrier_desk)."""
    return record_carrier_reserve(
        session, claim_id, new_reserve=new_reserve, change_reason=change_reason,
        received_from=adjuster_id, received_at=now_utc(), recorded_by=adjuster_id,
        decision_source="carrier_desk",
    )


def approve_payment(session: Session, claim_id: str, *, amount, payment_type: str, paid_on, description: str, adjuster_id: str):
    """Carrier approves a payment (carrier_desk). Indemnity requires coverage
    affirmed (covered / reservation_of_rights); expense + recovery allowed regardless."""
    if payment_type == "indemnity":
        claim = session.get(Claim, claim_id)
        if claim is None:
            raise ClaimsError(f"Unknown Claim {claim_id!r}")
        if claim.coverage_decision not in _COVERAGE_OK:
            raise ClaimsError(
                "cannot approve an indemnity payment before coverage is affirmed (covered / reservation of rights)"
            )
    return record_payment(
        session, claim_id, amount=amount, payment_type=payment_type, paid_on=paid_on,
        description=description, recorded_by=adjuster_id, decision_source="carrier_desk",
    )


def close_claim_as_carrier(session: Session, claim_id: str, *, disposition: str, final_indemnity=None, adjuster_id: str):
    """Carrier closes a claim (carrier_desk)."""
    return close_claim(
        session, claim_id, disposition=disposition, final_indemnity=final_indemnity,
        closed_by=adjuster_id, decision_source="carrier_desk",
    )


def reserve_hint(session, claim) -> dict | None:
    """Advisory reserve range + severity band from the venue's prior losses for
    this coverage line + the linked incident's severity. Deterministic,
    failure-isolated (None on no history / any error). NEVER auto-sets."""
    try:
        from app.services.loss_run import venue_loss_run
        from app.models import IncidentRecord
        policy = session.get(Policy, claim.policy_id)
        if policy is None:
            return None
        lr = venue_loss_run(session, policy.venue_id)
        line = next(
            (r for r in lr.get("by_coverage_line", []) if r["coverage_line"] == claim.coverage_line),
            None,
        )
        if not line or int(line.get("claim_count", 0)) <= 0:
            return None
        mean = Decimal(line["incurred"]) / Decimal(max(int(line["claim_count"]), 1))
        low = (mean * Decimal("0.6")).quantize(Decimal("1"))
        high = (mean * Decimal("1.6")).quantize(Decimal("1"))

        band, signals = "moderate", []
        inc = session.get(IncidentRecord, claim.incident_id) if claim.incident_id else None
        if inc is not None:
            if getattr(inc, "weapon_involved", None):
                band = "severe"
                signals.append("weapon involved")
            elif getattr(inc, "injury_observed", False):
                band = "elevated"
                signals.append("injury observed")
            if getattr(inc, "police_called", False):
                signals.append("police called")
        basis = f"{line['claim_count']} prior {claim.coverage_line} loss(es)"
        if signals:
            basis += "; " + ", ".join(signals)
        hint: dict = {"low": str(low), "high": str(high), "severity_band": band, "basis": basis}

        # Advisory chain-ladder mean — supersedes simple mean when credible (≥10 claims).
        # Accounts for IBNR / development tail. Never auto-sets reserve.
        try:
            from app.services.loss_development_data import build_development_cells_for_venue
            from app.underwriting.loss_development import compute_chain_ladder
            _cells_by_line, _ = build_development_cells_for_venue(session, policy.venue_id)
            _line_cells = _cells_by_line.get(claim.coverage_line, [])
            if _line_cells:
                _cl = compute_chain_ladder(
                    _line_cells, claim_count=int(line.get("claim_count", 0))
                )
                if _cl.is_credible and _cl.ultimate_total > Decimal("0"):
                    _cl_mean = (_cl.ultimate_total / max(_cl.claim_count, 1)).quantize(Decimal("1"))
                    hint["chain_ladder_mean"] = str(_cl_mean)
        except Exception:  # noqa: BLE001
            pass

        return hint
    except Exception:  # noqa: BLE001 — advisory only, never block the desk
        return None


def adjuster_queue(session: Session) -> list[dict]:
    """Open (non-closed) claims awaiting carrier adjudication, enriched."""
    from app.services.claims import list_claims
    from app.seed_data import VENUES
    from app.models import Venue
    rows: list[dict] = []
    for c in list_claims(session, open_only=True):
        policy = session.get(Policy, c.policy_id)
        venue_id = policy.venue_id if policy else None
        venue_name = None
        if venue_id:
            # Resolve DB-first to match the detail route: a venue that exists
            # in the Venue table but not in the VENUES seed dict shows its real
            # name, not its raw id. Fall back to the seed dict, then the id.
            db_venue = session.get(Venue, venue_id)
            if db_venue is not None and db_venue.name:
                venue_name = db_venue.name
            else:
                venue_name = VENUES.get(venue_id, {}).get("name", venue_id)
        total_paid = (c.indemnity_paid_to_date + c.expense_paid_to_date - c.recoveries_to_date)
        rows.append({
            "claim_id": c.id, "carrier_claim_number": c.carrier_claim_number,
            "venue_id": venue_id, "venue_name": venue_name, "coverage_line": c.coverage_line,
            "status": c.status, "coverage_decision": c.coverage_decision,
            "current_reserve": str(c.current_reserve),
            "total_paid": str(total_paid.quantize(Decimal("0.01"))),
        })
    rows.sort(key=lambda r: r["claim_id"])
    return rows
