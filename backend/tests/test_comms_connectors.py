# backend/tests/test_comms_connectors.py
from app.ingestion.comms.sources import SlackSource, TicketSource, TextSource
from app.ingestion.comms.types import CommsItem


def test_sources_emit_venue_scoped_items_deterministically():
    for Source, name in [(SlackSource, "slack"), (TicketSource, "tickets"), (TextSource, "sms")]:
        items = Source(["v1"]).list_items()
        assert items and all(isinstance(i, CommsItem) for i in items)
        assert all(i.venue_id == "v1" and i.source == name for i in items)
        # stable external_id within a window → re-listing is identical
        again = Source(["v1"]).list_items()
        assert [i.external_id for i in items] == [i.external_id for i in again]


# --- Task 2 ---
from datetime import datetime, timezone
from app.ingestion.comms.classifier import classify_comms_item
from app.ingestion.comms.gate import decide
from app.evals.comms_classifier_eval import score_classifier


def _item(text: str) -> CommsItem:
    return CommsItem(source="slack", venue_id="v1", external_id="x", text=text,
                     occurred_at=datetime(2026, 2, 2, tzinfo=timezone.utc))


def test_classifier_labels_known_texts():
    assert classify_comms_item(_item("a fight broke out, police called")).kind == "incident"
    assert classify_comms_item(_item("fire extinguisher tag expired")).kind == "compliance"
    assert classify_comms_item(_item("restock the napkins")).kind == "noise"


def test_gate_routes_by_confidence():
    from app.ingestion.comms.types import CommsClassification
    assert decide(CommsClassification(kind="incident", confidence=0.95)) == "auto"
    assert decide(CommsClassification(kind="incident", confidence=0.5)) == "review"
    assert decide(CommsClassification(kind="noise", confidence=0.9)) == "drop"
    assert decide(CommsClassification(kind="noise", confidence=0.4)) == "review"


def test_eval_scorer_meets_threshold():
    report = score_classifier()
    assert report["accuracy"] >= 0.9
