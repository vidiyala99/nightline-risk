"""Run the copilot gold scenarios, score them, build a baseline-shaped
snapshot, and (optionally) gate against the committed baseline (spec §8).

Mirrors ``app/evals/intelligence_runner.py``: the deterministic provider runs
keylessly over the gold scenarios so the run is reproducible in CI, and a
``--compare-baseline`` gate fails only on a REGRESSION from the committed
``copilot_baseline.json``.

Run:  cd backend && python -m app.evals.copilot_runner --compare-baseline
Update baseline after a real improvement:
      cd backend && python -m app.evals.copilot_runner --update-baseline

Per-scenario scoring, by axis:
  - ``intent_routing_accuracy`` is applied ONLY to ``axis=="read"`` scenarios
    (``_classify`` of an action message can route to a read tool, which would
    be a false miss); for non-read axes it's not-applicable and excluded from
    that scorer's denominator.
  - ``faithfulness`` grounds the reply against the tool_results that produced
    it (for a read reply, re-run the routed read tool) AND against the reply's
    own citations — a cited number (e.g. a propose-action quoting the
    recommendation's net-EV figure) counts as supported.
  - ``refusal_correctness`` / ``action_appropriateness`` score every scenario.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.copilot.engine import respond_to_message
from app.copilot.provider import _classify
from app.copilot.schemas import ToolResult
from app.copilot.tools import TOOL_CATALOG, CopilotScope
from app.evals.baseline import compare_to_baseline, load_baseline, write_baseline
from app.evals.copilot_scenarios import NOW, SCENARIOS
from app.evals.copilot_scorers import (
    action_appropriateness,
    faithfulness_score,
    intent_routing_accuracy,
    refusal_correctness,
)
from app.intelligence.engine import accessible_venue_ids

STACK_SIGNATURE = "copilot=deterministic-v1"
BASELINE_PATH = Path(__file__).resolve().parent / "copilot_baseline.json"

_READ_TOOLS = {t.name for t in TOOL_CATALOG if t.kind == "read"}
_TOOL_BY_NAME = {t.name: t for t in TOOL_CATALOG}

# Sentinel for "this scorer does not apply to this scenario" — excluded from
# that scorer's pass-rate denominator in build_snapshot.
_NA = None


def run_scenarios() -> list[dict]:
    results: list[dict] = []
    for make in SCENARIOS:
        sc = make()
        scope = CopilotScope(
            user=sc["user"],
            venue_ids=accessible_venue_ids(sc["user"], sc["session"]),
            session=sc["session"],
            now=NOW,
        )

        actual = _classify(sc["message"])
        reply = respond_to_message(
            sc["user"], sc["session"], sc["message"],
            confirm_action=sc.get("confirm_action"), now=NOW,
        )

        # intent_routing applies only to read scenarios.
        if sc["axis"] == "read":
            routing = intent_routing_accuracy(expected=sc["expected_tool"], actual=actual)
        else:
            routing = _NA

        # faithfulness: ground a read reply against its routed tool's result, AND
        # ground every reply against its OWN citations — a number the reply cites
        # (e.g. a propose-action quoting the recommendation's net-EV figure) is
        # supported, not a guess.
        if sc["axis"] == "read" and actual in _READ_TOOLS:
            tool_results = [_TOOL_BY_NAME[actual].run(scope, {})]
        else:
            tool_results = []
        tool_results = tool_results + [ToolResult(tool="_reply_citations", citations=list(reply.citations))]
        faithfulness = faithfulness_score(reply, tool_results)

        results.append({
            "name": sc["name"],
            "intent_routing_accuracy": routing,
            "faithfulness": faithfulness,
            "refusal_correctness": refusal_correctness(
                should_refuse=sc["should_refuse"], reply=reply),
            "action_appropriateness": action_appropriateness(
                should_propose=sc["should_propose"], reply=reply),
        })
        sc["session"].close()
    return results


def build_snapshot(results: list[dict]) -> dict:
    scorer_names = [
        "intent_routing_accuracy", "faithfulness",
        "refusal_correctness", "action_appropriateness",
    ]
    scorer_averages = []
    all_pass: list[bool] = []
    for name in scorer_names:
        # Exclude not-applicable (None) scenarios from this scorer's denominator.
        passes = [r[name] >= 1.0 - 1e-9 for r in results if r[name] is not _NA]
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
