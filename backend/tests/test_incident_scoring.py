from app.underwriting.scoring import _incident_weight, RiskScoringEngine


def _score(load):
    eng = RiskScoringEngine({"v": {"incident_load": load}})
    return eng._score_incident_history({"incident_load": load})


def test_incident_weight_minor_open():
    assert _incident_weight(injury=False, police=False, ems=False, status="open") == 1.0

def test_incident_weight_full_severity_open():
    assert _incident_weight(injury=True, police=True, ems=True, status="open") == 2.5

def test_incident_weight_resolved_is_discounted():
    assert _incident_weight(injury=False, police=False, ems=False, status="closed") == 0.4

def test_incident_weight_closed_archived_is_discounted():
    assert _incident_weight(injury=False, police=False, ems=False, status="closed_archived") == 0.4

def test_under_review_counts_as_active():
    assert _incident_weight(injury=False, police=False, ems=False, status="under_review") == 1.0

def test_curve_reference_points():
    assert _score(0) == 100
    assert _score(1.0) == 89
    assert _score(2.5) == 76
    assert _score(25) == 6

def test_closing_an_incident_raises_score():
    open_load = _incident_weight(injury=False, police=False, ems=False, status="open")
    closed_load = _incident_weight(injury=False, police=False, ems=False, status="closed")
    assert _score(closed_load) > _score(open_load)

def test_curve_monotonic_non_increasing():
    scores = [_score(l) for l in [0, 1, 2, 5, 10, 20, 40]]
    assert scores == sorted(scores, reverse=True)

def test_curve_never_negative_or_over_100():
    assert _score(1000) >= 0
    assert _score(0) <= 100

def test_curve_deterministic():
    assert _score(7.3) == _score(7.3)

def test_falls_back_to_incident_count_when_no_load():
    eng = RiskScoringEngine({"v": {"incident_count": 2}})
    assert eng._score_incident_history({"incident_count": 2}) == 80


from sqlmodel import SQLModel, Session, create_engine
from app.models import IncidentRecord
from app.seed_data import VENUES
from app.underwriting.scoring import get_risk_score, incident_delta_tracker


def _session_with(rows):
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    for i, r in enumerate(rows):
        s.add(IncidentRecord(
            id=f"t{i}", venue_id="elsewhere-brooklyn",
            occurred_at="2026-01-01T00:00:00", location="x",
            summary="x", reported_by="t",
            injury_observed=r.get("injury", False),
            police_called=r.get("police", False),
            ems_called=r.get("ems", False),
            status=r.get("status", "open"),
        ))
    s.commit()
    return s


def _safety(result):
    return result["factors"]["incident_history"]["score"]


def test_live_load_one_minor_open_incident():
    incident_delta_tracker.reset()
    s = _session_with([{}])
    assert _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=s)) == 89


def test_live_load_resolved_scores_higher_than_open():
    incident_delta_tracker.reset()
    open_s = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"status": "open"}])))
    closed_s = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"status": "closed"}])))
    assert closed_s > open_s


def test_live_load_severity_lowers_score():
    incident_delta_tracker.reset()
    minor = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{}])))
    severe = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"injury": True, "police": True, "ems": True}])))
    assert severe < minor


def test_live_zero_rows_is_clean():
    incident_delta_tracker.reset()
    assert _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([]))) == 100
