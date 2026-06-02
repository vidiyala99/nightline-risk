from sqlmodel import Session, SQLModel, create_engine
from app.models import Claim


def test_claim_has_coverage_fields():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        c = Claim(
            id="clm-x", policy_id="pol-x", coverage_line="gl",
            date_of_loss=__import__("datetime").date(2026, 5, 1), snapshot_hash="",
            coverage_decision="covered", coverage_rationale="ok",
            coverage_decided_by="u-carrier", coverage_decided_at="2026-06-02T00:00:00Z",
        )
        s.add(c); s.commit(); s.refresh(c)
        assert c.coverage_decision == "covered"
        assert c.coverage_decided_at == "2026-06-02T00:00:00Z"
