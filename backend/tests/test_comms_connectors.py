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


# --- Task 6 ---
import pytest
from uuid import uuid4
from fastapi.testclient import TestClient
from app.auth import create_token
from app.database import get_session
from app.main import app


def _seed_venue(vid: str) -> None:
    from app.models import Venue
    s = next(get_session())
    try:
        if s.get(Venue, vid) is None:
            s.add(Venue(id=vid, name=vid)); s.commit()
    finally:
        s.close()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _broker_h():
    return {"Authorization": f"Bearer {create_token('u-brk-comms', 'b@x.com', 'broker', None)}"}


def test_comms_ingest_scoped_to_venue(client):
    # Scope to a throwaway venue so seeded venues' compliance/incident state is
    # untouched (the endpoint would otherwise ingest the whole book and pollute
    # other tests' fixtures, e.g. nowadays' compliance-signal count).
    v = f"comms-it-{uuid4().hex[:8]}"
    _seed_venue(v)
    r = client.post("/api/comms/ingest", json={"source": "slack", "venue_id": v}, headers=_broker_h())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["extracted"] == 3 and body["incident"] >= 1

    rv = client.get("/api/comms/review", headers=_broker_h())
    assert rv.status_code == 200 and isinstance(rv.json(), list)


def test_comms_resolve_confirm_creates_incident(client):
    from app.models import CommsReviewItem, IncidentRecord
    v = f"comms-rv-{uuid4().hex[:8]}"
    _seed_venue(v)
    rid = f"cr-it-{uuid4().hex[:8]}"
    ext = f"ext-{uuid4().hex[:8]}"   # unique so the deterministic incident id can't collide across runs
    s = next(get_session())
    try:
        s.add(CommsReviewItem(
            id=rid, venue_id=v, source="slack", external_id=ext,
            raw_text="ambiguous scuffle by the bar", proposed_kind="incident",
            confidence=0.5, fields={"category": "general"}))
        s.commit()
    finally:
        s.close()
    res = client.post(f"/api/comms/review/{rid}/resolve",
                      json={"decision": "confirm"}, headers=_broker_h())
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "confirmed"
    s2 = next(get_session())
    try:
        assert s2.get(IncidentRecord, f"inc-comms-slack-{ext}") is not None
    finally:
        s2.close()


def test_comms_ingest_requires_auth(client):
    assert client.post("/api/comms/ingest", json={"source": "slack"}).status_code == 401


# --- Follow-up #2: real MCP source adapter (env-gated, fetch-injectable) ---
from app.ingestion.comms.mcp_source import McpCommsSource
from app.ingestion.comms.sources import build_comms_source


def test_mcp_source_maps_records_via_injected_fetch():
    records = [
        {"external_id": "slk-1", "text": "fight at the door, cops called",
         "occurred_at": "2026-02-02T03:00:00+00:00", "author": "bouncer", "venue_id": "v2"},
        {"id": "slk-2", "text": "exit sign out by stairwell B"},  # no venue_id -> fallback
    ]
    src = McpCommsSource("slack", ["v1"], fetch=lambda: records)
    items = src.list_items()
    assert len(items) == 2
    assert all(isinstance(i, CommsItem) for i in items)
    # record-level venue_id wins; external_id maps from either key
    assert items[0].source == "slack" and items[0].venue_id == "v2"
    assert items[0].external_id == "slk-1" and items[0].author == "bouncer"
    assert items[0].text == "fight at the door, cops called"
    # second record falls back to first configured venue and the `id` key
    assert items[1].venue_id == "v1" and items[1].external_id == "slk-2"


def test_mcp_source_skips_records_without_text():
    records = [
        {"external_id": "a", "text": "real message"},
        {"external_id": "b"},                # missing text -> skipped
        {"external_id": "c", "text": "   "},  # whitespace-only -> skipped
    ]
    items = McpCommsSource("tickets", ["v1"], fetch=lambda: records).list_items()
    assert [i.external_id for i in items] == ["a"]


def test_build_comms_source_unset_env_returns_simulated(monkeypatch):
    monkeypatch.delenv("COMMS_MCP_SLACK_SSE_URL", raising=False)
    src = build_comms_source("slack", ["v1"])
    assert isinstance(src, SlackSource)


def test_build_comms_source_set_env_returns_mcp(monkeypatch):
    monkeypatch.setenv("COMMS_MCP_SLACK_SSE_URL", "http://x")
    src = build_comms_source("slack", ["v1"])
    assert isinstance(src, McpCommsSource)
    assert src.source == "slack" and src.sse_url == "http://x"


# --- Follow-up #3: rubric auto-retrain from review corrections (corrections -> eval fixtures) ---
from app.evals.comms_classifier_eval import (
    FIXTURES,
    corrections_fixtures,
    score_against,
    score_with_corrections,
)


def _resolved(rid: str, text: str, kind: str, status: str = "confirmed") -> CommsReviewItem:
    return CommsReviewItem(
        id=rid, venue_id="v1", source="slack", external_id=rid,
        raw_text=text, proposed_kind=kind, confidence=0.5,
        status=status, resolved_kind=kind, fields={})


def test_corrections_fixtures_pulls_resolved_labels():
    s = _mem_session()
    s.add(_resolved("c-a", "a fight broke out", "incident", status="confirmed"))
    s.add(_resolved("c-b", "fire extinguisher expired", "compliance", status="corrected"))
    # pending / unresolved rows must be ignored
    s.add(CommsReviewItem(id="c-pend", venue_id="v1", source="slack", external_id="c-pend",
                          raw_text="ambiguous", proposed_kind="incident", confidence=0.5,
                          status="pending", resolved_kind=None, fields={}))
    s.commit()
    pairs = corrections_fixtures(s)
    assert sorted(pairs) == sorted([("a fight broke out", "incident"),
                                    ("fire extinguisher expired", "compliance")])


def test_score_with_corrections_blends_seed_and_corrections():
    s = _mem_session()
    s.add(_resolved("c-1", "a fight broke out near the bar", "incident"))
    s.add(_resolved("c-2", "fire extinguisher tag expired", "compliance", status="corrected"))
    s.add(_resolved("c-3", "restock the napkins", "noise"))
    s.commit()
    report = score_with_corrections(s)
    assert report["correction_count"] == 3
    assert report["combined"]["n"] == len(FIXTURES) + 3
    assert report["seed"]["n"] == len(FIXTURES)
    assert report["corrections"] is not None and report["corrections"]["n"] == 3


def test_score_with_corrections_no_corrections():
    s = _mem_session()
    report = score_with_corrections(s)
    assert report["correction_count"] == 0
    assert report["combined"]["n"] == len(FIXTURES)
    assert report["combined"]["n"] == report["seed"]["n"]
    assert report["corrections"] is None


def test_score_against_scores_arbitrary_fixtures():
    out = score_against([("a fight broke out", "incident"),
                         ("restock napkins", "noise")])
    assert out["n"] == 2 and out["accuracy"] == 1.0


def test_comms_eval_endpoint_broker_only(client):
    r = client.get("/api/comms/eval", headers=_broker_h())
    assert r.status_code == 200, r.text
    body = r.json()
    assert "seed" in body and "combined" in body and "correction_count" in body
    assert body["seed"]["n"] == len(FIXTURES)


def test_comms_eval_endpoint_requires_auth(client):
    assert client.get("/api/comms/eval").status_code in (401, 403)
