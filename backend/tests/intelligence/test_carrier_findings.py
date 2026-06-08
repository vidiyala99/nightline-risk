from datetime import datetime, timezone, date
from decimal import Decimal

from app.intelligence.finding import FindingScope
from app.intelligence.findings.reserve_light import find as find_reserve
from app.intelligence.findings.fraud_unreviewed import find as find_fraud
from app.models import Claim, EvidenceAnalysis

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _scope(session):
    return FindingScope(persona="carrier", user={"sub": "uw1", "role": "carrier"},
                        venue_ids=None, session=session, now=NOW)


def test_reserve_light_flags_paid_exceeding_reserve(session):
    session.add(Claim(id="clm-1", policy_id="pol-1", coverage_line="gl",
                      status="open", date_of_loss=date(2026, 5, 1),
                      current_reserve=Decimal("1000"),
                      indemnity_paid_to_date=Decimal("900"),
                      expense_paid_to_date=Decimal("300")))  # 1200 paid > 1000 reserve
    session.add(Claim(id="clm-2", policy_id="pol-1", coverage_line="gl",
                      status="open", date_of_loss=date(2026, 5, 1),
                      current_reserve=Decimal("5000"),
                      indemnity_paid_to_date=Decimal("100"),
                      expense_paid_to_date=Decimal("0")))  # healthy
    session.add(Claim(id="clm-3", policy_id="pol-1", coverage_line="gl",
                      status="closed_paid", date_of_loss=date(2026, 5, 1),
                      current_reserve=Decimal("0"),
                      indemnity_paid_to_date=Decimal("9999")))  # closed -> skip
    session.commit()
    ids = {f.subject.entity_id for f in find_reserve(_scope(session))}
    assert ids == {"clm-1"}


def test_fraud_unreviewed_flags_contradicted_corroboration(session):
    session.add(EvidenceAnalysis(id="ea-1", evidence_id="ev-1", incident_id="inc-1",
                                 analysis_type="video", corroboration="CONTRADICTED",
                                 status="complete"))
    session.add(EvidenceAnalysis(id="ea-2", evidence_id="ev-2", incident_id="inc-2",
                                 analysis_type="video", corroboration="CONSISTENT",
                                 status="complete"))
    session.commit()
    findings = find_fraud(_scope(session))
    assert [f.subject.entity_id for f in findings] == ["inc-1"]
    assert findings[0].severity == "high"
