"""Per-metric data-quality gate for the ingestion spine.

Every operational metric has a known valid range; a value outside it (or a
non-finite value, or an unknown metric) is a data-quality defect and the
event is rejected before it can pollute the rollup and skew a venue's score.
Master-data items (no `metric_name`) aren't operational events, so the gate
passes them — they have their own idempotent upsert path.

`is_valid_event` is wired into the runner as the default `quality_filter`.
`rejection_reason` returns *why* an event was rejected so the run log can
explain its `rejected` count instead of just totalling it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class MetricSpec:
    metric_name: str
    min_value: float
    max_value: float


# Rates are shares in [0, 1]; ratios are relative to a target of 1.0 and may
# legitimately exceed it (over capacity / overstaffed), capped at a sane bound.
METRIC_SPECS: dict[str, MetricSpec] = {
    "over_pour_rate": MetricSpec("over_pour_rate", 0.0, 1.0),
    "id_rejection_rate": MetricSpec("id_rejection_rate", 0.0, 1.0),
    "occupancy_ratio": MetricSpec("occupancy_ratio", 0.0, 3.0),
    "staffing_ratio": MetricSpec("staffing_ratio", 0.0, 3.0),
}


def rejection_reason(item: Any) -> Optional[str]:
    """None if the event is valid (or is a non-operational master-data item),
    else a stable reason code: 'unknown_metric' | 'non_finite' | 'out_of_range'."""
    metric = getattr(item, "metric_name", None)
    if metric is None:
        return None  # master-data item — gate not applicable

    spec = METRIC_SPECS.get(metric)
    if spec is None:
        return "unknown_metric"

    value = getattr(item, "value", None)
    if value is None or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "non_finite"

    if not (spec.min_value <= value <= spec.max_value):
        return "out_of_range"

    return None


def is_valid_event(item: Any) -> bool:
    """True if `item` is a structurally-sound operational event (or not an
    operational event at all). False marks a data-quality rejection."""
    return rejection_reason(item) is None
