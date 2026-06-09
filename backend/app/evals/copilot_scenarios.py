"""Gold scenarios for the copilot eval (spec §8). Each scenario factory seeds an
in-memory DB (via the shared ``copilot_seed`` helpers), and declares the axis
the Task-11 runner scores against:

  - ``axis="read"``           a read question; ``expected_tool`` is the tool
                              ``provider._classify`` should pick;
                              ``should_refuse=False``, ``should_propose=False``.
  - ``axis="refuse"``         off-topic; ``should_refuse=True``,
                              ``expected_tool=None``.
  - ``axis="action_ok"``      send-to-broker on a borderline+insured incident;
                              the engine proposes (``should_propose=True``).
  - ``axis="action_blocked"`` send-to-broker on a no-policy incident; the engine
                              refuses (``should_refuse=True``).

A fixed ``NOW`` (from ``copilot_seed``) keeps risk decay / renewal math
deterministic. Action scenarios put the seeded incident id (``inc-borderline``)
in the message so the engine's ``_ID`` regex extracts it.

Mirrors the structure of ``app/evals/intelligence_scenarios.py``: ``SCENARIOS``
is a list of zero-arg functions, each returning a self-contained dict with a
live ``session``.
"""
from __future__ import annotations

from app.evals.copilot_seed import (
    INCIDENT_ID,
    NOW,
    VENUE,
    make_session,
    operator_scope,
    seed_borderline,
    seed_policy,
)

__all__ = ["SCENARIOS", "NOW"]


def _operator_user() -> dict:
    return {"role": "venue_operator", "tenant_id": VENUE, "user_id": "u-op"}


def _insured_session():
    """A live session seeded with the borderline incident + an active policy."""
    s = make_session()
    seed_borderline(s)
    seed_policy(s)
    s.commit()
    return s


def _no_policy_session():
    """A live session seeded with the borderline incident but NO policy."""
    s = make_session()
    seed_borderline(s)
    s.commit()
    return s


def _read(name: str, message: str, expected_tool: str):
    def factory():
        return {
            "name": name,
            "axis": "read",
            "user": _operator_user(),
            "session": _insured_session(),
            "message": message,
            "expected_tool": expected_tool,
            "should_refuse": False,
            "should_propose": False,
            "confirm_action": None,
        }

    factory.__name__ = name
    return factory


# ─── Read intents (all four) ────────────────────────────────────────────────

read_risk = _read(
    "read_risk_score", "why is my risk a C?", "get_risk_score")
read_exposure = _read(
    "read_exposure", "what needs my attention?", "get_exposure")
read_claims = _read(
    "read_open_claims", "any open claims?", "list_open_claims")
read_incidents = _read(
    "read_incidents", "what's the status of my reports?", "list_incidents")

# Two extra reads to clear ≥8 without leaning on a heavy resolve-compliance seed.
read_risk_alt = _read(
    "read_risk_tier", "what tier am I in?", "get_risk_score")
read_exposure_alt = _read(
    "read_exposure_overdue", "am I overdue on anything?", "get_exposure")


# ─── Refusal (off-topic) ────────────────────────────────────────────────────

def refuse_off_topic():
    return {
        "name": "refuse_off_topic",
        "axis": "refuse",
        "user": _operator_user(),
        "session": _insured_session(),
        "message": "what's the weather tonight?",
        "expected_tool": None,
        "should_refuse": True,
        "should_propose": False,
        "confirm_action": None,
    }


# ─── Action OK (send-to-broker, borderline + insured → engine proposes) ──────

def action_send_to_broker_ok():
    # No ``confirm_action``: this axis scores the PROPOSE phase. Passing a
    # confirm_action would route respond_to_message straight to phase-2 execute
    # (returning an ``answer``), so the engine could never ``propose_action``
    # and ``should_propose=True`` would be unsatisfiable. The propose phase is
    # what action_ok is about; the confirm path is exercised in the engine tests.
    return {
        "name": "action_send_to_broker_ok",
        "axis": "action_ok",
        "user": _operator_user(),
        "session": _insured_session(),
        "message": f"send incident {INCIDENT_ID} to my broker",
        "expected_tool": None,
        "should_refuse": False,
        "should_propose": True,
        "confirm_action": None,
    }


# ─── Action blocked (send-to-broker, no policy → engine refuses) ─────────────

def action_send_to_broker_blocked():
    return {
        "name": "action_send_to_broker_blocked",
        "axis": "action_blocked",
        "user": _operator_user(),
        "session": _no_policy_session(),
        "message": f"send incident {INCIDENT_ID} to my broker",
        "expected_tool": None,
        "should_refuse": True,
        "should_propose": False,
        "confirm_action": None,
    }


SCENARIOS = [
    read_risk,
    read_exposure,
    read_claims,
    read_incidents,
    read_risk_alt,
    read_exposure_alt,
    refuse_off_topic,
    action_send_to_broker_ok,
    action_send_to_broker_blocked,
]
