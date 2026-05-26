"""Tests for the operational-data scoring hook in app/underwriting/scoring.py.

Ingested operational signals (over-pour, id-rejection, occupancy, staffing)
apply bounded, explained penalties to the operational factor — and a venue
with no operational_data scores exactly as before (backward compatible).
"""
from app.underwriting.scoring import RiskScoringEngine, get_risk_score


def _op_score(venue: dict) -> int:
    return RiskScoringEngine({"v": venue})._score_operational(venue)


def test_no_operational_data_is_unchanged():
    # medium security baseline = 70, no operational_data → exactly 70
    assert _op_score({"security_level": "medium"}) == 70
    assert _op_score({"security_level": "high"}) == 100
    assert _op_score({"security_level": "low"}) == 40


def test_over_pour_penalizes_operational_score():
    base = {"security_level": "medium"}
    worse = {"security_level": "medium", "operational_data": {"over_pour_rate": 0.5}}
    assert _op_score(worse) < _op_score(base)
    assert _op_score(worse) == 50  # 70 - round(0.5 * 40)


def test_staffing_shortfall_penalizes():
    v = {"security_level": "medium", "operational_data": {"staffing_ratio": 0.5}}
    assert _op_score(v) == 55  # 70 - round((1 - 0.5) * 30)


def test_overcapacity_penalizes_only_above_one():
    over = {"security_level": "medium", "operational_data": {"occupancy_ratio": 1.4}}
    under = {"security_level": "medium", "operational_data": {"occupancy_ratio": 0.8}}
    assert _op_score(over) == 50   # 70 - round(0.4 * 50)
    assert _op_score(under) == 70  # at/under capacity → no penalty


def test_id_rejection_penalizes():
    v = {"security_level": "medium", "operational_data": {"id_rejection_rate": 0.2}}
    assert _op_score(v) == 64  # 70 - round(0.2 * 30)


def test_penalties_clamp_at_zero():
    v = {
        "security_level": "low",
        "operational_data": {
            "over_pour_rate": 1.0,
            "id_rejection_rate": 1.0,
            "occupancy_ratio": 2.0,
            "staffing_ratio": 0.0,
        },
    }
    assert _op_score(v) == 0


def test_full_score_drops_and_surfaces_adjustments():
    venue = {
        "incident_count": 0,
        "compliance_items": 0,
        "security_level": "high",
        "years_in_operation": 10,
        "venue_type": "club",
    }
    clean = get_risk_score("v", {"v": dict(venue)})
    ingested = dict(venue)
    ingested["operational_data"] = {"over_pour_rate": 0.8, "id_rejection_rate": 0.5}
    moved = get_risk_score("v", {"v": ingested})

    assert moved["total_score"] < clean["total_score"]
    # the why is visible in the factors breakdown
    adj = moved["factors"]["operational"]["adjustments"]
    assert "over_pour" in adj and adj["over_pour"] < 0
    # clean venue has no adjustments key
    assert "adjustments" not in clean["factors"]["operational"]
