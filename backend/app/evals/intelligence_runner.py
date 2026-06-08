"""Run the intelligence gold scenarios, score them, build a baseline-shaped
snapshot, and (optionally) gate against the committed baseline.

Run:  cd backend && python -m app.evals.intelligence_runner --compare-baseline
Update baseline after a real improvement:
      cd backend && python -m app.evals.intelligence_runner --update-baseline
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.evals.baseline import compare_to_baseline, load_baseline, write_baseline
from app.evals.intelligence_scenarios import SCENARIOS, NOW
from app.evals.intelligence_scorers import (
    findings_recall, false_alarm_rate, severity_match,
)
from app.intelligence.engine import compute_exposure

STACK_SIGNATURE = "intelligence=deterministic-v1"
BASELINE_PATH = Path(__file__).resolve().parent / "intelligence_baseline.json"


def run_scenarios() -> list[dict]:
    results = []
    for make in SCENARIOS:
        sc = make()
        findings = compute_exposure(sc["user"], sc["session"], now=NOW)
        produced_ids = {f.id for f in findings}
        produced_sev = {f.id: f.severity for f in findings}
        results.append({
            "name": sc["name"],
            "findings_recall": findings_recall(sc["expected_ids"], produced_ids),
            "false_alarm_rate": false_alarm_rate(sc["expected_ids"], produced_ids),
            "severity_match": severity_match(sc["expected_severity"], produced_sev),
        })
        sc["session"].close()
    return results


def _scorer_pass(name: str, value: float) -> bool:
    if name == "false_alarm_rate":
        return value <= 1e-9
    return value >= 1.0 - 1e-9


def build_snapshot(results: list[dict]) -> dict:
    scorer_names = ["findings_recall", "false_alarm_rate", "severity_match"]
    scorer_averages = []
    all_pass = []
    for name in scorer_names:
        passes = [_scorer_pass(name, r[name]) for r in results]
        rate = sum(1 for p in passes if p) / len(passes) if passes else 1.0
        scorer_averages.append({"name": name, "pass_rate": rate})
        all_pass.extend(passes)
    aggregate = sum(1 for p in all_pass if p) / len(all_pass) if all_pass else 1.0
    return {
        "stack_signature": STACK_SIGNATURE,
        "aggregate": {"pass_rate": aggregate},
        "scorer_averages": scorer_averages,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare-baseline", action="store_true")
    parser.add_argument("--update-baseline", action="store_true")
    args = parser.parse_args(argv)

    snapshot = build_snapshot(run_scenarios())
    for line in (
        f"aggregate pass rate: {snapshot['aggregate']['pass_rate']:.0%}",
        *[f"  {s['name']}: {s['pass_rate']:.0%}" for s in snapshot["scorer_averages"]],
    ):
        print(line)

    if args.update_baseline:
        write_baseline(snapshot, BASELINE_PATH, signature=STACK_SIGNATURE)
        print(f"baseline updated at {BASELINE_PATH}")
        return 0

    if args.compare_baseline:
        baseline = (load_baseline(BASELINE_PATH) or {}).get(STACK_SIGNATURE)
        if baseline is None:
            print("FAIL no baseline for stack signature; run --update-baseline")
            return 1
        diff = compare_to_baseline(snapshot, baseline)
        for line in diff.summary_lines():
            print(line)
        return 1 if diff.regressed else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
