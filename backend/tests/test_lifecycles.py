"""Tests for app/lifecycles.py — the lifecycle state matrices for the
broker-platform tables (Submission, CarrierQuote, Policy, Claim).

The transition matrices encode insurance domain rules:
  - A 'bound' submission cannot go back to 'open' (it's already been placed).
  - A 'declined' carrier quote stays declined — no resurrection.
  - A 'lapsed' policy can be reinstated ('lapsed' → 'active') after late
    premium payment, but only that one transition is allowed from lapsed.
  - Claims can ALWAYS reopen — there are no truly terminal claim states.

If any of these rules change because of a real underwriting requirement,
the matrices update here and downstream services automatically inherit
the new rules — no scattered if-statements to chase.
"""

import pytest

from app.lifecycles import (
    CLAIM_TERMINAL_STATES,
    CLAIM_TRANSITIONS,
    InvalidTransitionError,
    POLICY_TERMINAL_STATES,
    POLICY_TRANSITIONS,
    QUOTE_TERMINAL_STATES,
    QUOTE_TRANSITIONS,
    SUBMISSION_TERMINAL_STATES,
    SUBMISSION_TRANSITIONS,
    assert_valid_transition,
    transition_table_to_json,
)


# ─── Submission transitions ─────────────────────────────────────────────

def test_submission_open_can_go_to_in_market_or_withdrawn():
    assert SUBMISSION_TRANSITIONS["open"] == {"in_market", "withdrawn"}


def test_submission_bound_is_terminal():
    assert SUBMISSION_TRANSITIONS["bound"] == set()
    assert "bound" in SUBMISSION_TERMINAL_STATES


def test_submission_lost_is_terminal():
    assert SUBMISSION_TRANSITIONS["lost"] == set()


def test_submission_quoting_can_bind_or_lose():
    """The two real outcomes of a quoting submission: bind it with us,
    or lose it to a competitor. Withdrawn is the broker-initiated escape."""
    assert SUBMISSION_TRANSITIONS["quoting"] == {"bound", "lost", "withdrawn"}


def test_submission_cannot_skip_in_market():
    """Open can't go directly to bound — must pass through in_market + quoting.
    This catches a common bug class where someone tries to write a quote
    directly against a submission that never went to market."""
    assert "bound" not in SUBMISSION_TRANSITIONS["open"]
    assert "quoting" not in SUBMISSION_TRANSITIONS["open"]


def test_submission_terminal_states_match_empty_transition_sets():
    """The TERMINAL_STATES frozenset must be derived correctly from the
    empty-transition entries — otherwise downstream code that filters on
    'is this terminal?' gets the wrong answer."""
    derived = frozenset(s for s, nexts in SUBMISSION_TRANSITIONS.items() if not nexts)
    assert SUBMISSION_TERMINAL_STATES == derived
    # The four terminal submission states:
    assert SUBMISSION_TERMINAL_STATES == frozenset({"bound", "lost", "declined", "withdrawn"})


# ─── Quote transitions ──────────────────────────────────────────────────

def test_quote_requested_can_progress_or_be_declined():
    assert QUOTE_TRANSITIONS["requested"] == {
        "pending", "quoted", "declined", "expired", "withdrawn"
    }


def test_quoted_can_bind_or_expire():
    assert QUOTE_TRANSITIONS["quoted"] == {"bound", "expired", "withdrawn"}


def test_declined_quote_cannot_be_resurrected():
    """No transition path out of 'declined'. A declined quote is permanently
    declined — if the carrier reconsiders, that's a NEW quote, not a
    revived old one. Preserves audit integrity."""
    assert QUOTE_TRANSITIONS["declined"] == set()


def test_quote_terminal_states_complete():
    assert QUOTE_TERMINAL_STATES == frozenset({"declined", "expired", "bound", "withdrawn"})


# ─── Policy transitions ─────────────────────────────────────────────────

def test_policy_bound_pending_number_can_activate_or_cancel():
    """Carrier hasn't issued the policy number yet — the broker can still
    cancel the deal (rare but possible) or wait for activation."""
    assert POLICY_TRANSITIONS["bound_pending_number"] == {"active", "cancelled"}


