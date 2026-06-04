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


# --- Task 3 ---
from sqlmodel import Session, SQLModel, create_engine


def _mem_session() -> Session:
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    return Session(eng)


def test_comms_review_item_roundtrips():
    from app.models import CommsReviewItem
    s = _mem_session()
    row = CommsReviewItem(id="cr-1", venue_id="v1", source="slack", external_id="x1",
                          raw_text="ambiguous thing", proposed_kind="incident",
                          confidence=0.5, fields={"category": "general"})
    s.add(row); s.commit()
    got = s.get(CommsReviewItem, "cr-1")
    assert got.status == "pending" and got.proposed_kind == "incident"


# --- Task 4 ---
from app.models import CommsReviewItem, ComplianceSignal, IncidentRecord


def test_router_creates_records_per_kind():
    from app.ingestion.comms.router import route
    from app.ingestion.comms.types import CommsClassification

    s = _mem_session()
    base = dict(source="slack", venue_id="v1", occurred_at=datetime(2026, 2, 2, tzinfo=timezone.utc))

    # high-confidence incident -> IncidentRecord
    r1 = route(s, CommsItem(external_id="i1", text="fight at door", **base),
               CommsClassification(kind="incident", confidence=0.95, fields={"category": "a_and_b"}))
    assert r1["action"] == "incident"
    assert s.get(IncidentRecord, r1["incident_id"]).reported_by_staff_id is None

    # high-confidence compliance -> ComplianceSignal
    r2 = route(s, CommsItem(external_id="c1", text="extinguisher expired", **base),
               CommsClassification(kind="compliance", confidence=0.9))
    assert r2["action"] == "compliance" and s.get(ComplianceSignal, r2["signal_id"]) is not None

    # noise -> dropped
    r3 = route(s, CommsItem(external_id="n1", text="napkins", **base),
               CommsClassification(kind="noise", confidence=0.9))
    assert r3["action"] == "noise"

    # low-confidence -> review item
    r4 = route(s, CommsItem(external_id="r1", text="someone seemed hurt maybe", **base),
               CommsClassification(kind="incident", confidence=0.5))
    assert r4["action"] == "review" and s.get(CommsReviewItem, r4["review_id"]).status == "pending"


# --- Task 5 ---
def test_run_comms_processes_and_dedupes():
    from app.ingestion.comms.connector import run_comms
    s = _mem_session()
    # seed the FK venue so incident/compliance inserts satisfy it on strict dialects
    from app.models import Venue
    s.add(Venue(id="v1", name="v1")); s.commit()

    summary = run_comms("slack", s, venue_ids=["v1"])
    assert summary["extracted"] == 3                  # 3 sample slack items
    assert summary["incident"] + summary["compliance"] + summary["noise"] + summary["review"] == 3
    assert summary["incident"] >= 1 and summary["compliance"] >= 1

    # re-run same window -> created records (incident, compliance) are deduped;
    # noise leaves no row so it harmlessly re-evaluates. No new records created.
    again = run_comms("slack", s, venue_ids=["v1"])
    assert again["incident"] == 0 and again["compliance"] == 0
    assert again["skipped"] >= 2   # the incident + compliance items
