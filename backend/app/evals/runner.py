"""Eval harness — runs the agent pipeline against gold-standard scenarios.

Bridges the gold_standard.json shape (camera/POS event streams + ideal_output)
into the pipeline's expected inputs (IncidentCreate + stream_events list).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.agents.runtime import (
    UnderwritingPacketAgentResult,
    execute_underwriting_packet_agents,
)
from app.schemas import IncidentCreate

from app.evals import scorers
from app.evals.report import ScenarioResult, ScorerResult, write_markdown_report

GOLD_STANDARD_PATH = Path(__file__).resolve().parents[3] / "docs" / "evals" / "gold_standard.json"
RESULTS_DIR = Path(__file__).resolve().parent / "results"

EVAL_VENUE_ID = "eval-venue"
EVAL_VENUE: dict[str, Any] = {"id": EVAL_VENUE_ID, "name": "Eval Venue", "venue_type": "music venue and bar"}


def _label_from_payload(source_type: str, payload: dict) -> str:
    """Synthesize a human-readable label that retrieval can match against."""
    if source_type == "camera":
        bits: list[str] = []
        if "zone_id" in payload:
            bits.append(f"camera zone {payload['zone_id']}")
        if "aggression_score" in payload:
            bits.append(f"aggression score {payload['aggression_score']}")
        if "person_count" in payload:
            bits.append(f"{payload['person_count']} persons in zone")
        for det in payload.get("detections", []):
            bits.append(f"detection: {det.get('label','?')} conf {det.get('confidence','?')}")
        return "; ".join(bits) or "camera event"
    if source_type == "pos":
        items = payload.get("items", [])
        if items:
            parts = [f"{it.get('quantity','?')}x {it.get('name','?')}" for it in items]
            return "POS sale: " + ", ".join(parts)
        return f"POS transaction total {payload.get('total_amount','?')}"
    return f"{source_type} event"


def _scenario_to_stream_events(scenario: dict, venue_id: str) -> list[dict]:
    out: list[dict] = []
    for ev in scenario.get("input_events", []):
        label = _label_from_payload(ev.get("source_type", ""), ev.get("payload", {}))
        out.append(
            {
                "source_id": ev["event_id"],
                "venue_id": venue_id,
                "at": ev["timestamp"],
                "label": label,
                "text": label,
            }
        )
    return out


# Map scenario_id → (summary keywords, flags). Keywords drive retrieval +
# risk evaluator branching; flags drive severity escalation.
_SCENARIO_OVERRIDES: dict[str, dict[str, Any]] = {
    "SCENARIO-001-DELAYED-BRAWL": {
        "summary": "Physical brawl near rear bar with delayed security response and visible aggression",
        "location": "rear-bar",
        "injury_observed": True,
        "police_called": True,
        "ems_called": False,
    },
    "SCENARIO-002-AFTER-HOURS-LIQUOR": {
        "summary": "Liquor service of tequila shots continuing after legal cutoff time, dram shop exposure",
        "location": "main-bar",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-003-PROACTIVE-MITIGATION": {
        "summary": "Crowd management on dance floor with security present and proactive water distribution",
        "location": "dance-floor",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
}


def _scenario_to_incident(scenario: dict) -> IncidentCreate:
    override = _SCENARIO_OVERRIDES.get(scenario["scenario_id"], {})
    summary = override.get("summary", scenario.get("description", "incident"))
    location = override.get("location", "venue")
    occurred_at = scenario.get("input_events", [{}])[0].get(
        "timestamp", datetime.now(timezone.utc).isoformat()
    )
    return IncidentCreate(
        occurred_at=occurred_at,
        location=location,
        summary=summary,
        reported_by="eval-harness",
        injury_observed=bool(override.get("injury_observed", False)),
        police_called=bool(override.get("police_called", False)),
        ems_called=bool(override.get("ems_called", False)),
    )


@dataclass
class _RunOutput:
    scenario_id: str
    description: str
    actual: UnderwritingPacketAgentResult | None
    error: str | None = None
    scorer_results: list[ScorerResult] = field(default_factory=list)


def run_scenario(scenario: dict) -> _RunOutput:
    try:
        incident = _scenario_to_incident(scenario)
        stream_events = _scenario_to_stream_events(scenario, EVAL_VENUE_ID)
        actual = execute_underwriting_packet_agents(
            venue_id=EVAL_VENUE_ID,
            venue=EVAL_VENUE,
            incident=incident,
            knowledge_sources=[],
            stream_events=stream_events,
        )
        return _RunOutput(
            scenario_id=scenario["scenario_id"],
            description=scenario.get("description", ""),
            actual=actual,
        )
    except Exception as exc:
        return _RunOutput(
            scenario_id=scenario["scenario_id"],
            description=scenario.get("description", ""),
            actual=None,
            error=f"{exc.__class__.__name__}: {exc}",
        )


def run_all(gold_path: Path = GOLD_STANDARD_PATH) -> list[ScenarioResult]:
    scenarios = json.loads(gold_path.read_text(encoding="utf-8"))
    results: list[ScenarioResult] = []
    for scenario in scenarios:
        run = run_scenario(scenario)
        scorer_results: list[ScorerResult] = []
        if run.actual is not None:
            ideal = scenario["ideal_output"]
            scorer_results.append(scorers.score_structural(run.actual))
            scorer_results.append(scorers.score_severity_match(run.actual, ideal))
            scorer_results.append(scorers.score_citation_coverage(run.actual, ideal))
        results.append(
            ScenarioResult(
                scenario_id=run.scenario_id,
                description=run.description,
                error=run.error,
                scorers=scorer_results,
            )
        )
    return results


def main() -> int:
    RESULTS_DIR.mkdir(exist_ok=True)
    results = run_all()
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    report_path = RESULTS_DIR / f"{timestamp}.md"
    write_markdown_report(results, report_path, timestamp=timestamp)
    print(f"Wrote {report_path}")
    passed = sum(1 for r in results if r.passed)
    print(f"Aggregate: {passed}/{len(results)} scenarios passed all scorers")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
