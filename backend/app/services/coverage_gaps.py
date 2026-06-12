"""Per-policy coverage-gap analysis for the broker remediation page.

A "gap" is a default-required coverage line (CoverageLine.is_required_by_default)
that an in-force policy does NOT carry — the same definition the broker exposure
finding `intelligence/findings/coverage_gap_eo.py` uses, scoped to one policy and
enriched with line names + recommended limits so the UI can render:

  (1) current coverage, (2) the gaps, (3) how to close each (a deep-link into
      the existing prefilled endorse flow).

Money is emitted as STRINGS (app.money.usd_to_json), per the JSON-column
convention. List columns are coerced through `_as_list` because Postgres returns
`Policy.coverage_lines` as a JSON string, not a parsed list.
"""
from __future__ import annotations

from sqlmodel import select

from app.defense_package import _as_list
from app.models import CoverageLine, Policy
from app.money import usd_to_json

GAP_SEVERITY = "high"  # a missing required line is direct E&O exposure


def analyze_policy_gaps(session, policy: Policy) -> dict:
    """Return the coverage / gap / remediation view for a single policy."""
    lines = {cl.id: cl for cl in session.exec(select(CoverageLine)).all()}
    required = {cid for cid, cl in lines.items() if cl.is_required_by_default}
    have = set(_as_list(policy.coverage_lines))

    covered = [
        {
            "id": cid,
            "name": lines[cid].name if cid in lines else cid,
            "limit": (
                usd_to_json(lines[cid].default_per_occurrence_limit)
                if cid in lines else None
            ),
        }
        for cid in sorted(have)
    ]

    gaps = []
    for cid in sorted(required - have):
        cl = lines.get(cid)
        label = cl.name if cl else cid
        gaps.append({
            "id": cid,
            "name": label,
            "severity": GAP_SEVERITY,
            "reason": (
                f"{label} is a required coverage line. A loss on a missing "
                "required line is an uncovered E&O exposure for the broker."
            ),
            "recommended_limit": (
                usd_to_json(cl.default_per_occurrence_limit) if cl else None
            ),
            # Reuse the existing prefilled endorse flow the page links each gap to.
            "endorse_href": (
                f"/policies/{policy.id}/endorse"
                f"?type=add_coverage&coverage_line={cid}"
            ),
        })

    return {
        "policy_id": policy.id,
        "venue_id": policy.venue_id,
        "status": policy.status,
        "covered": covered,
        "gaps": gaps,
        "summary": {
            "gap_count": len(gaps),
            "highest_severity": GAP_SEVERITY if gaps else None,
        },
    }
