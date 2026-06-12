"""Actionable-first list ordering: the shared status-priority helper plus the
service queries that now lead with the most-actionable row instead of arbitrary
DB/insertion/UUID order."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

from app.lifecycles import (
    CLAIM_STATUS_PRIORITY,
    INCIDENT_STATUS_PRIORITY,
    SUBMISSION_STATUS_PRIORITY,
    status_priority_case,
)
from app.models import Claim, Policy, Submission
from app.services.claims import list_claims
from app.services.policies import list_policies
from app.services.submissions import list_submissions

NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


# ─── Helper: status_priority_case maps statuses to a sortable rank ────────


def test_status_priority_case_orders_open_before_closed():
    s = _session()
    for cid, st in [("c-closed", "closed_paid"), ("c-new", "notified"),
                    ("c-mid", "reserved")]:
        s.add(Claim(id=cid, policy_id="p", coverage_line="gl", status=st,
                    date_of_loss=date(2026, 1, 1)))
    s.commit()
    from sqlmodel import select
    rank = status_priority_case(Claim.status, CLAIM_STATUS_PRIORITY)
    ordered = [c.id for c in s.exec(select(Claim).order_by(rank.desc())).all()]
    assert ordered == ["c-new", "c-mid", "c-closed"]


def test_priority_maps_rank_actionable_above_terminal():
    assert INCIDENT_STATUS_PRIORITY["open"] > INCIDENT_STATUS_PRIORITY["closed"]
    assert CLAIM_STATUS_PRIORITY["notified"] > CLAIM_STATUS_PRIORITY["closed_paid"]
    assert SUBMISSION_STATUS_PRIORITY["quoting"] > SUBMISSION_STATUS_PRIORITY["bound"]


# ─── Services: actionable-first ordering ─────────────────────────────────


def test_list_claims_orders_open_before_closed():
    s = _session()
    # Insert closed first so insertion order can't accidentally pass the test.
    s.add(Claim(id="clm-closed", policy_id="p1", coverage_line="gl",
                status="closed_paid", date_of_loss=date(2026, 1, 1),
                fnol_submitted_at=NOW))
    s.add(Claim(id="clm-open", policy_id="p1", coverage_line="gl",
                status="notified", date_of_loss=date(2026, 1, 1),
                fnol_submitted_at=NOW - timedelta(days=5)))
    s.commit()
    ids = [c.id for c in list_claims(s)]
    assert ids.index("clm-open") < ids.index("clm-closed")


def test_list_submissions_orders_quoting_before_open():
    s = _session()
    s.add(Submission(id="sub-open", venue_id="v1", status="open",
                     effective_date=date(2026, 7, 1), created_at=NOW))
    s.add(Submission(id="sub-quoting", venue_id="v1", status="quoting",
                     effective_date=date(2026, 7, 1), created_at=NOW - timedelta(days=3)))
    s.commit()
    ids = [x.id for x in list_submissions(s)]
    assert ids.index("sub-quoting") < ids.index("sub-open")


def test_list_policies_orders_soonest_expiry_first():
    s = _session()

    def _pol(pid, exp):
        return Policy(id=pid, policy_number=pid, submission_id=f"s-{pid}",
                      bound_quote_id=f"q-{pid}", venue_id="v1", carrier_id="c1",
                      status="active", effective_date=date(2026, 1, 1),
                      expiration_date=exp, annual_premium=Decimal("0"),
                      commission_amount=Decimal("0"), commission_rate=Decimal("0"))

    s.add(_pol("pol-late", date(2027, 12, 1)))
    s.add(_pol("pol-soon", date(2026, 7, 1)))
    s.commit()
    ids = [p.id for p in list_policies(s)]
    assert ids.index("pol-soon") < ids.index("pol-late")
