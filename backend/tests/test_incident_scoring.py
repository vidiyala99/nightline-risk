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


from datetime import datetime, timezone

from sqlmodel import SQLModel, Session, create_engine
from app.models import IncidentRecord
from app.seed_data import VENUES
from app.underwriting.scoring import (
    get_risk_score,
    incident_delta_tracker,
    _effective_incident_load,
    _recency_factor,
)

# Pin "now" to the fixture's occurred_at so the recency-decayed safety factor is
# deterministic (age 0 → recency 1.0 → load == raw weight). Without this the
# score would drift with the wall clock as the fixture incident ages.
_FIXTURE_DATE = "2026-01-01T00:00:00"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _session_with(rows):
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    for i, r in enumerate(rows):
        s.add(IncidentRecord(
            id=f"t{i}", venue_id="elsewhere-brooklyn",
            occurred_at=r.get("occurred_at", _FIXTURE_DATE), location="x",
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
    assert _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=s, now=_NOW)) == 89


def test_live_load_resolved_scores_higher_than_open():
    incident_delta_tracker.reset()
    open_s = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"status": "open"}]), now=_NOW))
    closed_s = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"status": "closed"}]), now=_NOW))
    assert closed_s > open_s


def test_live_load_severity_lowers_score():
    incident_delta_tracker.reset()
    minor = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{}]), now=_NOW))
    severe = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([{"injury": True, "police": True, "ems": True}]), now=_NOW))
    assert severe < minor


def test_live_zero_rows_is_clean():
    incident_delta_tracker.reset()
    assert _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=_session_with([]), now=_NOW)) == 100


# ── Recency decay ──────────────────────────────────────────────────────────

def test_recency_factor_halves_at_one_year():
    one_year_later = datetime(2027, 1, 1, tzinfo=timezone.utc)
    assert abs(_recency_factor(_FIXTURE_DATE, one_year_later) - 0.5) < 0.01

def test_recency_factor_missing_date_is_full_weight():
    assert _recency_factor(None, _NOW) == 1.0

def test_recency_old_open_incident_scores_higher_than_fresh():
    """Same row, evaluated a year apart: the older it is, the less it drags the
    score — the load decays even while the incident stays open."""
    incident_delta_tracker.reset()
    s = _session_with([{}])
    fresh = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=s, now=_NOW))
    aged = _safety(get_risk_score("elsewhere-brooklyn", VENUES, session=s, now=datetime(2027, 1, 1, tzinfo=timezone.utc)))
    assert aged > fresh


# ── Exposure normalization ─────────────────────────────────────────────────

def test_exposure_large_venue_carries_lower_load():
    """Identical incident history: the higher-capacity venue normalizes to a
    lower effective load (more exposure absorbs a given raw count)."""
    rows = [(False, False, False, "open", _FIXTURE_DATE)] * 5
    small = _effective_incident_load(rows, capacity=200, now=_NOW)
    large = _effective_incident_load(rows, capacity=5000, now=_NOW)
    assert large < small

def test_exposure_missing_capacity_is_unnormalized():
    rows = [(False, False, False, "open", _FIXTURE_DATE)] * 3
    assert _effective_incident_load(rows, capacity=None, now=_NOW) == 3.0
