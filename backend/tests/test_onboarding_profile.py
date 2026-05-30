"""Onboarding data capture — Venue coverage-profile columns, hydration overlay,
and the honest carrier bonus.

See docs/superpowers/specs/2026-05-29-onboarding-data-capture-design.md.
"""
from sqlmodel import Session

from app.database import create_db_and_tables, engine
from app.models import Venue


def test_venue_persists_coverage_profile_columns():
    # create_db_and_tables() applies the additive _COLUMN_MIGRATIONS to the
    # existing database.db (a bare Session(engine) doesn't run them; only
    # get_session() does — see database.py).
    create_db_and_tables()
    with Session(engine) as s:
        existing = s.get(Venue, "tcol-venue")
        if existing:
            s.delete(existing)
            s.commit()
        s.add(Venue(
            id="tcol-venue", name="Col Test",
            current_carrier="Hiscox",
            renewal_date="2026-09-01",
            coverage_interest='["gl","liquor"]',
            onboarding_complete=True,
        ))
        s.commit()
    with Session(engine) as s:
        v = s.get(Venue, "tcol-venue")
        assert v.current_carrier == "Hiscox"
        assert v.renewal_date == "2026-09-01"
        assert v.coverage_interest == '["gl","liquor"]'
        assert v.onboarding_complete is True


def test_resolve_venue_overlays_profile_columns():
    from app.api.v1.venues import VENUES, _resolve_venue
    from app.services.coverage_profile import set_coverage_profile

    create_db_and_tables()
    with Session(engine) as s:
        if not s.get(Venue, "ovl-1"):
            s.add(Venue(id="ovl-1", name="Overlay",
                        venue_data='{"name": "Overlay", "capacity": 200}'))
            s.commit()
        v = s.get(Venue, "ovl-1")
        set_coverage_profile(s, v, current_carrier="Chubb",
                             renewal_date="2026-10-01", coverage_interest=["gl"])
        s.commit()
    VENUES.pop("ovl-1", None)  # force a DB rehydrate, not a cache hit
    with Session(engine) as s:
        d = _resolve_venue("ovl-1", s)
        assert d["current_carrier"] == "Chubb"
        assert d["renewal_date"] == "2026-10-01"
        assert d["coverage_interest"] == ["gl"]
        assert d["onboarding_complete"] is True


def test_boolean_migrations_have_no_integer_default():
    """Postgres rejects an integer literal as a BOOLEAN default ('column is of type
    boolean but default expression is of type integer'). The migration loop swallows
    the failed ALTER, leaving the column absent on Postgres so every select(Venue)
    crashes — a 502 boot-loop that SQLite never reveals. Guard the whole table."""
    import re

    from app.database import _COLUMN_MIGRATIONS

    offenders = [
        (t, c, d)
        for (t, c, typ, d) in _COLUMN_MIGRATIONS
        if typ.upper() == "BOOLEAN" and d and re.search(r"\bDEFAULT\s+\d", d, re.IGNORECASE)
    ]
    assert not offenders, (
        f"BOOLEAN migrations with an integer default (Postgres-incompatible — use "
        f"false/true or no default): {offenders}"
    )


def _bp(venue):
    from app.underwriting.scoring import RiskScoringEngine
    return RiskScoringEngine({"v": venue})._score_business_profile(venue)


def test_real_carrier_earns_bonus():
    base = {"years_in_operation": 1, "venue_type": "bar"}
    assert _bp({**base, "current_carrier": "Hiscox"}) > _bp({**base, "current_carrier": None})


def test_sentinel_carrier_earns_no_bonus():
    base = {"years_in_operation": 1, "venue_type": "bar"}
    none_score = _bp({**base, "current_carrier": None})
    assert _bp({**base, "current_carrier": "uninsured"}) == none_score
    assert _bp({**base, "current_carrier": "unsure"}) == none_score
