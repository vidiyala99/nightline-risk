"""Tests for app/ingestion/runner.py — the entry point both the CLI and the
in-process tick call."""
import json

from sqlmodel import Session, SQLModel, create_engine, select

from app.ingestion.runner import run
from app.models import IngestionRun, Venue, VenueOperationalEvent
from app.underwriting.scoring import get_risk_score


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_run_pos_moves_a_venue_score():
    s = _session()
    venue = {
        "name": "Elsewhere",
        "incident_count": 0,
        "compliance_items": 0,
        "security_level": "high",
        "years_in_operation": 10,
        "venue_type": "club",
    }
    s.add(Venue(id="v1", name="Elsewhere", venue_data=json.dumps(venue)))
    s.commit()
    venues = {"v1": dict(venue)}

    before = get_risk_score("v1", {"v1": dict(venue)})["total_score"]
    runs = run("pos", s, venues=venues)

    assert len(runs) == 1
    assert runs[0].status == "success"
    assert runs[0].loaded == 1
    # the in-memory venues dict now carries operational_data → score moved
    after = get_risk_score("v1", venues)["total_score"]
    assert after < before
    assert len(s.exec(select(VenueOperationalEvent)).all()) == 1


def test_run_all_executes_every_registered_source():
    s = _session()
    venues = {"v1": {"name": "X", "security_level": "high"}}
    s.add(Venue(id="v1", name="X", venue_data=json.dumps(venues["v1"])))
    s.commit()

    runs = run("all", s, venues=venues)
    sources = {r.source_system for r in runs}
    assert "pos" in sources and "nyc_open_data" in sources
    # every run is logged
    assert len(s.exec(select(IngestionRun)).all()) == len(runs)


def test_run_objects_readable_after_session_closes():
    # The CLI prints the returned IngestionRun summary after its `with Session`
    # block exits. Committing expires attributes, so the runner must return
    # detached-but-populated objects (refresh + expunge), or this raises
    # DetachedInstanceError.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    venues = {"v1": {"name": "X", "security_level": "high"}}
    with Session(engine) as s:
        s.add(Venue(id="v1", name="X", venue_data=json.dumps(venues["v1"])))
        s.commit()
        runs = run("all", s, venues=venues)
    # session is now closed; reading attributes must still work
    for r in runs:
        assert r.status == "success"
        _ = (r.source_system, r.loaded, r.skipped, r.rejected, r.watermark, r.error)


def test_run_unknown_source_raises():
    s = _session()
    try:
        run("not_a_source", s, venues={})
        assert False, "expected an error for an unknown source"
    except (KeyError, ValueError):
        pass
