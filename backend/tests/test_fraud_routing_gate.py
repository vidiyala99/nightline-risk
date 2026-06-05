import pytest
from sqlmodel import Session, SQLModel, create_engine
from app.models import UnderwritingPacket


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def test_fraud_signal_column_round_trips(db_session):
    pkt = UnderwritingPacket(
        id="pkt-1", venue_id="v1", incident_id="inc-1", rubric_version_id="rv-1",
        status="generated", snapshot_hash="h",
        fraud_signal={"score": 0.55, "tier": "high", "red_flags": [], "summary": "s",
                      "assessed_stage": "v1"},
    )
    db_session.add(pkt)
    db_session.commit()
    db_session.expire_all()
    got = db_session.get(UnderwritingPacket, "pkt-1")
    assert got.fraud_signal["tier"] == "high"
