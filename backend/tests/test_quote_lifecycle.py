import pytest
from app.lifecycles import QUOTE_TRANSITIONS, assert_valid_transition, InvalidTransitionError


def test_info_requested_is_reachable_and_requeues():
    assert "info_requested" in QUOTE_TRANSITIONS["requested"]
    assert "info_requested" in QUOTE_TRANSITIONS["pending"]
    assert QUOTE_TRANSITIONS["info_requested"] >= {"pending", "quoted", "declined"}


def test_info_requested_round_trip_valid():
    assert_valid_transition(QUOTE_TRANSITIONS, "requested", "info_requested", entity_name="CarrierQuote")
    assert_valid_transition(QUOTE_TRANSITIONS, "info_requested", "pending", entity_name="CarrierQuote")


def test_terminal_states_cannot_request_info():
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(QUOTE_TRANSITIONS, "declined", "info_requested", entity_name="CarrierQuote")
