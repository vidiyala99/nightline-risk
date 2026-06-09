from app.evals.copilot_scenarios import SCENARIOS


def test_scenarios_cover_every_axis():
    axes = {s()["axis"] for s in SCENARIOS}
    assert {"read", "refuse", "action_ok", "action_blocked"} <= axes
    assert len(SCENARIOS) >= 8


def test_each_scenario_has_a_live_session():
    for make in SCENARIOS:
        sc = make()
        assert sc["session"] is not None
        assert sc["user"].get("role") == "venue_operator"
        sc["session"].close()
