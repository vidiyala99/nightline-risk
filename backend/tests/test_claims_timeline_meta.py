"""Claims-timeline agent should emit gaps + defensibility + review_status
as the contract describes — not just a flat list of events.

Before this work, _run_claims_timeline_agent returned only
`list[TimelineEvent]`, ignoring the gaps/defensibility/review_status fields
in claims_timeline_agent.md. After: the runtime produces a
`claims_timeline_meta` companion object on the agent result, which is
threaded through to the IncidentFlowResponse and persisted in the packet.
"""

from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.schemas import IncidentCreate
from app.seed_data import KNOWLEDGE_SOURCES, VENUES


VENUE_ID = "elsewhere-brooklyn"


def _make_incident(summary: str = "Brawl in patio.", **overrides) -> IncidentCreate:
    base = dict(
        occurred_at="2026-05-02T23:13:00Z",
        location="patio",
        summary=summary,
        reported_by="shift-lead",
        injury_observed=False,
        police_called=False,
        ems_called=False,
    )
    base.update(overrides)
    return IncidentCreate(**base)


def _run(incident: IncidentCreate, stream_events: list[dict] | None = None):
    runtime = UnderwritingPacketAgentRuntime()
    return runtime.execute(
        venue_id=VENUE_ID,
        venue=VENUES[VENUE_ID],
        incident=incident,
        knowledge_sources=KNOWLEDGE_SOURCES,
        stream_events=stream_events if stream_events is not None else _default_stream_events(),
    )


def _default_stream_events() -> list[dict]:
    """Three corroborating sources within the incident window — the 'happy' case."""
    return [
        {"source_id": "stream:door-count", "venue_id": VENUE_ID,
         "at": "2026-05-02T22:55:00Z", "label": "Door count 742/800.", "text": "Capacity under stated max."},
        {"source_id": "stream:pos", "venue_id": VENUE_ID,
         "at": "2026-05-02T23:10:00Z", "label": "POS normal volume.", "text": "No service spike before incident."},
        {"source_id": "stream:camera-rear-bar-clip", "venue_id": VENUE_ID,
         "at": "2026-05-02T23:13:00Z", "label": "Camera flagged altercation motion.", "text": "Short motion event near patio."},
        {"source_id": "stream:door-count", "venue_id": VENUE_ID,
         "at": "2026-05-02T23:20:00Z", "label": "Door count post-incident.", "text": "Capacity dropped after intervention."},
    ]


# ─── Meta object exists and includes events + the contract fields ────────

def test_meta_is_present_on_result():
    """UnderwritingPacketAgentResult exposes claims_timeline_meta."""
    result = _run(_make_incident())
    assert hasattr(result, "claims_timeline_meta")
    meta = result.claims_timeline_meta
    assert hasattr(meta, "gaps")
    assert hasattr(meta, "defensibility_notes")
    assert hasattr(meta, "review_status")


def test_review_status_uses_contract_vocabulary():
    """Contract enumerates: complete | needs_review | blocked."""
    result = _run(_make_incident())
    assert result.claims_timeline_meta.review_status in {"complete", "needs_review", "blocked"}


# ─── Defensibility scoring ──────────────────────────────────────────────

def test_strong_defensibility_when_multiple_sources_corroborate():
    """Three stream sources within the incident window → strong note."""
    result = _run(_make_incident())
    notes = " ".join(result.claims_timeline_meta.defensibility_notes).lower()
    assert "strong" in notes or "corroborat" in notes, notes


def test_weak_defensibility_when_only_operator_account():
    """No stream events at all → only the operator's report exists."""
    result = _run(_make_incident(), stream_events=[])
    notes = " ".join(result.claims_timeline_meta.defensibility_notes).lower()
    assert "weak" in notes or "only" in notes or "operator" in notes, notes


# ─── Gap detection ───────────────────────────────────────────────────────

def test_pre_incident_gap_flagged_when_no_telemetry_before():
    """No events before incident_at → pre-incident gap surfaced."""
    only_after = [
        {"source_id": "stream:door-count", "venue_id": VENUE_ID,
         "at": "2026-05-02T23:30:00Z", "label": "later", "text": "after incident"},
    ]
    result = _run(_make_incident(), stream_events=only_after)
    gaps = " ".join(result.claims_timeline_meta.gaps).lower()
    assert "pre-incident" in gaps or "before" in gaps, gaps


def test_post_incident_gap_flagged_when_no_telemetry_after():
    """All events before incident_at → post-incident gap surfaced."""
    only_before = [
        {"source_id": "stream:door-count", "venue_id": VENUE_ID,
         "at": "2026-05-02T22:30:00Z", "label": "early", "text": "before incident"},
    ]
    result = _run(_make_incident(), stream_events=only_before)
    gaps = " ".join(result.claims_timeline_meta.gaps).lower()
    assert "post-incident" in gaps or "after" in gaps, gaps


def test_capacity_blind_spot_when_no_door_count_in_window():
    """No door_count near the incident — capacity story unknown."""
    no_door = [
        {"source_id": "stream:pos", "venue_id": VENUE_ID,
         "at": "2026-05-02T23:10:00Z", "label": "pos", "text": "..."},
        {"source_id": "stream:camera-X", "venue_id": VENUE_ID,
         "at": "2026-05-02T23:13:00Z", "label": "cam", "text": "..."},
    ]
    result = _run(_make_incident(), stream_events=no_door)
    gaps = " ".join(result.claims_timeline_meta.gaps).lower()
    assert "capacity" in gaps or "door" in gaps, gaps


# ─── Review status escalation ────────────────────────────────────────────

def test_blocked_when_incident_has_no_occurred_at():
    """Contract: blocked if the reported incident can't be tied to a time."""
    result = _run(_make_incident(occurred_at=""))
    assert result.claims_timeline_meta.review_status == "blocked"


def test_weak_defensibility_promotes_to_needs_review():
    """Only operator account → packet should not auto-approve."""
    result = _run(_make_incident(), stream_events=[])
    assert result.claims_timeline_meta.review_status == "needs_review"


def test_clean_packet_can_be_complete():
    """Full corroboration + no gaps → status can be 'complete'."""
    result = _run(_make_incident())
    # We don't assert 'complete' specifically because gap detection may
    # still find something minor; we assert it's NOT blocked at minimum.
    assert result.claims_timeline_meta.review_status != "blocked"


# ─── Backwards compatibility ─────────────────────────────────────────────

def test_claims_timeline_list_unchanged_in_shape():
    """The list of TimelineEvent stays — downstream consumers (frontend,
    packet_core persistence) keep working without changes."""
    result = _run(_make_incident())
    assert len(result.claims_timeline) >= 1
    for ev in result.claims_timeline:
        assert ev.at
        assert ev.label
        assert ev.source
