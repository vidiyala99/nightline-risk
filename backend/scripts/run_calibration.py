"""Compute calibration metrics against the live DB and emit JSON + markdown.

Run against local SQLite by default. Against Railway Postgres:
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.run_calibration

Outputs:
    backend/app/evals/results/calibration.json  — machine-readable
    backend/app/evals/results/calibration.md    — human-readable

Read-only. No commits. Safe to run against prod.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session

from app.database import engine
from app.evals.calibration import run_calibration


RESULTS_DIR = Path(__file__).resolve().parent.parent / "app" / "evals" / "results"


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


def main() -> None:
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


if __name__ == "__main__":
    main()
