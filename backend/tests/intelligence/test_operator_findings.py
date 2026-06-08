from datetime import datetime, timezone, timedelta, date

from app.intelligence.finding import FindingScope
from app.intelligence.findings.compliance_overdue import find as find_compliance
from app.intelligence.findings.renewal_approaching import find as find_renewal
from app.models import ComplianceSignal, Policy

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _scope(session):
    return FindingScope(persona="venue_operator", user={"sub": "u1"},
                        venue_ids={"v1"}, session=session, now=NOW)


def test_compliance_overdue_flags_open_and_escalates_old(session):
    session.add(ComplianceSignal(
        id="c1", venue_id="v1", title="Fire exit blocked", description="d",
        provenance="underwriter_verified", severity="medium", status="open",
        created_at=NOW - timedelta(days=40),
    ))
    session.add(ComplianceSignal(
        id="c2", venue_id="v1", title="Resolved", description="d",
        provenance="auto_generated", severity="high", status="resolved",
    ))
    session.commit()
    findings = find_compliance(_scope(session))
    assert len(findings) == 1
    assert findings[0].subject.entity_id == "c1"
    assert findings[0].severity == "high"  # 40 days old escalates medium -> high


def test_renewal_approaching_flags_within_window(session):
    session.add(Policy(
        id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id="v1",
        carrier_id="c1", status="active",
        effective_date=date(2025, 6, 20), expiration_date=date(2026, 6, 20),  # 12 days out
        annual_premium=0, commission_amount=0, commission_rate=0,
    ))
    session.add(Policy(
        id="pol-2", submission_id="s2", bound_quote_id="q2", venue_id="v1",
        carrier_id="c1", status="active",
        effective_date=date(2025, 1, 1), expiration_date=date(2027, 1, 1),  # far out
        annual_premium=0, commission_amount=0, commission_rate=0,
    ))
    session.commit()
    findings = find_renewal(_scope(session))
    assert [f.subject.entity_id for f in findings] == ["pol-1"]
    assert findings[0].severity == "high"  # <=14 days
