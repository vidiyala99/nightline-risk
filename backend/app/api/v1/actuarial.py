"""GET /api/venues/{venue_id}/actuarial — actuarial summary for a venue.

Returns the credibility-weighted experience mod (from the in-force policy's
claim history) and the chain-ladder development result (per coverage line).
Both sections degrade gracefully:
  - No in-force policy or zero claims → experience_mod section with neutral mod 1.00
  - Too few claims for credible development → chain_ladder.is_credible=false + caveat
  - Any unexpected error → 200 with null sections (never 500)

Broker-gated. Money returned as strings (house convention).
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.auth import require_broker
from app.database import get_session
from app.models import Policy
from app.money import usd_to_json
from app.services.fnol import ACTIVE_POLICY_STATUSES
from app.services.renewals import build_experience_years_for_policy
from app.services.loss_development_data import build_development_cells_for_venue
from app.underwriting.experience_rating import compute_experience_mod
from app.underwriting.loss_development import compute_chain_ladder

router = APIRouter()


def _experience_mod_section(session: Session, venue_id: str) -> dict:
    """Credibility-weighted mod from the venue's in-force policy."""
    policy = session.exec(
        select(Policy)
        .where(Policy.venue_id == venue_id)
        .where(Policy.status.in_(list(ACTIVE_POLICY_STATUSES)))  # type: ignore[attr-defined]
        .order_by(Policy.effective_date.desc())  # type: ignore[attr-defined]
        .limit(1)
    ).first()

    if policy is None:
        return {
            "mod": "1.00",
            "credibility_z": "0.0000",
            "experience_lr": "0",
            "claim_count": 0,
            "logic_version": "no_active_policy",
            "caveat": "No in-force policy found for this venue.",
        }

    years = build_experience_years_for_policy(
        session, policy.id,
        annual_premium=policy.annual_premium,
        years_back=0,
    )
    mod = compute_experience_mod(years)
    return {
        "policy_id": policy.id,
        "mod": str(mod.mod),
        "credibility_z": str(mod.credibility_z.quantize(Decimal("0.0001"))),
        "experience_lr": str(mod.experience_lr.quantize(Decimal("0.0001"))),
        "claim_count": mod.claim_count,
        "logic_version": mod.logic_version,
        "caveat": None,
    }


def _chain_ladder_section(session: Session, venue_id: str) -> dict:
    """Chain-ladder development result per coverage line."""
    cells_by_line, total_claims = build_development_cells_for_venue(session, venue_id)

    if not cells_by_line:
        return {
            "is_credible": False,
            "claim_count": 0,
            "ultimate_total": "0.00",
            "by_coverage_line": [],
            "caveat": "No claim history found for this venue.",
            "logic_version": "no_data",
        }

    all_cells = [c for cells in cells_by_line.values() for c in cells]
    result = compute_chain_ladder(all_cells, claim_count=total_claims)

    by_line = []
    for line, cells in cells_by_line.items():
        line_result = compute_chain_ladder(cells, claim_count=len(cells))
        by_line.append({
            "coverage_line": line,
            "ultimate": usd_to_json(line_result.ultimate_total),
            "is_credible": line_result.is_credible,
            "caveat": line_result.caveat,
        })

    return {
        "is_credible": result.is_credible,
        "claim_count": result.claim_count,
        "accident_year_count": result.accident_year_count,
        "ultimate_total": usd_to_json(result.ultimate_total),
        "by_coverage_line": by_line,
        "caveat": result.caveat,
        "logic_version": result.logic_version,
    }


@router.get("/venues/{venue_id}/actuarial", dependencies=[Depends(require_broker)])
def api_venue_actuarial(
    venue_id: str,
    session: Session = Depends(get_session),
) -> dict:
    """Actuarial summary for a venue. Never 500s — sections degrade to safe defaults."""
    try:
        exp_mod = _experience_mod_section(session, venue_id)
    except Exception:  # noqa: BLE001
        exp_mod = None

    try:
        chain_ladder = _chain_ladder_section(session, venue_id)
    except Exception:  # noqa: BLE001
        chain_ladder = None

    return {
        "venue_id": venue_id,
        "experience_mod": exp_mod,
        "chain_ladder": chain_ladder,
    }
