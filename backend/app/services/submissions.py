"""Submissions service — the broker placement workflow.

A `Submission` is the broker's attempt to place coverage for one venue. Its
lifecycle progresses:

    open → in_market → quoting → bound | lost | withdrawn

Each carrier the submission is sent to gets its own `CarrierQuote` row with
its own status lifecycle (requested → pending → quoted → bound/declined/...).

Every public function in this module:
  - Enforces the lifecycle transition matrix from `app.lifecycles`. Direct
    column writes to `status` are an anti-pattern — always go through
    `_transition_submission` / `_transition_carrier_quote`.
  - Emits an `AuditEvent` for every state change using the existing
    `app.packet_core._add_audit_event` helper.
  - Uses keyword-only arguments (the `*,` convention) so callers can't
    accidentally pass `actor_id` in a positional slot.
  - Validates inputs at the boundary; downstream consumers can trust that
    a `CarrierQuote` returned from this module has well-formed JSON columns.

The premium-breakdown sum-check (`validate_premium_breakdown`) is the most
important pre-merge validator in this module — broker entering quote data
from a carrier's email PDF is the highest-typo-rate input surface in the
whole app, and the sanity check catches arithmetic mistakes at write time
rather than at the comparison view where the discrepancy is invisible.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional, Sequence
from uuid import uuid4

from sqlmodel import Session, select

from app.lifecycles import (
    QUOTE_TRANSITIONS,
    SUBMISSION_TERMINAL_STATES,
    SUBMISSION_TRANSITIONS,
    assert_valid_transition,
)
from app.models import Carrier, CarrierQuote, Submission, Venue
from app.money import json_to_usd
from app.packet_core import _add_audit_event
from app.seed_data import VENUES
from app.time import now_utc


# ─── Errors ──────────────────────────────────────────────────────────────

class SubmissionsError(Exception):
    """Base error for the submissions service."""


class OutOfAppetiteError(SubmissionsError):
    """Raised when submit_to_market is called against carriers whose
    appetite does not match the venue/coverage profile, and the caller
    did not pass allow_out_of_appetite=True."""


class PremiumBreakdownMismatchError(SubmissionsError):
    """Raised when record_carrier_response is given a premium_breakdown
    whose line premiums + fees + tax do not sum to the stated total
    within $1 tolerance."""


# ─── Helpers ─────────────────────────────────────────────────────────────

# Sum-tolerance for premium_breakdown validation. Carriers sometimes round
# their line premiums independently of the total, producing a few cents of
# drift. $1 is generous enough to absorb that without letting a real typo
# (off by $100, $1000) through.
PREMIUM_SUM_TOLERANCE: Decimal = Decimal("1.00")


def _venue_dict(venue_id: str, session: Session) -> dict:
    """Return the venue's full data dict. Prefers the in-memory VENUES seed
    (always current with the live `IncidentDeltaTracker`); falls back to
    the Venue row's `venue_data` JSON column when running outside the
    normal app lifecycle (e.g., scripts).

    Raises SubmissionsError if the venue can't be resolved."""
    if venue_id in VENUES:
        return VENUES[venue_id]
    db = session.get(Venue, venue_id)
    if db is not None and db.venue_data:
        import json as _json
        try:
            return _json.loads(db.venue_data)
        except Exception:
            pass
    raise SubmissionsError(f"Unknown venue {venue_id!r}")


def check_appetite(
    carrier: Carrier,
    venue: dict,
    coverage_lines: Sequence[str],
) -> tuple[bool, list[str]]:
    """Validate a venue + coverage profile against a carrier's appetite.

    Returns (matches, reasons). `reasons` is empty when matches is True;
    otherwise it contains one human-readable reason per failed dimension
    (venue_type, max_capacity, coverage_lines). The broker UI surfaces
    these so the underwriter understands WHY a carrier was filtered out
    or flagged."""
    reasons: list[str] = []
    appetite = carrier.appetite or {}

    allowed_types = appetite.get("venue_types", [])
    venue_type = venue.get("venue_type", "")
    if allowed_types and venue_type not in allowed_types:
        reasons.append(
            f"venue type {venue_type!r} not in {carrier.name}'s appetite "
            f"({', '.join(sorted(allowed_types))})"
        )

    max_cap = appetite.get("max_capacity")
    venue_cap = venue.get("capacity", 0)
    if isinstance(max_cap, int) and venue_cap > max_cap:
        reasons.append(
            f"venue capacity {venue_cap} exceeds {carrier.name}'s max of {max_cap}"
        )

    written_lines = set(appetite.get("coverage_lines", []))
    requested = set(coverage_lines)
    unsupported = requested - written_lines
    if written_lines and unsupported:
        reasons.append(
            f"{carrier.name} does not write {', '.join(sorted(unsupported))}"
        )

    return (len(reasons) == 0, reasons)


