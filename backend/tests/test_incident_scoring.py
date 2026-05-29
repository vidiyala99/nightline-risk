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
