"""Adapt the already-assembled carrier dossier pieces into the recommender's
typed inputs and run it. Failure-isolated: ANY error → None, so the dossier
endpoint never 500s (mirrors reserve_hint in adjusting.py)."""
from __future__ import annotations

from decimal import Decimal

from app.schemas.domain import UnderwritingRecommendation
from app.underwriting.recommender import RecommenderInputs, recommend


def recommendation_from_dossier_parts(
    *,
    risk: dict | None,
    loss_run: dict | None,
    coverage_lines: list[str] | None,
    suggested_premium_breakdown: dict | None,
    in_appetite: bool | None = None,
) -> UnderwritingRecommendation | None:
    try:
        if not risk or not suggested_premium_breakdown:
            return None
        # Coerce loss_run by-line (JSON money strings → Decimal) at the read boundary.
        loss_by_line: dict = {}
        for row in (loss_run or {}).get("by_coverage_line", []) or []:
            line = row.get("coverage_line")
            if not line:
                continue
            loss_by_line[line] = {
                "claim_count": int(row.get("claim_count", 0)),
                "incurred": Decimal(str(row.get("incurred", "0") or "0")),
            }
        inputs = RecommenderInputs(
            tier=str(risk.get("tier", "")),
            total_score=int(risk.get("total_score", 0)),
            coverage_lines=list(coverage_lines or []),
            loss_by_line=loss_by_line,
            indicated_total=Decimal(str(suggested_premium_breakdown.get("total", "0") or "0")),
            in_appetite=in_appetite,
        )
        return recommend(inputs)
    except Exception:  # noqa: BLE001 — advisory only, never block the desk
        return None
