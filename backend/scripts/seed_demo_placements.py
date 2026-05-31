"""Seed demo Submissions + a bound Policy so /submissions and /policies
aren't empty for screenshots and walkthroughs.

Idempotent: skips if any sub-demo-* submission already exists.

Run from the backend directory:
    python -m scripts.seed_demo_placements

Produces:
  - sub-demo-open       (status='open',       elsewhere-brooklyn)
  - sub-demo-market     (status='in_market',  brooklyn-mirage; quotes pending)
  - sub-demo-quoting    (status='quoting',    house-of-yes; 2 quoted, 1 selected)
  - sub-demo-bound      (status='bound',      nowadays) → pol-demo-1 (active)
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from decimal import Decimal

from sqlmodel import Session, select

from app.database import engine
from app.models import CarrierQuote, Policy, Submission
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.policies import bind_quote
from app.services.submissions import (
    create_submission,
    record_carrier_response,
    select_quote,
    submit_to_market,
)
from app.underwriting.pricing import build_quote_for_carrier
from app.underwriting.scoring import get_risk_score


BROKER_USER_ID = "user_001"


def _existing_demo_subs(session: Session) -> list[str]:
    rows = session.exec(
        select(Submission).where(Submission.id.like("sub-demo-%"))  # type: ignore[attr-defined]
    ).all()
    return [r.id for r in rows]


def _force_sub_id(session: Session, sub: Submission, demo_id: str) -> Submission:
    """Service creates random IDs; we rewrite to a stable demo-* id so
    repeated runs after manual cleanup land on the same row."""
    sub.id = demo_id
    session.add(sub)
    session.flush()
    return sub


def _quote_breakdown(venue_id: str, carrier_id: str, lines: list[str],
                     market_type: str, requested_limits: dict) -> dict:
    """Build a realistic premium breakdown via the Phase 1.7 quote engine."""
    venue = {"id": venue_id, **VENUES[venue_id]}
    risk = get_risk_score(venue_id, VENUES)
    fq = build_quote_for_carrier(
        venue=venue, coverage_lines=lines, carrier_id=carrier_id,
        market_type=market_type, risk_score=risk,
        requested_limits=requested_limits,
    )
    return fq.to_json_dict()


def seed(session: Session) -> dict:
    seed_broker_platform_data(session)
    session.flush()

    if _existing_demo_subs(session):
        return {"skipped": True, "reason": "demo submissions already seeded"}

    effective = date.today() + timedelta(days=30)
    limits = {
        "gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
        "liquor": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
    }

    # ─── 1. Open ─────────────────────────────────────────────────────────
    sub_open = create_submission(
        session, venue_id="elsewhere-brooklyn", effective_date=effective,
        coverage_lines=["gl", "liquor"], requested_limits=limits,
        producer_id=BROKER_USER_ID,
        notes="Renewal walk-in. Awaiting loss-run pull before going to market.",
        actor_id=BROKER_USER_ID,
    )
    _force_sub_id(session, sub_open, "sub-demo-open")

    # ─── 2. In market ────────────────────────────────────────────────────
    sub_market = create_submission(
        session, venue_id="brooklyn-mirage", effective_date=effective,
        coverage_lines=["gl", "liquor", "assault_battery"],
        requested_limits={
            **limits,
            "assault_battery": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "5000"},
        },
        producer_id=BROKER_USER_ID,
        notes="Large outdoor capacity. Brit + Atrium primary targets.",
        actor_id=BROKER_USER_ID,
    )
    _force_sub_id(session, sub_market, "sub-demo-market")
    submit_to_market(
        session, sub_market.id,
        target_carriers=["brit-syndicate", "atrium-syndicate"],
        submitted_by=BROKER_USER_ID,
    )

    # ─── 3. Quoting (two quoted, one selected) ───────────────────────────
    sub_quoting = create_submission(
        session, venue_id="house-of-yes", effective_date=effective,
        coverage_lines=["gl", "liquor", "assault_battery"],
        requested_limits={
            **limits,
            "assault_battery": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "5000"},
        },
        producer_id=BROKER_USER_ID,
        notes="Two strong responses. Atrium is best on price; Brit is broader form.",
        actor_id=BROKER_USER_ID,
    )
    _force_sub_id(session, sub_quoting, "sub-demo-quoting")
    quoting_result = submit_to_market(
        session, sub_quoting.id,
        target_carriers=["brit-syndicate", "atrium-syndicate"],
        submitted_by=BROKER_USER_ID,
    )
    # Carriers respond with real numbers.
    for q in quoting_result.quotes_created:
        bd = _quote_breakdown(
            venue_id="house-of-yes",
            carrier_id=q.carrier_id,
            lines=["gl", "liquor", "assault_battery"],
            market_type="e&s",
            requested_limits={
                **limits,
                "assault_battery": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "5000"},
            },
        )
        record_carrier_response(
            session, q.id,
            status="quoted",
            premium_breakdown=bd,
            coverage_terms={
                "gl": {"per_occurrence": "1000000", "aggregate": "2000000"},
                "liquor": {"per_occurrence": "1000000", "aggregate": "2000000"},
                "assault_battery": {"per_occurrence": "1000000", "aggregate": "2000000"},
            },
            underwriter_name=f"{q.carrier_id} underwriter",
            recorded_by=BROKER_USER_ID,
        )
    # Pick the cheaper one as selected.
    refreshed = sorted(
        quoting_result.quotes_created,
        key=lambda q: Decimal(session.get(type(q), q.id).premium_breakdown.get("total", "0")),
    )
    select_quote(session, refreshed[0].id, selected_by=BROKER_USER_ID)

    # ─── 4. Bound → Policy ───────────────────────────────────────────────
    sub_bound = create_submission(
        session, venue_id="nowadays", effective_date=effective,
        coverage_lines=["gl", "liquor"], requested_limits=limits,
        producer_id=BROKER_USER_ID,
        notes="Bound on Burns & Wilcox. Renewal lined up for next term.",
        actor_id=BROKER_USER_ID,
    )
    _force_sub_id(session, sub_bound, "sub-demo-bound")
    bound_result = submit_to_market(
        session, sub_bound.id,
        target_carriers=["burns-wilcox"],
        submitted_by=BROKER_USER_ID,
    )
    q_bw = bound_result.quotes_created[0]
    bd = _quote_breakdown(
        venue_id="nowadays", carrier_id="burns-wilcox",
        lines=["gl", "liquor"], market_type="e&s", requested_limits=limits,
    )
    record_carrier_response(
        session, q_bw.id, status="quoted",
        premium_breakdown=bd,
        coverage_terms={
            "gl": {"per_occurrence": "1000000", "aggregate": "2000000"},
            "liquor": {"per_occurrence": "1000000", "aggregate": "2000000"},
        },
        underwriter_name="Burns & Wilcox underwriter",
        recorded_by=BROKER_USER_ID,
    )
    select_quote(session, q_bw.id, selected_by=BROKER_USER_ID)
    policy = bind_quote(
        session, q_bw.id,
        policy_number="BW-DEMO-2026-0001",
        effective_date=effective,
        term_length_days=365,
        bound_by=BROKER_USER_ID,
    )

    session.commit()
    return {
        "submissions": [
            "sub-demo-open", "sub-demo-market", "sub-demo-quoting", "sub-demo-bound",
        ],
        "policy_id": policy.id,
        "policy_number": policy.policy_number,
    }


def ensure_eb_current_policy(session: Session) -> Policy | None:
    """The operator persona logs in as elsewhere-brooklyn. For the file-vs-pay
    decision to compute *real* deductible/premium numbers it needs an in-force
    Policy — built through the same bind_quote path as any real policy, so the
    terms_snapshot carries short-code lines (gl/liquor) with deductibles the
    FNOL resolver reads. The venue's open submission (sub-demo-open) is its
    *renewal*; this is the *current* term's policy.

    Idempotent on the POLICY — the thing we actually want. Checking the submission
    alone is wrong: a prior partial run can commit `sub-demo-eb-current` but fail
    before the policy binds, leaving the submission orphaned. If the policy is
    already there we skip; if a stale submission exists without it, we clear the
    submission (+ its quotes) and rebuild cleanly.
    """
    if session.exec(
        select(Policy).where(Policy.policy_number == "EB-DEMO-2026-0001")
    ).first():
        return None

    # Self-heal a stale partial submission so the bind flow can re-run.
    stale = session.exec(
        select(Submission).where(Submission.id == "sub-demo-eb-current")
    ).first()
    if stale is not None:
        for q in session.exec(
            select(CarrierQuote).where(CarrierQuote.submission_id == "sub-demo-eb-current")
        ).all():
            session.delete(q)
        session.delete(stale)
        session.flush()

    seed_broker_platform_data(session)
    session.flush()

    eff = date.today() - timedelta(days=180)  # bound ~6 months ago → in-force now
    limits = {
        "gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
        "liquor": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500"},
    }
    sub = create_submission(
        session, venue_id="elsewhere-brooklyn", effective_date=eff,
        coverage_lines=["gl", "liquor"], requested_limits=limits,
        producer_id=BROKER_USER_ID,
        notes="Current in-force policy (bound last term; renewal is sub-demo-open).",
        actor_id=BROKER_USER_ID,
    )
    _force_sub_id(session, sub, "sub-demo-eb-current")
    res = submit_to_market(
        session, sub.id, target_carriers=["burns-wilcox"], submitted_by=BROKER_USER_ID,
    )
    q = res.quotes_created[0]
    bd = _quote_breakdown(
        venue_id="elsewhere-brooklyn", carrier_id="burns-wilcox",
        lines=["gl", "liquor"], market_type="e&s", requested_limits=limits,
    )
    record_carrier_response(
        session, q.id, status="quoted", premium_breakdown=bd,
        coverage_terms={
            "gl": {"per_occurrence": "1000000", "aggregate": "2000000"},
            "liquor": {"per_occurrence": "1000000", "aggregate": "2000000"},
        },
        underwriter_name="Burns & Wilcox underwriter", recorded_by=BROKER_USER_ID,
    )
    select_quote(session, q.id, selected_by=BROKER_USER_ID)
    return bind_quote(
        session, q.id, policy_number="EB-DEMO-2026-0001",
        effective_date=eff, term_length_days=365, bound_by=BROKER_USER_ID,
    )


def main() -> int:
    with Session(engine) as session:
        result = seed(session)
    # Operator persona's in-force policy — always ensured, even when the
    # placement demo above was skipped (already seeded).
    with Session(engine) as session:
        eb = ensure_eb_current_policy(session)
        session.commit()
    if result.get("skipped"):
        print(f"[seed] placements skipped: {result['reason']}")
    else:
        print("[seed] created:")
        for sid in result["submissions"]:
            print(f"  - {sid}")
        print(f"  - {result['policy_id']} ({result['policy_number']})")
    print(f"[seed] operator policy: {'created EB-DEMO-2026-0001' if eb else 'already present'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
