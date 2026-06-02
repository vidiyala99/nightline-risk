"""Seed a spread of carrier-side Claims so the adjuster desk (carrier persona,
`underwriter@nightline.risk`) has real data to work through.

Every claim is created through the SAME service functions the live desk uses
(file_fnol → decide_coverage → adjust_reserve → approve_payment →
close_claim_as_carrier), so audit events, ReserveChange rows, payment ledgers
and snapshot hashes are all genuine — not hand-built rows.

The set is deliberately mixed so the queue and detail screens exercise every
state:

  ADJ-DEMO-001  Brooklyn Mirage   · liquor   → notified            (pristine — do the full flow)
  ADJ-DEMO-002  House of Yes      · a&b      → under_investigation  (covered; set a reserve / pay)
  ADJ-DEMO-003  Market Hotel      · gl       → reserved             (covered + $25k reserve; pay / close)
  ADJ-DEMO-004  Elsewhere Brooklyn· liquor   → settling             (covered, reserve, indemnity+expense paid)
  ADJ-DEMO-005  Brooklyn Mirage   · gl       → under_investigation  (reservation of rights)
  ADJ-DEMO-006  House of Yes      · gl       → closed_paid          (full history, settled)
  ADJ-DEMO-007  Market Hotel      · liquor   → notified             (second pristine, second venue)
  ADJ-DEMO-008  Elsewhere Brooklyn· gl       → closed_denied        (coverage denied → auto-closed)

Idempotent: skips entirely if any ADJ-DEMO-* claim already exists. Policies are
keyed on a stable policy_number so reruns reuse them.

Run from backend/:
    python -m scripts.seed_adjuster_demo
Against prod (Railway/Neon), use the Postgres PUBLIC url:
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.seed_adjuster_demo
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from decimal import Decimal

from sqlmodel import Session, select

from app.database import engine
from app.models import Claim, Policy
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.adjusting import (
    adjust_reserve,
    approve_payment,
    close_claim_as_carrier,
    decide_coverage,
)
from app.services.claims import file_fnol
from app.services.policies import bind_quote
from app.services.submissions import (
    create_submission,
    record_carrier_response,
    select_quote,
    submit_to_market,
)
from app.underwriting.pricing import build_quote_for_carrier
from app.underwriting.scoring import get_risk_score

# Carrier persona (Sam Rivera) — owns these adjudication decisions.
ADJUSTER_ID = "user_003"
ADJUSTER_NAME = "Sam Rivera"
ADJUSTER_EMAIL = "underwriter@nightline.risk"
BROKER_USER_ID = "user_001"

LINES = ["gl", "liquor", "assault_battery"]
LIMITS = {
    "gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
    "liquor": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
    "assault_battery": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "5000"},
}

# Bind ~6 months ago so any recent date_of_loss falls inside the policy term.
EFFECTIVE = date.today() - timedelta(days=200)
DOL = date.today() - timedelta(days=30)   # date of loss
PAID_ON = date.today() - timedelta(days=10)


def _quote_breakdown(venue_id: str, carrier_id: str) -> dict:
    venue = {"id": venue_id, **VENUES[venue_id]}
    risk = get_risk_score(venue_id, VENUES)
    fq = build_quote_for_carrier(
        venue=venue, coverage_lines=LINES, carrier_id=carrier_id,
        market_type="e&s", risk_score=risk, requested_limits=LIMITS,
    )
    return fq.to_json_dict()


def _active_policy(session: Session, venue_id: str, policy_number: str) -> Policy:
    """Idempotent: return the existing active policy for this number, or bind a
    fresh one through the real submission → quote → bind path."""
    existing = session.exec(
        select(Policy).where(Policy.policy_number == policy_number)
    ).first()
    if existing is not None:
        return existing

    sub = create_submission(
        session, venue_id=venue_id, effective_date=EFFECTIVE,
        coverage_lines=LINES, requested_limits=LIMITS,
        producer_id=BROKER_USER_ID,
        notes="Adjuster-demo in-force policy (claims seed).",
        actor_id=BROKER_USER_ID,
    )
    res = submit_to_market(
        session, sub.id, target_carriers=["burns-wilcox"], submitted_by=BROKER_USER_ID,
        # Demo seed: bind regardless of carrier appetite (some venue types fall
        # outside B&W's published appetite — irrelevant for adjudication testing).
        allow_out_of_appetite=True,
    )
    q = res.quotes_created[0]
    record_carrier_response(
        session, q.id, status="quoted",
        premium_breakdown=_quote_breakdown(venue_id, "burns-wilcox"),
        coverage_terms={ln: {"per_occurrence": "1000000", "aggregate": "2000000"} for ln in LINES},
        underwriter_name="Burns & Wilcox underwriter", recorded_by=BROKER_USER_ID,
    )
    select_quote(session, q.id, selected_by=BROKER_USER_ID)
    return bind_quote(
        session, q.id, policy_number=policy_number,
        effective_date=EFFECTIVE, term_length_days=365, bound_by=BROKER_USER_ID,
    )


def _fnol(session: Session, policy: Policy, line: str, ccn: str) -> Claim:
    return file_fnol(
        session, policy_id=policy.id, coverage_line=line, date_of_loss=DOL,
        filed_by=ADJUSTER_ID, carrier_claim_number=ccn,
        adjuster_name=ADJUSTER_NAME, adjuster_email=ADJUSTER_EMAIL,
    )


def seed(session: Session) -> dict:
    seed_broker_platform_data(session)
    session.flush()

    if session.exec(
        select(Claim).where(Claim.carrier_claim_number.like("ADJ-DEMO-%"))  # type: ignore[attr-defined]
    ).first():
        return {"skipped": True, "reason": "ADJ-DEMO-* claims already seeded"}

    pol_mirage = _active_policy(session, "brooklyn-mirage", "ADJ-POL-MIRAGE-2026")
    pol_hoy = _active_policy(session, "house-of-yes", "ADJ-POL-HOY-2026")
    pol_market = _active_policy(session, "market-hotel", "ADJ-POL-MARKET-2026")
    pol_eb = _active_policy(session, "elsewhere-brooklyn", "ADJ-POL-EB-2026")

    created: list[str] = []

    # 001 — notified, pristine (full flow testable)
    _fnol(session, pol_mirage, "liquor", "ADJ-DEMO-001")
    created.append("ADJ-DEMO-001 · Brooklyn Mirage · notified")

    # 002 — under_investigation, coverage covered (set reserve / pay next)
    c2 = _fnol(session, pol_hoy, "assault_battery", "ADJ-DEMO-002")
    decide_coverage(
        session, c2.id, decision="covered",
        rationale="A&B is a covered peril under the assault & battery endorsement; "
                  "no exclusion applies on the facts reported.",
        adjuster_id=ADJUSTER_ID,
    )
    created.append("ADJ-DEMO-002 · House of Yes · under_investigation (covered)")

    # 003 — reserved (covered + $25k reserve)
    c3 = _fnol(session, pol_market, "gl", "ADJ-DEMO-003")
    decide_coverage(
        session, c3.id, decision="covered",
        rationale="Premises slip-and-fall; bodily injury within the GL grant. Covered.",
        adjuster_id=ADJUSTER_ID,
    )
    adjust_reserve(
        session, c3.id, new_reserve=Decimal("25000"),
        change_reason="initial reserve — pending medical specials",
        adjuster_id=ADJUSTER_ID,
    )
    created.append("ADJ-DEMO-003 · Market Hotel · reserved ($25k)")

    # 004 — settling (covered, reserve, indemnity + expense paid → rich history)
    c4 = _fnol(session, pol_eb, "liquor", "ADJ-DEMO-004")
    decide_coverage(
        session, c4.id, decision="covered",
        rationale="Over-service contributed to third-party injury; liquor liability "
                  "grant responds. Covered.",
        adjuster_id=ADJUSTER_ID,
    )
    adjust_reserve(
        session, c4.id, new_reserve=Decimal("40000"),
        change_reason="initial reserve on liquor BI",
        adjuster_id=ADJUSTER_ID,
    )
    approve_payment(
        session, c4.id, amount=Decimal("12000"), payment_type="indemnity",
        paid_on=PAID_ON, description="advance indemnity to claimant", adjuster_id=ADJUSTER_ID,
    )
    approve_payment(
        session, c4.id, amount=Decimal("3500"), payment_type="expense",
        paid_on=PAID_ON, description="defense counsel — initial invoice", adjuster_id=ADJUSTER_ID,
    )
    adjust_reserve(
        session, c4.id, new_reserve=Decimal("32000"),
        change_reason="reduced after partial indemnity payment",
        adjuster_id=ADJUSTER_ID,
    )
    created.append("ADJ-DEMO-004 · Elsewhere Brooklyn · settling (history)")

    # 005 — under_investigation, reservation of rights (2nd claim, mirage)
    c5 = _fnol(session, pol_mirage, "gl", "ADJ-DEMO-005")
    decide_coverage(
        session, c5.id, decision="reservation_of_rights",
        rationale="Late notice and a possible assault carve-out under investigation; "
                  "proceeding under a full reservation of rights.",
        adjuster_id=ADJUSTER_ID,
    )
    created.append("ADJ-DEMO-005 · Brooklyn Mirage · reservation of rights")

    # 006 — closed_paid (full lifecycle, 2nd claim on HoY)
    c6 = _fnol(session, pol_hoy, "gl", "ADJ-DEMO-006")
    decide_coverage(
        session, c6.id, decision="covered",
        rationale="Trip-and-fall on uneven stair; covered under GL.",
        adjuster_id=ADJUSTER_ID,
    )
    adjust_reserve(
        session, c6.id, new_reserve=Decimal("20000"),
        change_reason="initial reserve", adjuster_id=ADJUSTER_ID,
    )
    approve_payment(
        session, c6.id, amount=Decimal("16000"), payment_type="indemnity",
        paid_on=PAID_ON, description="settlement to claimant", adjuster_id=ADJUSTER_ID,
    )
    approve_payment(
        session, c6.id, amount=Decimal("2000"), payment_type="expense",
        paid_on=PAID_ON, description="adjuster + counsel costs", adjuster_id=ADJUSTER_ID,
    )
    close_claim_as_carrier(
        session, c6.id, disposition="paid", final_indemnity=Decimal("16000"),
        adjuster_id=ADJUSTER_ID,
    )
    created.append("ADJ-DEMO-006 · House of Yes · closed_paid")

    # 007 — notified, second pristine (second venue in the queue)
    _fnol(session, pol_market, "liquor", "ADJ-DEMO-007")
    created.append("ADJ-DEMO-007 · Market Hotel · notified")

    # 008 — closed_denied (coverage denied → auto-closed)
    c8 = _fnol(session, pol_eb, "gl", "ADJ-DEMO-008")
    decide_coverage(
        session, c8.id, decision="denied",
        rationale="Loss arises from an excluded contractual-liability assumption; "
                  "no coverage. Denied.",
        adjuster_id=ADJUSTER_ID,
    )
    created.append("ADJ-DEMO-008 · Elsewhere Brooklyn · closed_denied")

    session.commit()
    return {"skipped": False, "claims": created}


def main() -> int:
    with Session(engine) as session:
        result = seed(session)
    if result.get("skipped"):
        print(f"[seed] adjuster demo skipped: {result['reason']}")
    else:
        print(f"[seed] created {len(result['claims'])} adjuster-demo claims:")
        for c in result["claims"]:
            print(f"  - {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
