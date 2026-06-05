import os
import pytest
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
