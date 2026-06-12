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


def test_coverage_gap_coerces_json_string_coverage_lines(session):
    # On Postgres, Policy.coverage_lines comes back as a JSON STRING, not a list.
    # The finding must still detect the missing required line. We can't make
    # SQLite return a string from a JSON column, so assert the coercion contract
    # the code now depends on directly, then confirm the normal path still works.
    from app.intelligence.findings import coverage_gap_eo

    # The Postgres shape (JSON string) and the SQLite shape (list) both coerce,
    # and None coerces to [] (no AttributeError, no char iteration).
    assert set(coverage_gap_eo._as_list('["liquor"]')) == {"liquor"}
    assert set(coverage_gap_eo._as_list(["liquor"])) == {"liquor"}
    assert coverage_gap_eo._as_list(None) == []

    # Behavioral path (list form on SQLite): the required "gl" line is missing.
    _coverage_lines(session)
    session.add(Policy(id="pol-9", submission_id="s9", bound_quote_id="q9",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0"), coverage_lines=["liquor"]))
    session.commit()
    findings = coverage_gap_eo.find(_scope(session))
    assert any(f.subject.entity_id == "pol-9" for f in findings)


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


def test_renewal_at_risk_suppressed_by_live_renewal_submission(session):
    # pol-4 is expiring but already has a live renewal Submission (the canonical
    # broker "Renew" action) -> not at risk. pol-2 (bare) is still flagged.
    session.add(Policy(id="pol-2", submission_id="s2", bound_quote_id="q2",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0")))
    session.add(Policy(id="pol-4", submission_id="s4", bound_quote_id="q4",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0")))
    session.add(Submission(id="sub-ren", venue_id="v1", status="open",
                           prior_policy_id="pol-4",
                           effective_date=date(2026, 7, 1)))
    session.commit()
    ids = {f.subject.entity_id for f in find_risk(_scope(session))}
    assert ids == {"pol-2"}


def test_coverage_gap_clears_after_add_coverage_endorsement(session):
    # End-to-end loop: a policy missing required "gl" fires the finding;
    # issuing an add_coverage endorsement for "gl" clears it.
    from app.services.policies import issue_endorsement

    _coverage_lines(session)
    session.add(Policy(id="pol-gap", submission_id="s1", bound_quote_id="q1",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0"), coverage_lines=["liquor"]))
    session.commit()
    assert any(f.subject.entity_id == "pol-gap" for f in find_gap(_scope(session)))

    issue_endorsement(
        session, "pol-gap",
        endorsement_type="add_coverage",
        effective_date=date(2026, 6, 1),
        terms_diff={"coverage_line": "gl", "per_occurrence_limit": "1000000"},
        issued_by="b1",
    )
    session.commit()
    assert not any(f.subject.entity_id == "pol-gap" for f in find_gap(_scope(session)))


def test_broker_finding_hrefs_are_action_scented(session):
    _coverage_lines(session)
    session.add(Policy(id="pol-h1", submission_id="s2", bound_quote_id="q2",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0"), coverage_lines=["gl"]))
    session.add(Policy(id="pol-h2", submission_id="s3", bound_quote_id="q3",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0"), coverage_lines=["liquor"]))
    session.commit()

    # Renewal CTA lands on the policy record (review coverage + loss history),
    # where the one-click Renew lives — the action-scent is the prominent Renew
    # button on that page, not a distinct URL.
    risk = next(f for f in find_risk(_scope(session)) if f.subject.entity_id == "pol-h1")
    assert risk.recommended_action.href == "/policies/pol-h1"
    assert risk.subject.href == "/policies/pol-h1"

    # Both links now route to the coverage-gap remediation page (current
    # coverage + every gap + how to close each); the per-line endorse deep-links
    # live as "Add this coverage" buttons inside that page.
    gap = next(f for f in find_gap(_scope(session)) if f.subject.entity_id == "pol-h2")
    assert gap.recommended_action.href == "/policies/pol-h2/gaps"
    assert gap.subject.href == "/policies/pol-h2/gaps"


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
