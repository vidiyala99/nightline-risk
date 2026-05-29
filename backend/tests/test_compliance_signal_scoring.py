from sqlmodel import Session, SQLModel, create_engine
from app.models import ComplianceSignal, Venue
from app.seed_data import VENUES
from app.underwriting.scoring import get_risk_score, incident_delta_tracker


def _session():
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    s.add(Venue(id="nowadays", name="Nowadays"))
    s.commit()
    return s


def _add(session, n, provenance="underwriter_verified", severity="medium", status="open"):
    for i in range(n):
        session.add(ComplianceSignal(
            id=f"cs-{provenance}-{severity}-{status}-{i}", venue_id="nowadays",
            title="t", description="d", provenance=provenance, severity=severity, status=status,
        ))
    session.commit()


def test_compliance_factor_zero_signals_is_clean():
    incident_delta_tracker.reset()
    session = _session()
    result = get_risk_score("nowadays", VENUES, session=session)
    assert result["factors"]["compliance"]["score"] == 100


def test_compliance_factor_two_verified_open_is_about_49():
    incident_delta_tracker.reset()
    session = _session()
    _add(session, 2)
    result = get_risk_score("nowadays", VENUES, session=session)
    assert result["factors"]["compliance"]["score"] == 49


def test_compliance_factor_auto_generated_nudges():
    incident_delta_tracker.reset()
    session = _session()
    _add(session, 1, provenance="auto_generated", severity="urgent")
    result = get_risk_score("nowadays", VENUES, session=session)
    assert result["factors"]["compliance"]["score"] == 77


def test_compliance_factor_falls_back_to_step_without_session():
    incident_delta_tracker.reset()
    result = get_risk_score("nowadays", VENUES)
    assert result["factors"]["compliance"]["score"] == 40
