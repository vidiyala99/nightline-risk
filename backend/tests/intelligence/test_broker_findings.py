from datetime import datetime, timezone, timedelta, date
from decimal import Decimal

from app.intelligence.finding import FindingScope
from app.intelligence.findings.coverage_gap_eo import find as find_gap
from app.intelligence.findings.renewal_at_risk import find as find_risk
from app.intelligence.findings.submission_stalled import find as find_stalled
from app.models import Policy, CoverageLine, Submission, PolicyRequest

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _scope(session):
    # broker => venue_ids None (unrestricted)
    return FindingScope(persona="broker", user={"sub": "b1", "role": "broker"},
                        venue_ids=None, session=session, now=NOW)


def _coverage_lines(session):
    session.add(CoverageLine(id="gl", name="General Liability", description="d",
                             is_required_by_default=True,
                             default_per_occurrence_limit=Decimal("1000000")))
    session.add(CoverageLine(id="liquor", name="Liquor Liability", description="d",
                             is_required_by_default=False,
                             default_per_occurrence_limit=Decimal("1000000")))


def test_coverage_gap_flags_missing_required_line(session):
    _coverage_lines(session)
    session.add(Policy(id="pol-1", submission_id="s1", bound_quote_id="q1",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0"), coverage_lines=["liquor"]))
    session.commit()
    findings = find_gap(_scope(session))
    assert len(findings) == 1
    assert findings[0].kind == "coverage_gap_eo"
    assert "gl" in findings[0].why[0].excerpt


def test_renewal_at_risk_flags_expiring_without_request(session):
    session.add(Policy(id="pol-2", submission_id="s2", bound_quote_id="q2",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0")))
    session.add(Policy(id="pol-3", submission_id="s3", bound_quote_id="q3",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0")))
    # pol-3 already has a renewal request in motion -> not at risk
    session.add(PolicyRequest(id="preq-1", policy_id="pol-3", venue_id="v1",
                              request_type="renewal", status="pending", requested_by="op"))
    session.commit()
    ids = {f.subject.entity_id for f in find_risk(_scope(session))}
    assert ids == {"pol-2"}


def test_submission_stalled_flags_old_non_terminal(session):
    session.add(Submission(id="sub-1", venue_id="v1", status="in_market",
                           effective_date=date(2026, 7, 1),
                           updated_at=NOW - timedelta(days=20)))
    session.add(Submission(id="sub-2", venue_id="v1", status="bound",
                           effective_date=date(2026, 7, 1),
                           updated_at=NOW - timedelta(days=90)))  # terminal -> skip
    session.add(Submission(id="sub-3", venue_id="v1", status="quoting",
                           effective_date=date(2026, 7, 1),
                           updated_at=NOW - timedelta(days=2)))  # fresh -> skip
    session.commit()
    ids = {f.subject.entity_id for f in find_stalled(_scope(session))}
    assert ids == {"sub-1"}
