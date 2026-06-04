# backend/app/evals/comms_classifier_eval.py
"""Rubric scorer for the comms classifier. Fixtures pair representative text with
its expected kind; the scorer reports accuracy + per-kind precision/recall so the
gate thresholds (app/ingestion/comms/gate.py) can be tuned to a precision target."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Optional

from app.ingestion.comms.classifier import classify_comms_item
from app.ingestion.comms.sources import SAMPLE_FEED
from app.ingestion.comms.types import CommsClassification, CommsItem

# Reuse the source samples as labels + a few harder cases.
FIXTURES: list[tuple[str, str]] = [
    (text, label) for feed in SAMPLE_FEED.values() for (text, label) in feed
] + [
    ("guard refused entry to an intoxicated patron", "noise"),
    ("someone got punched near the dance floor", "incident"),
    ("liquor license renewal due next month", "compliance"),
]


def score_classifier(
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> dict:
    kinds = ["incident", "compliance", "noise"]
    tp = {k: 0 for k in kinds}
    fp = {k: 0 for k in kinds}
    fn = {k: 0 for k in kinds}
    correct = 0
    for text, expected in FIXTURES:
        item = CommsItem(source="eval", venue_id="v", external_id="e", text=text,
                         occurred_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
        pred = classify_comms_item(item, classifier=classifier).kind
        if pred == expected:
            correct += 1
            tp[expected] += 1
        else:
            fp[pred] += 1
            fn[expected] += 1
    def _ratio(n, d): return round(n / d, 3) if d else 1.0
    return {
        "accuracy": round(correct / len(FIXTURES), 3),
        "per_kind": {
            k: {"precision": _ratio(tp[k], tp[k] + fp[k]), "recall": _ratio(tp[k], tp[k] + fn[k])}
            for k in kinds
        },
        "n": len(FIXTURES),
    }
