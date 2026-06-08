from app.evals.intelligence_runner import run_scenarios, build_snapshot
from app.evals.intelligence_scorers import false_alarm_rate, findings_recall


def test_findings_recall_and_false_alarm():
    expected = {"evidence_gap:incident:inc-1"}
    produced = {"evidence_gap:incident:inc-1", "evidence_gap:incident:inc-2"}
    assert findings_recall(expected, produced) == 1.0
    assert false_alarm_rate(expected, produced) == 0.5


def test_run_scenarios_meets_committed_baseline():
    results = run_scenarios()
    snapshot = build_snapshot(results)
    assert snapshot["aggregate"]["pass_rate"] == 1.0
    names = {s["name"] for s in snapshot["scorer_averages"]}
    assert {"findings_recall", "false_alarm_rate", "severity_match"} <= names
