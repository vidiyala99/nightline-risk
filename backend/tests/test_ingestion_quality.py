"""Tests for the per-metric data-quality gate (app/ingestion/quality.py)."""
from datetime import datetime

from app.ingestion.base import NormalizedEvent
from app.ingestion.quality import is_valid_event, rejection_reason


def _ev(metric: str, value: float) -> NormalizedEvent:
    return NormalizedEvent(
        venue_id="v1",
        source_system="pos",
        event_type="x",
        metric_name=metric,
        value=value,
        occurred_at=datetime(2026, 5, 26, 2, 0, 0),
    )


def test_in_range_rate_passes():
    assert is_valid_event(_ev("over_pour_rate", 0.4)) is True
    assert is_valid_event(_ev("id_rejection_rate", 0.0)) is True
    assert is_valid_event(_ev("id_rejection_rate", 1.0)) is True


def test_out_of_range_rate_rejected():
    assert is_valid_event(_ev("over_pour_rate", -0.1)) is False
    assert is_valid_event(_ev("over_pour_rate", 1.5)) is False


def test_unknown_metric_rejected():
    assert is_valid_event(_ev("made_up_metric", 0.5)) is False


def test_non_finite_value_rejected():
    assert is_valid_event(_ev("over_pour_rate", float("nan"))) is False
    assert is_valid_event(_ev("over_pour_rate", float("inf"))) is False


def test_ratio_metrics_allow_above_one():
    # occupancy/staffing are ratios that legitimately exceed 1.0
    assert is_valid_event(_ev("occupancy_ratio", 1.4)) is True
    assert is_valid_event(_ev("staffing_ratio", 1.2)) is True
    # but not absurd values
    assert is_valid_event(_ev("occupancy_ratio", 99.0)) is False


def test_non_event_item_passes_gate():
    # master-data rows (dicts, no metric_name) aren't operational events;
    # the gate is N/A and must not reject them.
    assert is_valid_event({"id": "SLA-1", "name": "The Owl Bar"}) is True


def test_rejection_reason_codes():
    assert rejection_reason(_ev("over_pour_rate", 0.4)) is None          # valid
    assert rejection_reason(_ev("over_pour_rate", 1.5)) == "out_of_range"
    assert rejection_reason(_ev("over_pour_rate", float("nan"))) == "non_finite"
    assert rejection_reason(_ev("made_up_metric", 0.5)) == "unknown_metric"
    assert rejection_reason({"id": "SLA-1"}) is None                     # master-data
