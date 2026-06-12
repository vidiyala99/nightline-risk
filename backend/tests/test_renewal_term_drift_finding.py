"""The broker finding: an in-flight renewal whose proposed terms reduce coverage
vs the expiring policy — a dropped line, an added exclusion, a lowered limit, a
raised deductible, or a carrier swap — is direct broker E&O exposure (the silent
renewal change that gets brokers sued). Surfaced, severity-ranked, cited."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.models import CarrierQuote, Policy, Submission
from app.intelligence.finding import FindingScope
from app.intelligence.findings import renewal_term_drift

NOW = datetime(2026, 6, 12, tzinfo=timezone.utc)


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _scope(session: Session) -> FindingScope:
    return FindingScope(
        persona="broker", user={"sub": "b1", "role": "broker", "tenant_id": None},
        venue_ids=None, session=session, now=NOW,
    )


def _expiring(session, *, carrier="c1", terms=None, lines=("gl", "liquor")):
    session.add(Policy(
        id="pol-exp", submission_id="s0", bound_quote_id="q0", venue_id="v1",
        carrier_id=carrier, status="active",
        effective_date=date(2025, 6, 1), expiration_date=date(2026, 6, 1),
        annual_premium=Decimal("0"), commission_amount=Decimal("0"),
        commission_rate=Decimal("0"), coverage_lines=list(lines),
        terms_snapshot={"coverage_terms": terms or {
            "gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500", "exclusions": []},
            "liquor": {"per_occurrence": "1000000", "aggregate": "2000000"},
        }},
    ))


def _renewal(session, *, status="quoting", lines=("gl",), carrier="c1", quote_terms=None, selected=True):
    session.add(Submission(
        id="sub-ren", venue_id="v1", status=status,
        effective_date=date(2026, 6, 1), coverage_lines=list(lines),
        prior_policy_id="pol-exp",
    ))
    session.add(CarrierQuote(
        id="q-ren", submission_id="sub-ren", carrier_id=carrier, status="quoted",
        is_selected=selected, coverage_terms=quote_terms or {
            "gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500", "exclusions": []},
        },
    ))


def test_high_severity_when_a_line_is_dropped_at_renewal():
    s = _fresh_session()
    _expiring(s)                       # gl + liquor
    _renewal(s, lines=("gl",))         # liquor dropped
    s.commit()
    findings = renewal_term_drift.find(_scope(s))
    assert len(findings) == 1
    f = findings[0]
    assert f.kind == "renewal_term_drift"
    assert f.severity == "high"
    assert f.subject.entity_type == "policy"
    assert f.subject.entity_id == "pol-exp"
    assert f.subject.href == "/submissions/sub-ren"
    assert any("liquor" in c.excerpt.lower() for c in f.why)
    assert f.venue_id == "v1"


def test_high_severity_when_exclusion_added_at_renewal():
    s = _fresh_session()
    _expiring(s, lines=("gl",), terms={"gl": {"per_occurrence": "1000000", "exclusions": []}})
    _renewal(s, lines=("gl",), quote_terms={"gl": {"per_occurrence": "1000000", "exclusions": ["AssaultAndBattery"]}})
    s.commit()
    findings = renewal_term_drift.find(_scope(s))
    assert len(findings) == 1
    assert findings[0].severity == "high"
    assert any("assault" in c.excerpt.lower() for c in findings[0].why)


def test_medium_severity_when_only_carrier_changes():
    s = _fresh_session()
    _expiring(s, carrier="c1", lines=("gl",), terms={"gl": {"per_occurrence": "1000000"}})
    _renewal(s, carrier="c2", lines=("gl",), quote_terms={"gl": {"per_occurrence": "1000000"}})
    s.commit()
    findings = renewal_term_drift.find(_scope(s))
    assert len(findings) == 1
    assert findings[0].severity == "medium"


def test_no_finding_when_terms_are_identical():
    s = _fresh_session()
    same = {"gl": {"per_occurrence": "1000000", "aggregate": "2000000", "deductible": "2500", "exclusions": []}}
    _expiring(s, lines=("gl",), terms=same)
    _renewal(s, lines=("gl",), quote_terms=same)
    s.commit()
    assert renewal_term_drift.find(_scope(s)) == []


def test_no_finding_when_renewal_has_no_quote_yet():
    s = _fresh_session()
    _expiring(s, lines=("gl",))
    s.add(Submission(id="sub-ren", venue_id="v1", status="open",
                     effective_date=date(2026, 6, 1), coverage_lines=["gl"],
                     prior_policy_id="pol-exp"))
    s.commit()
    assert renewal_term_drift.find(_scope(s)) == []


def test_ignores_non_renewal_submissions():
    """A fresh-business submission (no prior_policy_id) is never a renewal diff."""
    s = _fresh_session()
    s.add(Submission(id="sub-new", venue_id="v1", status="quoting",
                     effective_date=date(2026, 6, 1), coverage_lines=["gl"]))
    s.commit()
    assert renewal_term_drift.find(_scope(s)) == []
