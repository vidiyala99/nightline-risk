from app.agents.fraud_agent import FraudFlag, FraudSignal, tier_for_score


def test_tier_boundaries_use_env_defaults():
    assert tier_for_score(0.0) == "none"
    assert tier_for_score(0.09) == "none"
    assert tier_for_score(0.10) == "low"
    assert tier_for_score(0.29) == "low"
    assert tier_for_score(0.30) == "elevated"
    assert tier_for_score(0.54) == "elevated"
    assert tier_for_score(0.55) == "high"
    assert tier_for_score(1.0) == "high"


def test_fraud_signal_to_dict_is_json_shaped():
    sig = FraudSignal(
        score=0.4,
        tier="elevated",
        red_flags=[FraudFlag("FRAUD_X", "X", 0.4, "because")],
        summary="s",
        assessed_stage="v1",
    )
    d = sig.to_dict()
    assert d["score"] == 0.4
    assert d["tier"] == "elevated"
    assert d["red_flags"] == [{"code": "FRAUD_X", "label": "X", "weight": 0.4, "detail": "because"}]
    assert d["assessed_stage"] == "v1"


from datetime import datetime, timezone
from app.agents.fraud_agent import assess_fraud

CLEAN_INCIDENT = {
    "occurred_at": "2026-05-01T22:00:00Z",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def _codes(sig):
    return {f.code for f in sig.red_flags}


def test_clean_incident_scores_none():
    sig = assess_fraud(
        risk_signal={"severity": "low"},
        incident=CLEAN_INCIDENT,
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        evidence_file_count=2,
    )
    assert sig.assessed_stage == "v1"
    assert sig.tier == "none"
    assert sig.red_flags == []


def test_late_report_graduates_and_does_not_double_count():
    sig = assess_fraud(
        risk_signal={"severity": "low"},
        incident={**CLEAN_INCIDENT, "occurred_at": "2026-05-01T00:00:00Z"},
        reported_at=datetime(2026, 5, 10, 0, 0, tzinfo=timezone.utc),  # 9 days
        prior_claim_count=0,
        evidence_file_count=1,
    )
    late = [f for f in sig.red_flags if f.code == "FRAUD_LATE_REPORT"]
    assert len(late) == 1
    assert late[0].weight == 0.25


def test_frequency_and_unverified_injury_combine():
    sig = assess_fraud(
        risk_signal={"severity": "high"},
        incident={**CLEAN_INCIDENT, "injury_observed": True},
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=5,
        evidence_file_count=1,
    )
    assert _codes(sig) == {"FRAUD_FREQUENCY", "FRAUD_UNVERIFIED_INJURY"}
    assert sig.score == 0.40  # 0.25 + 0.15
    assert sig.tier == "elevated"


def test_v1_never_emits_evidence_flags():
    sig = assess_fraud(
        risk_signal={"severity": "high"},
        incident=CLEAN_INCIDENT,
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        evidence_file_count=0,  # zero files at v1 must NOT trip FRAUD_NO_EVIDENCE
    )
    assert "FRAUD_NO_EVIDENCE" not in _codes(sig)