def validate_premium_breakdown(breakdown: dict) -> tuple[bool, str]:
    """Verify sum-of-parts == total within $1 tolerance.

    Expected shape (money as STRINGS per the plan's JSON contract):
      {
        "lines": {"gl": {..., "premium": "3850.00"}, "liquor": {..., "premium": "..."}},
        "fees": {"policy_fee": "150.00", "surplus_lines_tax": "144.84"},
        "subtotal": "5500.00",
        "total": "5894.84",
        ...
      }

    Returns (ok, reason). ok=True means the math checks out;
    ok=False means caller should NOT persist the breakdown — the broker
    will need to re-key the carrier's numbers."""
    lines = breakdown.get("lines") or {}
    fees = breakdown.get("fees") or {}
    total_field = breakdown.get("total")

    if total_field is None:
        return (False, "premium_breakdown is missing 'total'")
    if not lines:
        return (False, "premium_breakdown.lines is empty (need at least one line)")

    try:
        lines_sum = sum(
            (json_to_usd(line.get("premium", "0")) for line in lines.values()),
            Decimal("0.00"),
        )
        fees_sum = sum(
            (json_to_usd(v) for v in fees.values()),
            Decimal("0.00"),
        )
        stated_total = json_to_usd(total_field)
    except Exception as exc:
        return (False, f"could not parse money values: {exc}")

    computed_total = lines_sum + fees_sum
    drift = abs(stated_total - computed_total)
    if drift > PREMIUM_SUM_TOLERANCE:
        return (
            False,
            f"premium math drift: stated total {stated_total} vs "
            f"lines({lines_sum}) + fees({fees_sum}) = {computed_total} "
            f"(drift ${drift}, tolerance ${PREMIUM_SUM_TOLERANCE})",
        )
    return (True, "")


# ─── Lifecycle transition helpers ────────────────────────────────────────

