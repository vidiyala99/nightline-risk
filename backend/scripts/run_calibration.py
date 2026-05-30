"""Compute calibration metrics against the live DB and emit JSON + markdown.

Run against local SQLite by default. Against Railway Postgres:
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.run_calibration

Outputs:
    backend/app/evals/results/calibration.json  — machine-readable
    backend/app/evals/results/calibration.md    — human-readable

Read-only. No commits. Safe to run against prod.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy.pool import StaticPool

from app.database import engine
from app.evals.calibration import run_calibration
from app.evals.calibration_fixture import seed_calibration_fixture


RESULTS_DIR = Path(__file__).resolve().parent.parent / "app" / "evals" / "results"
BASELINE_PATH = Path(__file__).resolve().parent.parent / "app" / "evals" / "calibration_baseline.json"
# Exact-ish: the fixture is deterministic, so any drift means the calibration
# math changed. A tiny epsilon absorbs float formatting only.
_TOLERANCE = 1e-9


def _summary(report: dict) -> dict:
    """The scalar metrics the gate locks (drop verbose per-bucket detail)."""
    b, o, p = report["broker_agreement"], report["outcome_in_band"], report["probability_calibration"]
    return {
        "broker_agreement": {k: b[k] for k in (
            "total_packets_with_decision", "agreed", "disagreed", "agreement_rate",
            "file_approved", "file_blocked", "nofile_approved", "nofile_blocked",
        )},
        "outcome_in_band": {k: o[k] for k in (
            "total_closed_with_prediction", "in_band", "above_band", "below_band", "in_band_rate",
        )},
        "probability_calibration": {
            "n_total": p["n_total"], "overall_brier_score": p["overall_brier_score"],
        },
    }


def _run_on_fixture() -> dict:
    """Run calibration against the deterministic in-memory fixture."""
    fx_engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(fx_engine)
    with Session(fx_engine) as session:
        seed_calibration_fixture(session)
        return run_calibration(session)


def _diff_summaries(current: dict, baseline: dict) -> list[str]:
    """Return human-readable drift lines (empty when within tolerance)."""
    diffs: list[str] = []
    for group, metrics in current.items():
        base_group = baseline.get(group, {})
        for key, val in metrics.items():
            base_val = base_group.get(key)
            if isinstance(val, float) or isinstance(base_val, float):
                if base_val is None or abs(float(val) - float(base_val)) > _TOLERANCE:
                    diffs.append(f"{group}.{key}: {base_val} -> {val}")
            elif val != base_val:
                diffs.append(f"{group}.{key}: {base_val} -> {val}")
    return diffs


def _compare_baseline() -> int:
    current = _summary(_run_on_fixture())
    if not BASELINE_PATH.exists():
        print(f"No calibration baseline at {BASELINE_PATH}. "
              f"Run with --write-baseline to create it.", file=sys.stderr)
        return 2
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    diffs = _diff_summaries(current, baseline)
    if diffs:
        print("CALIBRATION REGRESSION — fixture metrics drifted from baseline:")
        for d in diffs:
            print(f"  DRIFT {d}")
        print("\nIf this change is intentional, regenerate with "
              "`python -m scripts.run_calibration --write-baseline`.")
        return 1
    print("OK calibration: fixture metrics match baseline "
          f"(agreement={current['broker_agreement']['agreement_rate']:.3f}, "
          f"in_band={current['outcome_in_band']['in_band_rate']:.3f}, "
          f"brier={current['probability_calibration']['overall_brier_score']:.4f}).")
    return 0


def _write_baseline() -> int:
    current = _summary(_run_on_fixture())
    BASELINE_PATH.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote calibration baseline to {BASELINE_PATH}")
    return 0


def _render_markdown(report: dict, *, timestamp: str) -> str:
    broker = report["broker_agreement"]
    outcome = report["outcome_in_band"]
    prob = report["probability_calibration"]

    lines: list[str] = []
    lines.append(f"# Calibration report — {timestamp}")
    lines.append("")
    lines.append("Measures recommender predictions against historical reality.")
    lines.append("Distinct from `eval-baseline.json`, which scores synthetic scenarios.")
    lines.append("")

    lines.append("## 1. Broker agreement")
    lines.append("")
    lines.append(f"- **Agreement rate:** {broker['agreement_rate']:.1%} "
                 f"({broker['agreed']}/{broker['total_packets_with_decision']})")
    lines.append("")
    lines.append("| Recommender → | Broker approved | Broker blocked |")
    lines.append("|---|---|---|")
    lines.append(f"| should_file=True  | {broker['file_approved']} ✓ | {broker['file_blocked']} ✗ |")
    lines.append(f"| should_file=False | {broker['nofile_approved']} ✗ | {broker['nofile_blocked']} ✓ |")
    lines.append("")

    lines.append("## 2. Outcome in band")
    lines.append("")
    lines.append(f"- **In-band rate:** {outcome['in_band_rate']:.1%} "
                 f"({outcome['in_band']}/{outcome['total_closed_with_prediction']} closed-paid claims)")
    if outcome['median_predicted_usd'] and outcome['median_actual_usd']:
        lines.append(f"- **Median predicted:** ${outcome['median_predicted_usd']:,.0f} · "
                     f"**Median actual:** ${outcome['median_actual_usd']:,.0f}")
    lines.append(f"- Above band (under-predicted): {outcome['above_band']}")
    lines.append(f"- Below band (over-predicted): {outcome['below_band']}")
    lines.append("")

    lines.append("## 3. Probability calibration")
    lines.append("")
    if prob['n_total'] == 0:
        lines.append("_No closed claims with predictions — calibration data not yet available._")
    else:
        lines.append(f"- **Brier score:** {prob['overall_brier_score']:.4f} "
                     f"(lower is better; 0 = perfect)")
        lines.append(f"- **Sample size:** {prob['n_total']} closed claims with predictions")
        lines.append("")
        lines.append("| Bucket | n | Paid | Actual rate | Predicted midpoint | Gap |")
        lines.append("|---|---|---|---|---|---|")
        for b in prob['buckets']:
            gap_sign = "+" if b['calibration_gap'] >= 0 else ""
            lines.append(
                f"| {b['bucket_label']} | {b['n']} | {b['paid']} | "
                f"{b['paid_rate']:.1%} | {b['bucket_midpoint']:.1%} | "
                f"{gap_sign}{b['calibration_gap']:.1%} |"
            )
    lines.append("")
    return "\n".join(lines)


def _run_live_report() -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()

    with Session(engine) as session:
        report = run_calibration(session)

    report_with_meta = {"timestamp": timestamp, **report}
    json_path = RESULTS_DIR / "calibration.json"
    md_path = RESULTS_DIR / "calibration.md"
    json_path.write_text(json.dumps(report_with_meta, indent=2), encoding="utf-8")
    md_path.write_text(_render_markdown(report, timestamp=timestamp), encoding="utf-8")

    print(f"Calibration report written to:\n  {json_path}\n  {md_path}\n")
    print(_render_markdown(report, timestamp=timestamp))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="scripts.run_calibration",
        description="Compute calibration metrics (live DB) or gate on a fixture.",
    )
    parser.add_argument("--compare-baseline", action="store_true",
                        help="Run the deterministic fixture and exit 1 if metrics drift "
                             "from app/evals/calibration_baseline.json (CI gate).")
    parser.add_argument("--write-baseline", action="store_true",
                        help="Regenerate the calibration baseline from the fixture.")
    args = parser.parse_args(argv)

    if args.write_baseline:
        return _write_baseline()
    if args.compare_baseline:
        return _compare_baseline()
    _run_live_report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
