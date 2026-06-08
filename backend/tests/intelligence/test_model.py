from sqlmodel import SQLModel, Session, create_engine
from app.models import RiskFindingRecord
from app.time import now_utc


def test_risk_finding_record_roundtrips_json_columns():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        rec = RiskFindingRecord(
            id="rf-test-1",
            persona="venue_operator",
            kind="evidence_gap",
            subject_type="incident",
            subject_id="inc-1",
            subject_label="Brawl at entrance",
            subject_href="/incidents/inc-1",
            severity="high",
            severity_rank=3,
            why=[{"source_id": "inc-1", "source_type": "incident", "excerpt": "..."}],
            recommended_action={"label": "Attach evidence", "href": "/incidents/inc-1"},
            prediction={"claim": "likely denied", "falsifiable_by": "claim_outcome", "horizon": "on_claim"},
            venue_id="v1",
            computed_at=now_utc(),
        )
        session.add(rec)
        session.commit()
        got = session.get(RiskFindingRecord, "rf-test-1")
        assert got is not None
        assert got.why[0]["source_id"] == "inc-1"
        assert got.recommended_action["label"] == "Attach evidence"
        assert got.status == "open"
        assert got.severity_rank == 3
