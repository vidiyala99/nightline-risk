"""Task 2 — copilot READ tools + scope + catalog.

Each read tool wraps an existing persona-gated service and returns a
`ToolResult` whose `citations` carry provenance, so grounding travels with
the data and is never invented by the model layer downstream.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

from app.copilot.tools import CopilotScope, TOOL_CATALOG, get_exposure
from app.models import Claim, IncidentRecord, Policy, Venue


def _scope(session) -> CopilotScope:
    return CopilotScope(
        user={"role": "venue_operator", "tenant_id": "v1"},
        venue_ids={"v1"},
        session=session,
        now=datetime(2026, 6, 8, tzinfo=timezone.utc),
    )


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_catalog_exposes_the_read_tools():
    names = {t.name for t in TOOL_CATALOG if t.kind == "read"}
    assert names == {"get_exposure", "get_risk_score", "list_open_claims",
                     "list_incidents", "get_policy"}


def test_get_exposure_returns_grounded_findings(monkeypatch):
    from app.copilot import tools
    from app.intelligence.finding import Finding, Subject, RecommendedAction, Prediction
    fake = [Finding(id="evidence_gap:inc-1", persona="venue_operator", kind="evidence_gap",
                    subject=Subject(entity_type="incident", entity_id="inc-1", label="rear bar", href="/incidents/inc-1"),
                    severity="high", recommended_action=RecommendedAction(label="Attach evidence", href="/incidents/inc-1"),
                    prediction=Prediction(claim="thin evidence weakens any claim"))]
    monkeypatch.setattr(tools, "compute_exposure", lambda user, session, now=None: fake)
    with make_session() as s:
        res = get_exposure(_scope(s), {})
    assert res.tool == "get_exposure"
    assert res.data["count"] == 1
    # Count answers carry a single nav link, not a per-item citation wall.
    assert res.data["nav_href"] == "/dashboard"
    assert res.citations == []


# ─── get_risk_score (seeded against a real VENUES entry) ─────────────────────

VENUE = "elsewhere-brooklyn"


def _risk_scope(session) -> CopilotScope:
    return CopilotScope(
        user={"role": "venue_operator", "tenant_id": VENUE},
        venue_ids={VENUE},
        session=session,
        now=datetime(2026, 6, 8, tzinfo=timezone.utc),
    )


def test_get_risk_score_returns_score_tier_and_citation():
    from app.copilot.tools import get_risk_score
    with make_session() as s:
        s.add(Venue(id=VENUE, name="Elsewhere"))
        s.commit()
        res = get_risk_score(_risk_scope(s), {})
    assert res.tool == "get_risk_score"
    assert isinstance(res.data["score"], int)
    assert res.data["tier"] in {"A", "B", "C", "D"}
    assert res.data["top_factor"]
    assert res.data["nav_href"].startswith("/risk-profile/")
    assert res.citations and res.citations[0].source_type == "risk_score"


def test_get_risk_score_no_venue_returns_empty_result():
    from app.copilot.tools import get_risk_score
    with make_session() as s:
        scope = CopilotScope(
            user={"role": "venue_operator", "tenant_id": None},
            venue_ids=None,
            session=s,
            now=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        res = get_risk_score(scope, {})
    assert res.tool == "get_risk_score"
    assert res.data == {}
    assert res.citations == []


# ─── list_open_claims (seeded Policy + Claim through the venue join) ─────────


def _seed_policy(session, venue_id=VENUE) -> Policy:
    pol = Policy(
        id=f"pol-{venue_id}",
        submission_id="sub-test",
        bound_quote_id="q-test",
        venue_id=venue_id,
        carrier_id="markel-specialty",
        status="active",
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("5000.00"),
        commission_amount=Decimal("750.00"),
        commission_rate=Decimal("0.15"),
        coverage_lines=["premises_liability"],
        terms_snapshot={},
        snapshot_hash="hash-test",
    )
    session.add(pol)
    session.flush()
    return pol


def test_list_open_claims_returns_open_claims_with_citations():
    from app.copilot.tools import list_open_claims
    with make_session() as s:
        s.add(Venue(id=VENUE, name="Elsewhere"))
        pol = _seed_policy(s)
        s.add(Claim(id="clm-open", policy_id=pol.id, coverage_line="premises_liability",
                    status="reserved", date_of_loss=date(2026, 1, 1)))
        s.add(Claim(id="clm-closed", policy_id=pol.id, coverage_line="premises_liability",
                    status="closed_paid", date_of_loss=date(2026, 1, 2)))
        s.commit()
        res = list_open_claims(_risk_scope(s), {})
    assert res.tool == "list_open_claims"
    assert res.data["count"] == 1
    assert res.data["items"][0]["id"] == "clm-open"
    assert res.data["items"][0]["status"] == "reserved"
    assert res.data["nav_href"] == "/claims"
    assert res.citations == []


# ─── list_incidents (shared incident_status_feed helper) ────────────────────


def test_list_incidents_returns_feed_with_citations():
    from app.copilot.tools import list_incidents
    with make_session() as s:
        s.add(Venue(id=VENUE, name="Elsewhere"))
        s.add(IncidentRecord(
            id="inc-1", venue_id=VENUE, occurred_at="2026-05-17T00:00:00Z",
            location="rear bar", summary="brawl at rear bar", reported_by="mgr",
            injury_observed=True, police_called=False, ems_called=False, status="open",
        ))
        s.commit()
        res = list_incidents(_risk_scope(s), {})
    assert res.tool == "list_incidents"
    assert res.data["count"] == 1
    item = res.data["items"][0]
    assert item["incident_id"] == "inc-1"
    assert item["summary"] == "brawl at rear bar"
    assert item["status"] == "open"
    assert res.data["nav_href"] == "/incidents"
    assert res.citations == []


# ─── get_policy (active Policy → premium + coverage, grounded by a citation) ──


def test_get_policy_returns_premium_coverage_and_citation():
    from app.copilot.tools import get_policy
    with make_session() as s:
        s.add(Venue(id=VENUE, name="Elsewhere"))
        pol = _seed_policy(s)
        pol.policy_number = "MSP-12345"
        s.add(pol)
        s.commit()
        res = get_policy(_risk_scope(s), {})
    assert res.tool == "get_policy"
    assert res.data["has_policy"] is True
    # Premium travels as a string (money is never a float), grounded by a citation.
    assert res.data["annual_premium"] == "5000.00"
    assert res.data["policy_number"] == "MSP-12345"
    assert res.data["coverage_lines"] == ["premises_liability"]
    assert res.data["nav_href"] == "/coverage"
    assert res.citations and res.citations[0].source_type == "policy"
    assert "5000.00" in res.citations[0].excerpt


def test_get_policy_no_active_policy_returns_has_policy_false():
    from app.copilot.tools import get_policy
    with make_session() as s:
        s.add(Venue(id=VENUE, name="Elsewhere"))
        s.commit()
        res = get_policy(_risk_scope(s), {})
    assert res.tool == "get_policy"
    assert res.data["has_policy"] is False
    assert res.data["nav_href"] == "/coverage"
    assert res.citations == []
