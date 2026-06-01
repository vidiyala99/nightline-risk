"""HTTP tests for the open-questions answer/resolve routes.

  POST /api/packets/{packet_id}/open-questions/{index}/answer    (operator)
  POST /api/packets/{packet_id}/open-questions/{index}/resolve   (broker)
  GET  /api/packets/{packet_id}  → payload carries open_question_responses

Closes the operator→broker loop: an operator's answer must surface on the
broker's packet read, and a broker's resolve must persist.
"""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import IncidentRecord
from app.packet_core import create_packet_snapshot
from app.schemas import IncidentCreate

VENUE = "elsewhere-brooklyn"
QUESTIONS = ["Was the rear camera operational?", "Did the patron sign an acknowledgment?"]


def _op_headers(tenant=VENUE):
    return {"Authorization": f"Bearer {create_token('u-op', 'op@nightline.risk', 'venue_operator', tenant)}"}


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk', 'broker@nightline.risk', 'broker', None)}"}


@pytest.fixture
def client_pid(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as s:
        s.add(IncidentRecord(
            id="inc-oq", venue_id=VENUE, occurred_at="2026-05-02T23:13:00Z",
            location="rear bar", summary="brawl", reported_by="op",
            injury_observed=True, police_called=True, ems_called=False,
        ))
        s.commit()
        pkt = create_packet_snapshot(
            session=s, venue_id=VENUE, incident_id="inc-oq",
            incident=IncidentCreate(
                occurred_at="2026-05-02T23:13:00Z", location="rear bar", summary="brawl",
                reported_by="op", injury_observed=True, police_called=True, ems_called=False,
            ),
            risk_signal={"type": "altercation_event", "severity": "medium", "confidence": 0.8, "review_status": "needs_review"},
            action_plan=[], claims_timeline=[],
            underwriting_memo={"summary": "m", "open_questions": QUESTIONS, "review_status": "draft"},
            citations=[], rubric_version="demo-rubric-v1",
        )
        s.commit()
        pid = pkt.id

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c, pid
    app.dependency_overrides.clear()


def test_operator_answer_surfaces_in_packet_payload(client_pid):
    client, pid = client_pid
    r = client.post(
        f"/api/packets/{pid}/open-questions/0/answer",
        headers=_op_headers(),
        json={"question_text": QUESTIONS[0], "answer": "Yes — footage attached."},
    )
    assert r.status_code in (200, 201), r.text

    # Broker reads the packet → sees the operator's answer.
    pkt = client.get(f"/api/packets/{pid}", headers=_broker_headers()).json()
    responses = pkt["open_question_responses"]
    assert len(responses) == 1
    assert responses[0]["question_index"] == 0
    assert responses[0]["answer"] == "Yes — footage attached."
    assert responses[0]["answered_by"] == "u-op"
    assert responses[0]["resolved"] is False


def test_broker_resolve_persists_in_payload(client_pid):
    client, pid = client_pid
    client.post(f"/api/packets/{pid}/open-questions/1/answer", headers=_op_headers(),
                json={"question_text": QUESTIONS[1], "answer": "Signed."})
    r = client.post(f"/api/packets/{pid}/open-questions/1/resolve", headers=_broker_headers(), json={})
    assert r.status_code == 200, r.text

    pkt = client.get(f"/api/packets/{pid}", headers=_broker_headers()).json()
    row = next(x for x in pkt["open_question_responses"] if x["question_index"] == 1)
    assert row["resolved"] is True
    assert row["resolved_by"] == "u-brk"
    assert row["answer"] == "Signed."


def test_answer_requires_auth(client_pid):
    client, pid = client_pid
    r = client.post(f"/api/packets/{pid}/open-questions/0/answer", json={"answer": "x"})
    assert r.status_code == 401


def test_answer_denied_for_other_venue_operator(client_pid):
    client, pid = client_pid
    r = client.post(f"/api/packets/{pid}/open-questions/0/answer",
                    headers=_op_headers(tenant="some-other-venue"),
                    json={"question_text": QUESTIONS[0], "answer": "x"})
    assert r.status_code == 403


def test_resolve_requires_broker(client_pid):
    client, pid = client_pid
    r = client.post(f"/api/packets/{pid}/open-questions/0/resolve", headers=_op_headers(), json={})
    assert r.status_code == 403


def test_answer_unknown_packet_404(client_pid):
    client, _ = client_pid
    r = client.post("/api/packets/pkt-nope/open-questions/0/answer",
                    headers=_op_headers(), json={"answer": "x"})
    assert r.status_code == 404


def test_answer_out_of_range_index_400(client_pid):
    client, pid = client_pid
    r = client.post(f"/api/packets/{pid}/open-questions/9/answer",
                    headers=_op_headers(), json={"question_text": "ghost", "answer": "x"})
    assert r.status_code == 400
