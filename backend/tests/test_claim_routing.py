from app.claim_recommendation import (
    ClaimRecommendation, PayoutRange, PremiumImpact,
)
from app.claim_routing import route_status, should_auto_route


def _rec(*, should_file: bool, confidence: float) -> ClaimRecommendation:
    return ClaimRecommendation(
        should_file=should_file,
        probability=0.6,
        expected_payout=PayoutRange(1, 2, 3),
        expected_premium_impact=PremiumImpact(1, 3, 3),
        net_expected_value_usd=100,
        reasons=[],
        confidence=confidence,
    )


def test_auto_routed_when_should_file_and_high_confidence():
    assert route_status(_rec(should_file=True, confidence=0.81)) == "auto_routed"
    assert should_auto_route(_rec(should_file=True, confidence=0.81)) is True


def test_confident_dont_file_is_not_routed():
    assert route_status(_rec(should_file=False, confidence=0.9)) == "not_routed"
    assert should_auto_route(_rec(should_file=False, confidence=0.9)) is False


def test_borderline_band_prompts_operator():
    assert route_status(_rec(should_file=True, confidence=0.55)) == "borderline"
    assert route_status(_rec(should_file=False, confidence=0.55)) == "borderline"
    assert should_auto_route(_rec(should_file=True, confidence=0.55)) is False


def test_below_floor_is_not_routed():
    assert route_status(_rec(should_file=True, confidence=0.30)) == "not_routed"
