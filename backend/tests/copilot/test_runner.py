from app.evals.copilot_runner import run_scenarios, build_snapshot


def test_runner_scores_every_scenario_and_builds_snapshot():
    results = run_scenarios()
    assert len(results) >= 8
    snap = build_snapshot(results)
    assert "aggregate" in snap and 0.0 <= snap["aggregate"]["pass_rate"] <= 1.0
    assert {s["name"] for s in snap["scorer_averages"]} == {
        "intent_routing_accuracy", "faithfulness", "refusal_correctness", "action_appropriateness"}
