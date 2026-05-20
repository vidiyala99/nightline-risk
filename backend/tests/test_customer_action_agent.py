"""Customer-action agent: actions should be risk-type and signal aware.

Before this work, `_run_customer_action_agent` returned two hardcoded items
regardless of incident. After: the action list is shaped by the risk type
(altercation/premises/liquor/medical) and by hard signals (injury, police,
EMS). The first item remains the universal evidence-preservation task so
contracts with existing consumers don't break.
"""

from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.schemas import IncidentCreate
from app.seed_data import KNOWLEDGE_SOURCES, STREAM_EVENTS, VENUES


VENUE_ID = "elsewhere-brooklyn"
VENUE_DATA = VENUES[VENUE_ID]


def _run(incident: IncidentCreate):
    runtime = UnderwritingPacketAgentRuntime()
    return runtime.execute(
        venue_id=VENUE_ID,
        venue=VENUE_DATA,
        incident=incident,
        knowledge_sources=KNOWLEDGE_SOURCES,
        stream_events=STREAM_EVENTS,
    )


def _make_incident(summary: str, **overrides) -> IncidentCreate:
    base = dict(
        occurred_at="2026-05-02T23:13:00Z",
        location="main floor",
        summary=summary,
        reported_by="shift-lead",
        injury_observed=False,
        police_called=False,
        ems_called=False,
    )
    base.update(overrides)
    return IncidentCreate(**base)


def _titles(result) -> list[str]:
    return [a.title.lower() for a in result.action_plan]


def _any(titles: list[str], *needles: str) -> bool:
    return any(any(n in t for n in needles) for t in titles)


# ─── Always-on base action ───────────────────────────────────────────

def test_first_action_is_always_preserve_evidence():
    """Backwards-compatible contract: the first action remains the universal
    preservation task. Existing consumers (brawl-flow test, frontend) pin to
    this position."""
    result = _run(_make_incident("Two patrons began fighting near the rear bar."))
    assert result.action_plan[0].title == "Preserve incident evidence"


# ─── Risk-type branching ─────────────────────────────────────────────

def test_altercation_adds_party_isolation_and_security_narrative():
    result = _run(_make_incident("Brawl between four patrons in the smoking patio."))
    assert result.risk_signal.type == "altercation_event"
    titles = _titles(result)
    assert _any(titles, "isolat", "trespass", "security"), titles


def test_premises_liability_adds_site_inspection():
    result = _run(_make_incident("Patron slipped on stairs near coat check, fell to bottom."))
    assert result.risk_signal.type == "premises_liability"
    titles = _titles(result)
    assert _any(titles, "site", "inspect", "hazard", "photo"), titles


def test_liquor_liability_adds_pour_log_documentation():
    result = _run(_make_incident("Intoxicated patron over-served; cutoff not enforced for an hour."))
    assert result.risk_signal.type == "liquor_liability"
    titles = _titles(result)
    assert _any(titles, "pour", "service log", "cutoff", "training"), titles


def test_medical_emergency_adds_hospital_records_request():
    result = _run(_make_incident("Patron overdosed and was transported, unresponsive on arrival."))
    assert result.risk_signal.type == "medical_emergency"
    titles = _titles(result)
    assert _any(titles, "hospital", "release", "transport"), titles


# ─── Hard-signal escalation ───────────────────────────────────────────

def test_police_called_adds_police_report_request():
    result = _run(_make_incident(
        "Brawl involving four patrons.",
        police_called=True,
    ))
    titles = _titles(result)
    assert _any(titles, "police report", "incident number", "officer"), titles


def test_ems_called_adds_transport_documentation():
    result = _run(_make_incident(
        "Patron slipped on stairs near coat check.",
        ems_called=True,
    ))
    titles = _titles(result)
    assert _any(titles, "ems", "transport", "paramedic", "ambulance"), titles


def test_injury_observed_raises_witness_contact_priority():
    result = _run(_make_incident(
        "Brawl between two patrons.",
        injury_observed=True,
    ))
    titles = _titles(result)
    assert _any(titles, "witness", "contact"), titles


# ─── Quality bar ──────────────────────────────────────────────────────

def test_action_count_scales_with_signals():
    """A clean incident produces a smaller action list than a worst-case one
    with all hard signals. This is the regression that catches a future
    'I dropped a branch' bug."""
    quiet = _run(_make_incident("Patron asked to leave for smoking inside. No injury."))
    worst = _run(_make_incident(
        "Brawl resulting in one patron transported.",
        injury_observed=True,
        police_called=True,
        ems_called=True,
    ))
    assert len(worst.action_plan) > len(quiet.action_plan)


def test_actions_have_non_empty_rationale_and_evidence():
    result = _run(_make_incident("Brawl in the patio with one injury.", injury_observed=True))
    for action in result.action_plan:
        assert action.title.strip(), f"empty title: {action!r}"
        assert action.rationale.strip(), f"empty rationale: {action!r}"
        assert all(e.strip() for e in action.evidence_needed), f"empty evidence in {action!r}"
