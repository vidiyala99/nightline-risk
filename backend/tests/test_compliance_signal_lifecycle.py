import pytest
from app.lifecycles import (
    COMPLIANCE_SIGNAL_TRANSITIONS,
    assert_valid_transition,
    InvalidTransitionError,
)
from app.models import ComplianceSignal


def test_transition_matrix_allows_resolve_and_reopen():
    assert "resolved" in COMPLIANCE_SIGNAL_TRANSITIONS["open"]
    assert "open" in COMPLIANCE_SIGNAL_TRANSITIONS["resolved"]


def test_invalid_transition_raises():
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(
            COMPLIANCE_SIGNAL_TRANSITIONS, "resolved", "archived",
            entity_name="compliance_signal",
        )


def test_model_defaults_status_open_and_timestamps():
    row = ComplianceSignal(
        id="cs-1", venue_id="nowadays", title="t", description="d",
        provenance="underwriter_verified", severity="medium",
    )
    assert row.status == "open"
    assert row.resolved_at is None
    assert row.created_at is not None
