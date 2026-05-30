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
