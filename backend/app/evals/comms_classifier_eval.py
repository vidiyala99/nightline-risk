# backend/app/evals/comms_classifier_eval.py
"""Rubric scorer for the comms classifier. Fixtures pair representative text with
its expected kind; the scorer reports accuracy + per-kind precision/recall so the
gate thresholds (app/ingestion/comms/gate.py) can be tuned to a precision target."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Optional

from sqlmodel import Session, select

from app.ingestion.comms.classifier import classify_comms_item
from app.ingestion.comms.sources import SAMPLE_FEED
from app.ingestion.comms.types import CommsClassification, CommsItem
from app.models import CommsReviewItem

# Reuse the source samples as labels + a few harder cases.
FIXTURES: list[tuple[str, str]] = [
    (text, label) for feed in SAMPLE_FEED.values() for (text, label) in feed
] + [
    ("guard refused entry to an intoxicated patron", "noise"),
    ("someone got punched near the dance floor", "incident"),
    ("liquor license renewal due next month", "compliance"),
]


def score_against(
    fixtures: list[tuple[str, str]],
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> dict:
    """Score any list of (text, expected_kind) pairs. Returns accuracy + per-kind
    precision/recall + n (same shape regardless of the fixture source)."""
    kinds = ["incident", "compliance", "noise"]
    tp = {k: 0 for k in kinds}
    fp = {k: 0 for k in kinds}
    fn = {k: 0 for k in kinds}
    correct = 0
    for text, expected in fixtures:
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
        "accuracy": round(correct / len(fixtures), 3) if fixtures else 1.0,
        "per_kind": {
            k: {"precision": _ratio(tp[k], tp[k] + fp[k]), "recall": _ratio(tp[k], tp[k] + fn[k])}
            for k in kinds
        },
        "n": len(fixtures),
    }


def score_classifier(
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> dict:
    return score_against(FIXTURES, classifier)


def corrections_fixtures(session: Session) -> list[tuple[str, str]]:
    """Accumulated human labels: every review item a reviewer confirmed/corrected
    becomes a (raw_text, true_kind) eval fixture. These are the hard cases the
    classifier wasn't confident on — the ones worth scoring against."""
    rows = session.exec(
        select(CommsReviewItem).where(
            CommsReviewItem.status.in_(("confirmed", "corrected")),  # type: ignore[attr-defined]
            CommsReviewItem.resolved_kind.is_not(None),  # type: ignore[attr-defined]
        )
    ).all()
    return [(r.raw_text, r.resolved_kind) for r in rows if r.resolved_kind]


def score_with_corrections(
    session: Session,
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> dict:
    """Score the classifier against the seed fixtures, the accumulated review
    corrections, and the two combined. The `corrections` sub-report is the
    classifier's accuracy on the cases humans actually triaged."""
    corrections = corrections_fixtures(session)
    return {
        "seed": score_against(FIXTURES, classifier),
        "corrections": score_against(corrections, classifier) if corrections else None,
        "combined": score_against(FIXTURES + corrections, classifier),
        "correction_count": len(corrections),
    }
