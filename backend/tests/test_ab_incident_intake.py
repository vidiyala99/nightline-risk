"""A&B structured incident fields round-trip into the packet body + hash,
and old-style incidents (no A&B fields) still build (backward-compat)."""
from sqlmodel import Session, SQLModel, create_engine

from app.packet_core import create_packet_snapshot
from app.schemas import IncidentCreate

RISK = {"type": "altercation_event", "severity": "medium", "confidence": 0.8, "review_status": "needs_review"}
MEMO = {"summary": "m", "open_questions": [], "review_status": "draft"}


def _session() -> Session:
    e = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(e)
    return Session(e)


def _incident(**extra) -> IncidentCreate:
    base = dict(
        occurred_at="2026-05-02T23:13:00Z", location="rear bar", summary="brawl",
        reported_by="shift-lead", injury_observed=True, police_called=True, ems_called=False,
    )
    base.update(extra)
    return IncidentCreate(**base)


def test_ab_fields_serialize():
    inc = _incident(
        weapon_involved=True,
        incident_category="assault_battery",
        parties=[{"role": "aggressor", "description": "patron A"}],
        security_response=[{"action": "ejected", "at": "23:14"}],
        injury_detail="laceration to forehead",
    )
    d = inc.model_dump()
    assert d["weapon_involved"] is True
    assert d["incident_category"] == "assault_battery"
    assert d["parties"][0]["role"] == "aggressor"
    assert d["security_response"][0]["at"] == "23:14"
    assert d["injury_detail"] == "laceration to forehead"


def test_ab_fields_change_hash_and_old_style_still_builds():
    with _session() as s:
        plain = create_packet_snapshot(
            session=s, venue_id="elsewhere-brooklyn", incident_id="inc-plain",
            incident=_incident(), risk_signal=RISK, action_plan=[], claims_timeline=[],
            underwriting_memo=MEMO, citations=[], rubric_version="demo-rubric-v1",
        )
        enriched = create_packet_snapshot(
            session=s, venue_id="elsewhere-brooklyn", incident_id="inc-ab",
            incident=_incident(weapon_involved=True, incident_category="assault_battery"),
            risk_signal=RISK, action_plan=[], claims_timeline=[],
            underwriting_memo=MEMO, citations=[], rubric_version="demo-rubric-v1",
        )
        # Old-style incident built fine (backward-compat); A&B fields are in the hashed body.
        assert plain.snapshot_hash and enriched.snapshot_hash
        assert plain.snapshot_hash != enriched.snapshot_hash
