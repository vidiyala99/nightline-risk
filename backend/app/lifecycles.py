"""Lifecycle state types + transition matrices for the broker-platform tables.

The plan's Cross-Cutting Decision #5 calls for explicit typed lifecycle states
instead of raw strings — typo `'in market'` (space) vs `'in_market'` (underscore)
never survives a transition through these tables.

Each entity (Submission, CarrierQuote, Policy, Claim) has:
  - A Literal[...] type alias enumerating valid states.
  - A TRANSITIONS table mapping every state to the set of states it can
    transition TO. Terminal states map to set().
  - An `InvalidTransitionError` raised when an illegal transition is requested.

The transition matrix is also exposed via API (GET /api/submissions/transitions
etc.) so the frontend kanban can disable invalid drop targets client-side.
"""
from __future__ import annotations

from typing import Literal


# ─── Submission lifecycle ────────────────────────────────────────────────

SubmissionStatus = Literal[
    "open",          # broker has accepted the venue but hasn't submitted yet
    "in_market",     # submitted to ≥1 carrier, waiting for quote
    "quoting",       # received ≥1 quote, comparing
    "bound",         # quote accepted, Policy created — terminal
    "lost",          # venue went elsewhere — terminal
    "declined",      # all carriers declined — terminal
    "withdrawn",     # broker pulled it — terminal
]

SUBMISSION_TRANSITIONS: dict[str, set[str]] = {
    "open":      {"in_market", "withdrawn"},
    "in_market": {"quoting", "declined", "withdrawn"},
    "quoting":   {"bound", "lost", "withdrawn"},
    "bound":     set(),
    "lost":      set(),
    "declined":  set(),
    "withdrawn": set(),
}

SUBMISSION_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in SUBMISSION_TRANSITIONS.items() if not nexts
)


# ─── CarrierQuote lifecycle ──────────────────────────────────────────────

QuoteStatus = Literal[
    "requested",     # submitted to carrier, no response yet
    "pending",       # carrier reviewing
    "quoted",        # received with price + terms
    "declined",      # carrier said no — terminal
    "expired",       # quote validity passed — terminal
    "bound",         # this is the one we picked — terminal
    "withdrawn",     # broker withdrew — terminal
]

QUOTE_TRANSITIONS: dict[str, set[str]] = {
    "requested": {"pending", "quoted", "declined", "expired", "withdrawn"},
    "pending":   {"quoted", "declined", "expired", "withdrawn"},
    "quoted":    {"bound", "expired", "withdrawn"},
    "declined":  set(),
    "expired":   set(),
    "bound":     set(),
    "withdrawn": set(),
}

QUOTE_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in QUOTE_TRANSITIONS.items() if not nexts
)


# ─── Policy lifecycle ────────────────────────────────────────────────────

PolicyStatus = Literal[
    "bound_pending_number",   # bound but carrier hasn't issued the number yet
    "active",                  # in force
    "cancelled",               # ended early — terminal
    "non_renewed",             # expired and not renewed — terminal
    "lapsed",                  # premium not paid — terminal
    "expired",                 # naturally expired — terminal
]

POLICY_TRANSITIONS: dict[str, set[str]] = {
    "bound_pending_number": {"active", "cancelled"},
    "active":               {"cancelled", "non_renewed", "lapsed", "expired"},
    "cancelled":            set(),
    "non_renewed":          set(),
    "lapsed":               {"active"},        # carrier reinstates after late payment
    "expired":              set(),
}

POLICY_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in POLICY_TRANSITIONS.items() if not nexts
)


# ─── Incident lifecycle (Phase A — operator-side reporting) ──────────────

IncidentStatus = Literal[
    "open",            # newly reported, no review yet
    "under_review",    # operator/broker is examining
    "closed",          # resolved / no further action
    "closed_archived", # soft-delete for operators wanting to hide it (Phase C)
]

INCIDENT_TRANSITIONS: dict[str, set[str]] = {
    "open":            {"under_review", "closed", "closed_archived"},
    "under_review":    {"open", "closed", "closed_archived"},
    "closed":          {"open", "under_review", "closed_archived"},
    "closed_archived": set(),  # terminal — undelete requires admin DB-level fix
}

INCIDENT_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in INCIDENT_TRANSITIONS.items() if not nexts
)


# ─── Claim lifecycle (carrier-side) ──────────────────────────────────────