def test_lapsed_policy_can_reinstate():
    """The one non-obvious policy transition: a lapsed policy (non-payment)
    CAN come back to active after late payment + reinstatement endorsement.
    All other lapsed→X paths are not modeled here."""
    assert POLICY_TRANSITIONS["lapsed"] == {"active"}


def test_cancelled_is_terminal():
    assert POLICY_TRANSITIONS["cancelled"] == set()
    assert "cancelled" in POLICY_TERMINAL_STATES


def test_active_can_end_four_ways():
    """The four ways an active policy ends. If the brokerage discovers a
    fifth (e.g., regulatory rescission), it goes here."""
    assert POLICY_TRANSITIONS["active"] == {"cancelled", "non_renewed", "lapsed", "expired"}


# ─── Claim transitions ─────────────────────────────────────────────────

def test_claim_states_never_truly_terminal():
    """Claims can ALWAYS reopen (subrogation, late discovery, fraud). The
    TERMINAL_STATES frozenset is intentionally empty — anything that needs
    'is this claim active?' filters on status_in(["closed_*"]) instead."""
    assert CLAIM_TERMINAL_STATES == frozenset()


def test_closed_paid_can_reopen():
    """The most common reason to reopen a closed-paid claim: subrogation
    recovery from a third party."""
    assert "reopened" in CLAIM_TRANSITIONS["closed_paid"]


def test_reopened_can_close_again():
    """Reopened claims must be able to reach a closed state again, otherwise
    they live forever in 'reopened' which corrupts loss-ratio metrics."""
    closed_states = {"closed_paid", "closed_denied", "closed_dropped"}
    assert closed_states.issubset(CLAIM_TRANSITIONS["reopened"])


def test_notified_must_acknowledge_before_investigating():
    """FNOL workflow integrity: an investigation cannot start until the
    carrier acknowledges receipt. Catches a bug class where someone tries
    to set a reserve before the carrier has actually seen the claim."""
    assert "under_investigation" not in CLAIM_TRANSITIONS["notified"]
    assert "under_investigation" in CLAIM_TRANSITIONS["acknowledged"]


# ─── assert_valid_transition() ──────────────────────────────────────────

def test_valid_transition_does_not_raise():
    assert_valid_transition(
        SUBMISSION_TRANSITIONS, "open", "in_market", entity_name="Submission"
    )  # no return — just must not raise


def test_invalid_transition_raises_with_clear_message():
    with pytest.raises(InvalidTransitionError, match=r"Submission.*from 'bound'.*'open'"):
        assert_valid_transition(
            SUBMISSION_TRANSITIONS, "bound", "open", entity_name="Submission"
        )


def test_unknown_from_status_raises():
    with pytest.raises(InvalidTransitionError, match=r"unknown source status 'garbage'"):
        assert_valid_transition(
            SUBMISSION_TRANSITIONS, "garbage", "open", entity_name="Submission"
        )


def test_unknown_to_status_raises():
    with pytest.raises(InvalidTransitionError, match=r"unknown target status 'garbage'"):
        assert_valid_transition(
            SUBMISSION_TRANSITIONS, "open", "garbage", entity_name="Submission"
        )


def test_typo_catches_in_market_with_space():
    """The motivating bug class: 'in market' (space) vs 'in_market'
    (underscore). The matrix only has the underscore form; using the
    space form must fail loudly."""
    with pytest.raises(InvalidTransitionError, match=r"unknown target status 'in market'"):
        assert_valid_transition(
            SUBMISSION_TRANSITIONS, "open", "in market", entity_name="Submission"
        )


# ─── transition_table_to_json() ─────────────────────────────────────────

def test_json_serialization_uses_sorted_lists():
    """The API surface (GET /api/submissions/transitions) returns lists,
    not sets. Sorted for stable test snapshots + a deterministic UI."""
    result = transition_table_to_json(SUBMISSION_TRANSITIONS)
    assert result["open"] == sorted(["in_market", "withdrawn"])
    assert result["bound"] == []
    # All values are lists:
    for k, v in result.items():
        assert isinstance(v, list), f"{k}: expected list, got {type(v).__name__}"


def test_json_serialization_includes_every_state():
    result = transition_table_to_json(SUBMISSION_TRANSITIONS)
    assert set(result.keys()) == set(SUBMISSION_TRANSITIONS.keys())
