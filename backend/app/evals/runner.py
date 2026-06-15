"""Eval harness — runs the agent pipeline against gold-standard scenarios.

Bridges the gold_standard.json shape (camera/POS event streams + ideal_output)
into the pipeline's expected inputs (IncidentCreate + stream_events list).

Provider selection:
  --provider stub | gemini | anthropic | auto   (default: stub)
  EVAL_PROVIDER=...                              (env-var fallback)

`stub` uses DeterministicProvider regardless of env keys; `auto` defers to
get_default_provider() (whichever API key is set). LLM modes will raise
ProviderNotConfiguredError if the corresponding key is absent.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.agents.runtime import (
    UnderwritingPacketAgentResult,
    UnderwritingPacketAgentRuntime,
)
from app.providers import (
    AnthropicProvider,
    AnthropicRiskClassifier,
    DeterministicProvider,
    DeterministicRiskClassifier,
    GeminiProvider,
    GeminiRiskClassifier,
    GrokProvider,
    GrokRiskClassifier,
    MemoProvider,
    RiskClassifierProvider,
    get_default_provider,
    get_default_risk_classifier,
)
from app.providers.anthropic_provider import ProviderNotConfiguredError
from app.schemas import IncidentCreate

from app.evals import retrieval_scorers, safety_scorers, scorers
from app.evals.baseline import (
    BASELINE_PATH,
    compare_to_baseline,
    load_baseline_for_stack,
    write_baseline,
)
from app.evals.report import (
    ProviderInfo,
    ScenarioResult,
    ScorerResult,
    snapshot_payload,
    write_json_snapshot,
    write_markdown_report,
)

GOLD_STANDARD_PATH = Path(__file__).resolve().parents[3] / "docs" / "evals" / "gold_standard.json"
ADVERSARIAL_GOLD_PATH = Path(__file__).resolve().parents[3] / "docs" / "evals" / "adversarial_gold.json"
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
    "SCENARIO-004-BOUNCER-EXCESSIVE-FORCE": {
        "summary": "Security guard used physical force ejecting a patron, patron alleges shoulder injury, police arrived",
        "location": "main-bar",
        "injury_observed": True,
        "police_called": True,
        "ems_called": False,
    },
    "SCENARIO-005-VISIBLY-INTOXICATED-SERVICE": {
        "summary": "Bartender continued serving visibly intoxicated patron multiple drinks despite slurred speech and stumbling",
        "location": "main-bar",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-006-WET-STAIRWELL": {
        "summary": "Patron slipped and fell on wet stairs in main stairwell with no wet-floor signage during a busy event",
        "location": "main-stairwell",
        "injury_observed": True,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-007-OVERDOSE-DELAYED-EMS": {
        "summary": "Patron found unresponsive in backstage corridor, staff delayed calling EMS for several minutes after detection",
        "location": "backstage-corridor",
        "injury_observed": True,
        "police_called": False,
        "ems_called": True,
    },
    "SCENARIO-008-BYSTANDER-INJURY": {
        "summary": "Patrons in physical fight on main floor, third-party bystander struck by debris and sustained head injury, EMS called",
        "location": "main-floor",
        "injury_observed": True,
        "police_called": True,
        "ems_called": True,
    },
    "SCENARIO-009-UNDERAGE-SERVICE": {
        "summary": "Bartender served draft beer to a patron whose wristband was issued without an ID scan, dram shop and license compliance exposure",
        "location": "front-entrance",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-010-MOSH-PIT-INJURY": {
        "summary": "Patron injured at pit barrier during mosh-pit crowd surge with inadequate security staffing ratio",
        "location": "pit-barrier",
        "injury_observed": True,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-011-PARKING-LOT-VALENTINE": {
        "summary": "Patron assaulted in venue parking lot off-premises, venue advertises lot security, no security staff present in zone",
        "location": "parking-lot",
        "injury_observed": True,
        "police_called": True,
        "ems_called": False,
    },
    "SCENARIO-012-CAPACITY-CREEP-SLIP": {
        "summary": "Patron slipped and fell in main corridor with documented overcapacity, 250 patrons in zone exceeding posted limit",
        "location": "main-corridor",
        "injury_observed": True,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-013-ALLERGIC-REACTION-DELAYED": {
        "summary": "Patron showed acute respiratory distress consistent with allergic reaction at main bar, staff delayed calling EMS for several minutes",
        "location": "main-bar",
        "injury_observed": True,
        "police_called": False,
        "ems_called": True,
    },
    "SCENARIO-014-KITCHEN-FIRE-CONTAINED": {
        "summary": "Small kitchen fire behind the line, staff deployed extinguisher within 30 seconds, no evacuation required, no injuries reported",
        "location": "kitchen",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
    "SCENARIO-015-FORESEEABLE-THIRD-PARTY": {
        "summary": "Patron physically assaulted at rear exit, three prior similar assaults documented in 60 days, no security staff detected in zone",
        "location": "rear-exit",
        "injury_observed": True,
        "police_called": True,
        "ems_called": False,
    },
}


def _scenario_to_incident(scenario: dict) -> IncidentCreate:
    # Adversarial scenarios carry an `incident_override` block inline (the
    # standard 15 use the module-level _SCENARIO_OVERRIDES table). Inline
    # wins when present so adversarial scenarios are self-contained.
    inline = scenario.get("incident_override") or {}
    table = _SCENARIO_OVERRIDES.get(scenario["scenario_id"], {})
    override = {**table, **inline}

    summary = override.get("summary", scenario.get("description", "incident"))
    location = override.get("location", "venue")
    events = scenario.get("input_events", [])
    occurred_at = (
        events[0]["timestamp"] if events else datetime.now(timezone.utc).isoformat()
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


_PROVIDER_ALIASES = {
    "stub": "stub",
    "deterministic": "stub",
    "gemini": "gemini",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "grok": "grok",
    "xai": "grok",
    "auto": "auto",
}


def resolve_provider(name: str | None) -> MemoProvider:
    """Map a CLI/env provider name to a concrete MemoProvider instance.

    Raises ValueError for unknown names and ProviderNotConfiguredError when an
    LLM provider is requested without the corresponding API key.
    """
    raw = (name or "stub").lower()
    canonical = _PROVIDER_ALIASES.get(raw)
    if canonical is None:
        raise ValueError(
            f"Unknown provider {name!r}. Use one of: stub, gemini, anthropic, grok, auto."
        )
    if canonical == "stub":
        return DeterministicProvider()
    if canonical == "gemini":
        return GeminiProvider()
    if canonical == "anthropic":
        return AnthropicProvider()
    if canonical == "grok":
        return GrokProvider()
    if canonical == "auto":
        return get_default_provider()
    # Unreachable but keeps mypy happy
    raise ValueError(f"Unhandled provider {name!r}")


def resolve_risk_provider(name: str | None) -> RiskClassifierProvider:
    """Map a CLI/env name to a concrete RiskClassifierProvider.

    Mirrors `resolve_provider`'s aliasing — same vocabulary, different class
    hierarchy. Kept as a sibling rather than a generic dispatch because the
    two provider hierarchies don't share a constructor signature and the
    aliasing logic is small enough that duplication is clearer than abstraction.
    """
    raw = (name or "stub").lower()
    canonical = _PROVIDER_ALIASES.get(raw)
    if canonical is None:
        raise ValueError(
            f"Unknown risk provider {name!r}. Use one of: stub, gemini, anthropic, grok, auto."
        )
    if canonical == "stub":
        return DeterministicRiskClassifier()
    if canonical == "gemini":
        return GeminiRiskClassifier()
    if canonical == "anthropic":
        return AnthropicRiskClassifier()
    if canonical == "grok":
        return GrokRiskClassifier()
    if canonical == "auto":
        return get_default_risk_classifier()
    raise ValueError(f"Unhandled risk provider {name!r}")


def _provider_info(provider: MemoProvider) -> ProviderInfo:
    name = provider.provider_name
    model = name.split("/", 1)[1] if "/" in name else None
    return ProviderInfo(name=name, mode=provider.mode.value, model=model)


def _risk_info(provider: RiskClassifierProvider) -> ProviderInfo:
    """Same shape as memo provider info, derived from risk-classifier surface.

    RiskClassifierProvider exposes provider_name and mode just like MemoProvider
    (deterministic / llm). We reuse ProviderInfo so the snapshot JSON treats
    both surfaces uniformly.
    """
    name = provider.provider_name
    model = name.split("/", 1)[1] if "/" in name else None
    return ProviderInfo(name=name, mode=provider.mode.value, model=model)


def _build_memo_judge():
    """Return a (summary, citations, risk_signal) -> FaithfulnessVerdict callable,
    or None when no judge LLM is configured (keyless CI lane). Opt-in: only fires
    when LLM_API_KEY is set, so the deterministic baseline never expects it.
    """
    if not os.getenv("LLM_API_KEY"):
        return None
    from app.providers.grok_provider import _client, DEFAULT_BASE_URL, DEFAULT_MODEL
    from app.evals.judge import judge_memo_faithfulness

    api_key = os.getenv("LLM_API_KEY")
    base_url = (os.getenv("LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("LLM_MODEL") or DEFAULT_MODEL
    client = _client(api_key, base_url)

    def judge(summary, citations, risk_signal):
        return judge_memo_faithfulness(
            summary=summary, citations=citations, risk_signal=risk_signal,
            client=client, model=model,
        )

    return judge


def stack_signature(memo: ProviderInfo, risk: ProviderInfo) -> str:
    """Canonical key for baseline storage.

    Two stacks with the same (memo_name, risk_name) share a baseline. Format
    is deliberately short and human-readable so PR diffs of baseline.json are
    legible: `memo=deterministic-v1;risk=deterministic-v1`.
    """
    return f"memo={memo.name};risk={risk.name}"


def run_scenario(scenario: dict, runtime: UnderwritingPacketAgentRuntime) -> _RunOutput:
    try:
        incident = _scenario_to_incident(scenario)
        stream_events = _scenario_to_stream_events(scenario, EVAL_VENUE_ID)
        actual = runtime.execute(
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


def _load_scenarios(
    gold_path: Path, adversarial_path: Path | None
) -> list[dict]:
    """Load and concatenate standard + adversarial gold scenarios.

    Adversarial file is optional — if missing, only the standard set runs.
    This preserves backwards compatibility for forks/branches without the
    adversarial_gold.json file yet.
    """
    scenarios = json.loads(gold_path.read_text(encoding="utf-8"))
    if adversarial_path is not None and adversarial_path.exists():
        adversarial = json.loads(adversarial_path.read_text(encoding="utf-8"))
        scenarios.extend(adversarial)
    return scenarios


def _score_standard_scenario(
    run: _RunOutput, scenario: dict, *, memo_provider_mode: str, judge=None
) -> list[ScorerResult]:
    """Apply the standard scorer suite (severity, citations, retrieval)."""
    ideal = scenario["ideal_output"]
    results: list[ScorerResult] = []
    results.append(scorers.score_structural(run.actual))
    results.append(scorers.score_severity_match(run.actual, ideal))
    results.append(scorers.score_citation_coverage(run.actual, ideal))
    results.append(scorers.score_review_status_match(run.actual, ideal))
    results.append(
        scorers.score_factor_recognition(
            run.actual, ideal, provider_mode=memo_provider_mode
        )
    )
    # Retrieval-quality scorers — measure citation *ranking* alongside
    # citation presence. NDCG@5 catches the failure mode where the right
    # evidence is surfaced but buried at position 8 of 10.
    results.append(retrieval_scorers.score_ndcg_at_k(run.actual, ideal))
    results.append(retrieval_scorers.score_mrr(run.actual, ideal))
    # Opt-in LLM-as-judge: only present when a judge LLM is configured. Abstains
    # (skips) on error so a transient judge hiccup never blocks the eval.
    if judge is not None:
        try:
            results.append(scorers.score_memo_faithfulness(run.actual, ideal, judge=judge))
        except Exception:
            pass
    return results


def _score_adversarial_scenario(
    run: _RunOutput, scenario: dict
) -> list[ScorerResult]:
    """Apply structural + selected safety scorers.

    Each adversarial scenario lists its applicable safety scorers in
    `safety_scorers`; we run those plus the universally-applicable
    `structural` check. Severity/citation-coverage scorers don't apply
    because the adversarial gold doesn't carry a "correct" risk_level —
    the question is whether the agent stayed safe, not whether it
    matched a (meaningless) target.
    """
    results: list[ScorerResult] = [scorers.score_structural(run.actual)]
    ideal = scenario.get("safety_expectation") or {}
    # Wrap the safety expectation so the scorer signature (actual, ideal)
    # works unchanged — each scorer pulls its own keys out of the dict.
    ideal_wrapped: dict = {"safety_expectation": ideal}
    requested = scenario.get("safety_scorers") or list(safety_scorers.ADVERSARIAL_SCORERS.keys())
    for name in requested:
        scorer = safety_scorers.ADVERSARIAL_SCORERS.get(name)
        if scorer is None:
            continue  # unknown scorer name in gold — skip silently
        results.append(scorer(run.actual, ideal_wrapped))
    return results


def run_all(
    runtime: UnderwritingPacketAgentRuntime,
    gold_path: Path = GOLD_STANDARD_PATH,
    *,
    adversarial_path: Path | None = ADVERSARIAL_GOLD_PATH,
    memo_provider_mode: str = "deterministic",
    judge=None,
) -> list[ScenarioResult]:
    scenarios = _load_scenarios(gold_path, adversarial_path)
    results: list[ScenarioResult] = []
    for scenario in scenarios:
        run = run_scenario(scenario, runtime)
        scorer_results: list[ScorerResult] = []
        if run.actual is not None:
            if scenario.get("scenario_type") == "adversarial":
                scorer_results = _score_adversarial_scenario(run, scenario)
            else:
                scorer_results = _score_standard_scenario(
                    run, scenario, memo_provider_mode=memo_provider_mode, judge=judge
                )
        results.append(
            ScenarioResult(
                scenario_id=run.scenario_id,
                description=run.description,
                exposure_class=scenario.get("exposure_class", ""),
                difficulty=scenario.get("difficulty", ""),
                scenario_type=scenario.get("scenario_type", ""),
                error=run.error,
                scorers=scorer_results,
            )
        )
    return results


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="app.evals.runner",
        description="Run the agent eval set against a chosen provider.",
    )
    parser.add_argument(
        "--provider",
        default=os.getenv("EVAL_PROVIDER", "stub"),
        help="memo provider: stub | gemini | anthropic | auto (default: stub; env: EVAL_PROVIDER)",
    )
    parser.add_argument(
        "--risk-provider",
        default=os.getenv("EVAL_RISK_PROVIDER", "stub"),
        help=(
            "risk-classifier provider: stub | gemini | anthropic | auto "
            "(default: stub; env: EVAL_RISK_PROVIDER). Exercises the "
            "pluggable risk classifier added in commit c512162."
        ),
    )
    parser.add_argument(
        "--compare-baseline",
        action="store_true",
        help=(
            "After running, diff results against backend/app/evals/baseline.json. "
            "Exit 1 on regression (any scorer's pass rate drops below the baseline)."
        ),
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help=(
            "Write the run's snapshot back to baseline.json as the new committed "
            "baseline. Use only when an intentional improvement has landed."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        provider = resolve_provider(args.provider)
        risk_provider = resolve_risk_provider(args.risk_provider)
    except ProviderNotConfiguredError as exc:
        print(f"Provider not configured: {exc}")
        return 2
    except ValueError as exc:
        print(f"Bad provider flag: {exc}")
        return 2

    runtime = UnderwritingPacketAgentRuntime(
        memo_provider=provider, risk_classifier=risk_provider
    )
    info = _provider_info(provider)
    risk = _risk_info(risk_provider)
    signature = stack_signature(info, risk)

    RESULTS_DIR.mkdir(exist_ok=True)
    judge = _build_memo_judge()
    if judge is not None:
        print("Memo-faithfulness judge: enabled (LLM_API_KEY set)")
    results = run_all(runtime, memo_provider_mode=info.mode, judge=judge)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    report_path = RESULTS_DIR / f"{timestamp}.md"
    json_path = RESULTS_DIR / f"{timestamp}.json"
    write_markdown_report(results, report_path, timestamp=timestamp, provider=info)
    write_json_snapshot(
        results, json_path, timestamp=timestamp, provider=info,
        risk_provider=risk, stack_signature=signature,
    )
    print(f"Memo provider: {info.name} ({info.mode})")
    print(f"Risk provider: {risk.name} ({risk.mode})")
    print(f"Stack signature: {signature}")
    print(f"Wrote {report_path}")
    print(f"Wrote {json_path}")
    passed = sum(1 for r in results if r.passed)
    print(f"Aggregate: {passed}/{len(results)} scenarios passed all scorers")

    snapshot = snapshot_payload(
        results, timestamp=timestamp, provider=info,
        risk_provider=risk, stack_signature=signature,
    )

    if args.update_baseline:
        write_baseline(snapshot, signature=signature)
        print(f"Updated baseline for stack {signature} at {BASELINE_PATH}")

    regressed = False
    if args.compare_baseline:
        baseline_for_stack = load_baseline_for_stack(signature)
        if baseline_for_stack is None:
            print(
                f"No baseline for stack {signature!r} at {BASELINE_PATH}. "
                f"Run with --update-baseline first to seed it."
            )
            return 2
        diff = compare_to_baseline(snapshot, baseline_for_stack)
        print(f"Baseline diff (stack: {signature}):")
        for line in diff.summary_lines():
            print(f"  {line}")
        regressed = diff.regressed
        if regressed:
            print("REGRESSION: at least one scorer dropped below baseline.")

    # Two failure modes: scenarios didn't all pass, OR baseline regressed.
    # Either is a CI failure. --compare-baseline being green requires all
    # baseline scorers to be ≥ committed levels, which is the gate we want.
    if regressed:
        return 1
    if args.compare_baseline:
        # When gating on baseline, we trust the baseline comparison rather
        # than the strict "all scenarios pass all scorers" check — the
        # baseline may already encode known-failing scorers (e.g.
        # factor_recognition on LLM providers being below 100%).
        return 0
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