ClaimStatus = Literal[
    "notified",
    "acknowledged",
    "under_investigation",
    "reserved",
    "settling",
    "closed_paid",
    "closed_denied",
    "closed_dropped",
    "reopened",
]

CLAIM_TRANSITIONS: dict[str, set[str]] = {
    "notified":            {"acknowledged", "closed_dropped"},
    "acknowledged":        {"under_investigation", "reserved", "closed_dropped"},
    "under_investigation": {"reserved", "settling", "closed_denied", "closed_dropped"},
    "reserved":            {"settling", "closed_paid", "closed_denied", "closed_dropped"},
    "settling":            {"closed_paid", "closed_denied", "closed_dropped"},
    "closed_paid":         {"reopened"},
    "closed_denied":       {"reopened"},
    "closed_dropped":      {"reopened"},
    "reopened":            {"reserved", "settling", "closed_paid", "closed_denied", "closed_dropped"},
}

CLAIM_TERMINAL_STATES: frozenset[str] = frozenset()
# Claim states are NEVER truly terminal — closed claims can reopen for
# subrogation, late-discovered information, or fraud investigation.


# ─── PolicyRequest lifecycle (operator→broker policy service request) ─────
#
# An operator raises a request against a policy (renew / cancel / COI /
# coverage change); the broker decides. Mirrors the ClaimProposal
# propose→decide pattern but as a typed lifecycle. The operator may
# withdraw their own request while it's still pending.

PolicyRequestStatus = Literal[
    "pending",     # operator submitted, awaiting broker decision
    "approved",    # broker accepted — terminal (broker actions it via the policy surfaces)
    "declined",    # broker rejected — terminal
    "cancelled",   # operator withdrew before a decision — terminal
]

POLICY_REQUEST_TRANSITIONS: dict[str, set[str]] = {
    "pending":   {"approved", "declined", "cancelled"},
    "approved":  set(),
    "declined":  set(),
    "cancelled": set(),
}

POLICY_REQUEST_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in POLICY_REQUEST_TRANSITIONS.items() if not nexts
)


# ─── ComplianceSignal lifecycle ──────────────────────────────────────────

ComplianceSignalStatus = Literal[
    "open",      # outstanding compliance item
    "resolved",  # cleared (evidence uploaded or broker waiver)
]

COMPLIANCE_SIGNAL_TRANSITIONS: dict[str, set[str]] = {
    "open":     {"resolved"},
    "resolved": {"open"},  # reopen if a waiver/evidence is retracted
}

COMPLIANCE_SIGNAL_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in COMPLIANCE_SIGNAL_TRANSITIONS.items() if not nexts
)
# Intentionally empty — like CLAIM_TERMINAL_STATES, a compliance signal is never
# truly terminal: a 'resolved' item can reopen if its waiver/evidence is
# retracted. Declared for parity with the other lifecycles; callers should not
# treat any status as a dead end.


# ─── Errors ──────────────────────────────────────────────────────────────

class InvalidTransitionError(ValueError):
    """Raised when a lifecycle function is asked to transition from one state
    to another that isn't listed in the entity's TRANSITIONS matrix."""


def assert_valid_transition(
    transitions: dict[str, set[str]],
    from_status: str,
    to_status: str,
    *,
    entity_name: str = "entity",
) -> None:
    """Validate a transition. Raises InvalidTransitionError on disallowed.

    Use at the top of every `transition_*` service function — keeps the
    lifecycle invariants enforced in exactly one place and produces
    consistent error messages."""
    if from_status not in transitions:
        raise InvalidTransitionError(
            f"{entity_name}: unknown source status {from_status!r}"
        )
    if to_status not in transitions:
        raise InvalidTransitionError(
            f"{entity_name}: unknown target status {to_status!r}"
        )
    allowed = transitions[from_status]
    if to_status not in allowed:
        raise InvalidTransitionError(
            f"{entity_name}: cannot transition from {from_status!r} → {to_status!r}. "
            f"Allowed transitions from {from_status!r}: {sorted(allowed)!r}"
        )


def transition_table_to_json(transitions: dict[str, set[str]]) -> dict[str, list[str]]:
    """Serialize a TRANSITIONS dict for the API (sets aren't JSON-native).
    Used by GET /api/submissions/transitions etc. so the frontend kanban
    can disable invalid drop targets client-side."""
    return {state: sorted(nexts) for state, nexts in transitions.items()}
