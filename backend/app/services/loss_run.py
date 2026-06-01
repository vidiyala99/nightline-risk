"""Per-venue loss run — the standard insurance claims-history artifact.

A loss run lists every claim against a venue's policies (open AND closed),
each with reserves / paid / incurred, plus summary totals and a per-coverage
-line rollup. Underwriters read it at renewal and placement to price risk.

Claims join to a venue through their Policy (Claim.policy_id → Policy.venue_id).
All money is Decimal internally, serialized as strings (JSON contract).
"""
from __future__ import annotations

from decimal import Decimal

from sqlmodel import Session, select

from app.models import Carrier, Claim, Policy
from app.money import usd_to_json

# Claim statuses that no longer need attention (mirrors services/claims.py).
_CLOSED_CLAIM_STATUSES = {"closed_paid", "closed_denied", "closed_dropped"}


def _incurred(c: Claim) -> Decimal:
    """Total incurred: paid out, net of recoveries, plus the held reserve."""
    return (
        c.indemnity_paid_to_date
        + c.expense_paid_to_date
        - c.recoveries_to_date
        + c.current_reserve
    )


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None


def venue_loss_run(session: Session, venue_id: str) -> dict:
    """Full claims history for a venue with summary + per-line totals."""
    rows = list(
        session.exec(
            select(Claim, Policy)
            .join(Policy, Claim.policy_id == Policy.id)  # type: ignore[arg-type]
            .where(Policy.venue_id == venue_id)
        )
    )
    carrier_names = {c.id: c.name for c in session.exec(select(Carrier))}

    # Most-recent loss first — standard loss-run ordering.
    rows.sort(key=lambda rp: rp[0].date_of_loss, reverse=True)

    claims: list[dict] = []
    total_reserve = total_paid = total_recoveries = total_incurred = Decimal("0")
    open_count = 0
    line_agg: dict[str, dict[str, Decimal | int]] = {}

    for claim, policy in rows:
        paid = claim.indemnity_paid_to_date + claim.expense_paid_to_date
        incurred = _incurred(claim)

        total_reserve += claim.current_reserve
        total_paid += paid
        total_recoveries += claim.recoveries_to_date
        total_incurred += incurred
        if claim.status not in _CLOSED_CLAIM_STATUSES:
            open_count += 1

        line = line_agg.setdefault(
            claim.coverage_line,
            {"claim_count": 0, "reserve": Decimal("0"), "paid": Decimal("0"), "incurred": Decimal("0")},
        )
        line["claim_count"] = int(line["claim_count"]) + 1
        line["reserve"] = Decimal(line["reserve"]) + claim.current_reserve
        line["paid"] = Decimal(line["paid"]) + paid
        line["incurred"] = Decimal(line["incurred"]) + incurred

        claims.append({
            "claim_id": claim.id,
            "carrier_claim_number": claim.carrier_claim_number,
            "policy_id": claim.policy_id,
            "policy_number": policy.policy_number,
            "carrier_id": policy.carrier_id,
            "carrier_name": carrier_names.get(policy.carrier_id, policy.carrier_id),
            "incident_id": claim.incident_id,
            "coverage_line": claim.coverage_line,
            "status": claim.status,
            "date_of_loss": _iso(claim.date_of_loss),
            "fnol_submitted_at": _iso(claim.fnol_submitted_at),
            "closed_at": _iso(claim.closed_at),
            "current_reserve": usd_to_json(claim.current_reserve),
            "indemnity_paid": usd_to_json(claim.indemnity_paid_to_date),
            "expense_paid": usd_to_json(claim.expense_paid_to_date),
            "recoveries": usd_to_json(claim.recoveries_to_date),
            "total_incurred": usd_to_json(incurred),
        })

    by_coverage_line = [
        {
            "coverage_line": line,
            "claim_count": agg["claim_count"],
            "reserve": usd_to_json(agg["reserve"]),
            "paid": usd_to_json(agg["paid"]),
            "incurred": usd_to_json(agg["incurred"]),
        }
        for line, agg in sorted(line_agg.items())
    ]

    return {
        "venue_id": venue_id,
        "claims": claims,
        "by_coverage_line": by_coverage_line,
        "summary": {
            "claim_count": len(claims),
            "open_count": open_count,
            "total_reserve": usd_to_json(total_reserve),
            "total_paid": usd_to_json(total_paid),
            "total_recoveries": usd_to_json(total_recoveries),
            "total_incurred": usd_to_json(total_incurred),
        },
    }


# ─── CSV export ──────────────────────────────────────────────────────────────

_CSV_COLUMNS = [
    ("date_of_loss", "Date of Loss"),
    ("claim_id", "Claim ID"),
    ("carrier_claim_number", "Carrier Claim #"),
    ("policy_number", "Policy #"),
    ("carrier_name", "Carrier"),
    ("coverage_line", "Coverage Line"),
    ("status", "Status"),
    ("current_reserve", "Reserve"),
    ("indemnity_paid", "Indemnity Paid"),
    ("expense_paid", "Expense Paid"),
    ("recoveries", "Recoveries"),
    ("total_incurred", "Incurred"),
]


def loss_run_csv(session: Session, venue_id: str) -> str:
    """Render the loss run as CSV — the format underwriters actually file.

    Built with the csv module so embedded commas/quotes in any field are
    escaped correctly. Ends with a TOTAL row.
    """
    import csv
    import io

    data = venue_loss_run(session, venue_id)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([header for _, header in _CSV_COLUMNS])
    for row in data["claims"]:
        writer.writerow([row.get(key, "") if row.get(key) is not None else "" for key, _ in _CSV_COLUMNS])
    s = data["summary"]
    writer.writerow([])
    writer.writerow([
        "TOTAL", "", "", "", "", "", f"{s['claim_count']} claims ({s['open_count']} open)",
        s["total_reserve"], "", "", s["total_recoveries"], s["total_incurred"],
    ])
    return buf.getvalue()