def _transition_submission(
    session: Session,
    sub: Submission,
    *,
    to: str,
    actor_id: str,
    metadata: Optional[dict] = None,
) -> Submission:
    """Validate + apply a Submission lifecycle transition. Emits audit event."""
    from_status = sub.status
    assert_valid_transition(
        SUBMISSION_TRANSITIONS, from_status, to, entity_name="Submission"
    )
    sub.status = to
    sub.updated_at = now_utc()
    session.add(sub)
    _add_audit_event(
        session=session,
        actor_id=actor_id,
        actor_type="user",
        entity_type="submission",
        entity_id=sub.id,
        event_type=f"submission.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )
    return sub


def _transition_carrier_quote(
    session: Session,
    q: CarrierQuote,
    *,
    to: str,
    actor_id: str,
    metadata: Optional[dict] = None,
) -> CarrierQuote:
    """Validate + apply a CarrierQuote lifecycle transition. Emits audit event."""
    from_status = q.status
    assert_valid_transition(
        QUOTE_TRANSITIONS, from_status, to, entity_name="CarrierQuote"
    )
    q.status = to
    if to == "quoted" and q.responded_at is None:
        q.responded_at = now_utc()
    session.add(q)
    _add_audit_event(
        session=session,
        actor_id=actor_id,
        actor_type="user",
        entity_type="carrier_quote",
        entity_id=q.id,
        event_type=f"carrier_quote.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )
    return q


# ─── Public API ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SubmitToMarketResult:
    submission: Submission
    quotes_created: list[CarrierQuote]
    rejected_carriers: list[dict]   # [{carrier_id, reasons: [str, ...]}]


def create_submission(
    session: Session,
    *,
    venue_id: str,
    effective_date: date,
    coverage_lines: Sequence[str],
    requested_limits: dict,
    producer_id: Optional[str] = None,
    notes: str = "",
    actor_id: str = "system",
) -> Submission:
    """Open a new submission for a venue. status='open'. Emits audit event."""
    _ = _venue_dict(venue_id, session)  # raises if venue unknown

    sub = Submission(
        id=f"sub-{uuid4().hex[:12]}",
        venue_id=venue_id,
        assigned_producer_id=producer_id,
        status="open",
        effective_date=effective_date,
        coverage_lines=list(coverage_lines),
        requested_limits=dict(requested_limits),
        notes=notes,
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    session.add(sub)
    session.flush()
    _add_audit_event(
        session=session,
        actor_id=actor_id,
        actor_type="user",
        entity_type="submission",
        entity_id=sub.id,
        event_type="submission.created",
        event_metadata={
            "venue_id": venue_id,
            "coverage_lines": list(coverage_lines),
            "producer_id": producer_id,
        },
    )
    return sub


def update_submission(
    session: Session,
    submission_id: str,
    *,
    actor_id: str,
    effective_date: Optional[date] = None,
    coverage_lines: Optional[Sequence[str]] = None,
    requested_limits: Optional[dict] = None,
    producer_id: Optional[str] = None,
    notes: Optional[str] = None,
) -> Submission:
    """Edit a submission's terms while it's still a draft.

    Only allowed when status == 'open' — once it's gone to market the terms
    are locked (you'd withdraw + re-create instead), since carriers have
    already quoted against them. Only the fields passed (non-None) are
    changed. Emits a `submission.updated` audit event listing changed keys.
    """
    sub = session.get(Submission, submission_id)
    if sub is None:
        raise SubmissionsError(f"Unknown submission {submission_id!r}")
    if sub.status != "open":
        raise SubmissionsError(
            f"Submission {submission_id!r} is {sub.status!r}; only 'open' "
            "submissions can be edited (withdraw and re-create to change terms after going to market)"
        )

    changed: list[str] = []
    if effective_date is not None and effective_date != sub.effective_date:
        sub.effective_date = effective_date
        changed.append("effective_date")
    if coverage_lines is not None and list(coverage_lines) != sub.coverage_lines:
        sub.coverage_lines = list(coverage_lines)
        changed.append("coverage_lines")
    if requested_limits is not None and dict(requested_limits) != sub.requested_limits:
        sub.requested_limits = dict(requested_limits)
        changed.append("requested_limits")
    if producer_id is not None and producer_id != sub.assigned_producer_id:
        sub.assigned_producer_id = producer_id
        changed.append("assigned_producer_id")
    if notes is not None and notes != sub.notes:
        sub.notes = notes
        changed.append("notes")

    if changed:
        sub.updated_at = now_utc()
        session.add(sub)
        _add_audit_event(
            session=session,
            actor_id=actor_id,
            actor_type="user",
            entity_type="submission",
            entity_id=sub.id,
            event_type="submission.updated",
            event_metadata={"changed": changed},
        )
    return sub


def submit_to_market(
    session: Session,
    submission_id: str,
    *,
    target_carriers: Sequence[str],
    submitted_by: str,
    allow_out_of_appetite: bool = False,
) -> SubmitToMarketResult:
    """Send the submission to each target carrier.

    For each carrier, runs the appetite check. Carriers that match get a
    `CarrierQuote(status='requested')` row. Carriers that DON'T match are
    skipped and surfaced in `rejected_carriers` — unless
    `allow_out_of_appetite=True`, in which case they get quotes too (the
    rejection reasons still appear, just informationally).

    Transitions Submission: open → in_market. Emits one
    `submission.submitted` audit event for the submission and one
    `carrier_quote.requested` per quote created."""
    sub = session.get(Submission, submission_id)
    if sub is None:
        raise SubmissionsError(f"Unknown submission {submission_id!r}")

    venue = _venue_dict(sub.venue_id, session)
    quotes_created: list[CarrierQuote] = []
    rejected: list[dict] = []

    for carrier_id in target_carriers:
        carrier = session.get(Carrier, carrier_id)
        if carrier is None:
            rejected.append({"carrier_id": carrier_id, "reasons": [f"unknown carrier {carrier_id!r}"]})
            continue

        matches, reasons = check_appetite(carrier, venue, sub.coverage_lines)
        if not matches and not allow_out_of_appetite:
            rejected.append({"carrier_id": carrier_id, "reasons": reasons})
            continue

        q = CarrierQuote(
            id=f"q-{uuid4().hex[:12]}",
            submission_id=sub.id,
            carrier_id=carrier_id,
            status="requested",
            requested_at=now_utc(),
        )
        session.add(q)
        session.flush()
        _add_audit_event(
            session=session,
            actor_id=submitted_by,
            actor_type="user",
            entity_type="carrier_quote",
            entity_id=q.id,
            event_type="carrier_quote.requested",
            event_metadata={
                "submission_id": sub.id,
                "carrier_id": carrier_id,
                "out_of_appetite_reasons": reasons if reasons else None,
            },
        )
        quotes_created.append(q)

    if not quotes_created and not allow_out_of_appetite:
        # Every target carrier was out of appetite. Don't transition the
        # submission to in_market — there's no market to be in.
        raise OutOfAppetiteError(
            f"All {len(target_carriers)} target carrier(s) are out of appetite "
            f"for this venue/coverage profile. Pass allow_out_of_appetite=True "
            f"to submit anyway. Rejected: {rejected}"
        )

    _transition_submission(
        session,
        sub,
        to="in_market",
        actor_id=submitted_by,
        metadata={
            "carriers_targeted": list(target_carriers),
            "quotes_created": [q.id for q in quotes_created],
            "rejected_carriers": rejected,
        },
    )
    sub.submitted_at = now_utc()
    session.add(sub)

    return SubmitToMarketResult(
        submission=sub,
        quotes_created=quotes_created,
        rejected_carriers=rejected,
    )


def record_carrier_response(
    session: Session,
    quote_id: str,
    *,
    status: str,                                    # "quoted" | "declined" | "expired" | "withdrawn"
    premium_breakdown: Optional[dict] = None,
    coverage_terms: Optional[dict] = None,
    decline_reason: Optional[str] = None,
    expires_at=None,
    underwriter_name: Optional[str] = None,
    recorded_by: str,
) -> CarrierQuote:
    """Broker records a carrier's response to a quote request.

    For status='quoted', validates the premium_breakdown sum-check before
    persisting (raises PremiumBreakdownMismatchError otherwise — broker
    re-keys the numbers).

    For status='declined', requires decline_reason. The reason is stored
    on the quote and included in the audit event so the next renewal
    cycle can surface 'Markel declined last year because X — try Y instead.'

    If this is the FIRST quoted/declined response on the submission, also
    transitions Submission from 'in_market' to 'quoting'."""
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        raise SubmissionsError(f"Unknown CarrierQuote {quote_id!r}")

    if status == "quoted":
        if premium_breakdown is None:
            raise SubmissionsError("status='quoted' requires premium_breakdown")
        ok, reason = validate_premium_breakdown(premium_breakdown)
        if not ok:
            raise PremiumBreakdownMismatchError(reason)
        q.premium_breakdown = premium_breakdown
        if coverage_terms is not None:
            q.coverage_terms = coverage_terms
        if expires_at is not None:
            q.expires_at = expires_at

    elif status == "declined":
        if not decline_reason or not decline_reason.strip():
            raise SubmissionsError("status='declined' requires a non-empty decline_reason")
        q.decline_reason = decline_reason

    if underwriter_name is not None:
        q.underwriter_name = underwriter_name

    _transition_carrier_quote(
        session,
        q,
        to=status,
        actor_id=recorded_by,
        metadata={
            "decline_reason": decline_reason if status == "declined" else None,
        },
    )

    # If this is the first response on the parent submission, escalate
    # submission 'in_market' → 'quoting'. Subsequent responses leave the
    # submission status alone.
    sub = session.get(Submission, q.submission_id)
    if sub is not None and sub.status == "in_market":
        _transition_submission(
            session,
            sub,
            to="quoting",
            actor_id=recorded_by,
            metadata={"triggered_by_quote_id": q.id},
        )

    return q


def select_quote(
    session: Session,
    quote_id: str,
    *,
    selected_by: str,
) -> CarrierQuote:
    """Broker marks this quote as the recommended pick.

    Validates that the quote is in 'quoted' status (you can't recommend
    something that hasn't actually been quoted). Clears `is_selected` on
    every other quote for the same submission so exactly one quote is
    ever selected.

    Does NOT bind — binding is a separate (Phase 2) operation. Selecting
    is the broker saying 'this is what I'd recommend to the venue';
    binding is the venue accepting and the broker finalizing with the
    carrier."""
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        raise SubmissionsError(f"Unknown CarrierQuote {quote_id!r}")
    if q.status != "quoted":
        raise SubmissionsError(
            f"Cannot select quote {q.id!r}: status is {q.status!r}, expected 'quoted'"
        )

    # Clear any existing selection on the same submission.
    siblings = session.exec(
        select(CarrierQuote).where(
            CarrierQuote.submission_id == q.submission_id,
            CarrierQuote.is_selected == True,  # noqa: E712 — SQLAlchemy needs ==
        )
    ).all()
    for sib in siblings:
        if sib.id != q.id:
            sib.is_selected = False
            session.add(sib)

    q.is_selected = True
    session.add(q)
    _add_audit_event(
        session=session,
        actor_id=selected_by,
        actor_type="user",
        entity_type="carrier_quote",
        entity_id=q.id,
        event_type="carrier_quote.selected",
        event_metadata={
            "submission_id": q.submission_id,
            "carrier_id": q.carrier_id,
            "deselected_siblings": [s.id for s in siblings if s.id != q.id],
        },
    )
    return q


def withdraw_submission(
    session: Session,
    submission_id: str,
    *,
    reason: str,
    withdrawn_by: str,
) -> Submission:
    """Pull a submission out of market. Withdraws every non-terminal
    carrier quote attached to it (so they don't stay in 'requested'
    forever). The submission's terminal state is 'withdrawn'."""
    sub = session.get(Submission, submission_id)
    if sub is None:
        raise SubmissionsError(f"Unknown submission {submission_id!r}")
    if sub.status in SUBMISSION_TERMINAL_STATES:
        raise SubmissionsError(
            f"Submission {sub.id!r} already in terminal state {sub.status!r}"
        )

    # Withdraw every still-live quote first.
    live_quotes = session.exec(
        select(CarrierQuote).where(CarrierQuote.submission_id == sub.id)
    ).all()
    for q in live_quotes:
        if q.status in {"requested", "pending", "quoted"}:
            _transition_carrier_quote(
                session, q, to="withdrawn", actor_id=withdrawn_by,
                metadata={"reason": reason, "submission_withdrawn": True},
            )

    _transition_submission(
        session,
        sub,
        to="withdrawn",
        actor_id=withdrawn_by,
        metadata={"reason": reason},
    )
    return sub


def list_submissions(
    session: Session,
    *,
    status_in: Optional[Sequence[str]] = None,
    producer_id: Optional[str] = None,
    venue_id: Optional[str] = None,
    days_in_market_min: Optional[int] = None,
) -> list[Submission]:
    """List submissions matching the given filters.

    Default behavior (no filters): returns NON-TERMINAL submissions only —
    that's what the broker kanban shows. Callers wanting the full history
    pass `status_in=list(...)` explicitly."""
    stmt = select(Submission)

    if status_in is not None:
        stmt = stmt.where(Submission.status.in_(list(status_in)))  # type: ignore[attr-defined]
    else:
        # Default: hide terminal states from the kanban.
        terminal = list(SUBMISSION_TERMINAL_STATES)
        stmt = stmt.where(Submission.status.not_in(terminal))  # type: ignore[attr-defined]

    if producer_id is not None:
        stmt = stmt.where(Submission.assigned_producer_id == producer_id)
    if venue_id is not None:
        stmt = stmt.where(Submission.venue_id == venue_id)

    results = list(session.exec(stmt).all())

    if days_in_market_min is not None:
        from app.time import as_utc
        cutoff = now_utc()
        filtered: list[Submission] = []
        for sub in results:
            submitted = as_utc(sub.submitted_at)
            if submitted is None:
                continue
            age_days = (cutoff - submitted).days
            if age_days >= days_in_market_min:
                filtered.append(sub)
        results = filtered

    return results
