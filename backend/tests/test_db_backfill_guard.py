"""The compliance-signal backfill must run ONCE per engine (after venues are
seeded), not on every request. Running it per-request added 2 cross-region
SELECTs over ~291 venues to every endpoint, compounding into a 20-30s operator
dashboard load on a cold/​waking Neon under ~10 concurrent calls."""
from sqlmodel import SQLModel, create_engine

import app.database as db


def _fresh_engine():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    return eng


def test_backfill_runs_once_after_venues_present(monkeypatch):
    eng = _fresh_engine()
    monkeypatch.setattr(db, "engine", eng)
    db._bootstrapped_engines.add(eng)  # skip the (separate) DDL guard for this test
    db._backfilled_engines.discard(eng)

    calls = {"n": 0}

    def fake_backfill():
        calls["n"] += 1
        return True  # venues present → a full pass ran

    monkeypatch.setattr(db, "_backfill_compliance_signals", fake_backfill)

    db.create_db_and_tables()
    db.create_db_and_tables()
    db.create_db_and_tables()

    assert calls["n"] == 1, "backfill must run once per engine, not per request"
    assert eng in db._backfilled_engines


def test_backfill_retries_until_venues_present(monkeypatch):
    eng = _fresh_engine()
    monkeypatch.setattr(db, "engine", eng)
    db._bootstrapped_engines.add(eng)
    db._backfilled_engines.discard(eng)

    state = {"venues_seeded": False, "n": 0}

    def fake_backfill():
        state["n"] += 1
        return state["venues_seeded"]  # False until venues exist → keep retrying

    monkeypatch.setattr(db, "_backfill_compliance_signals", fake_backfill)

    db.create_db_and_tables()  # no venues → False → not marked
    db.create_db_and_tables()  # retries
    assert state["n"] == 2 and eng not in db._backfilled_engines

    state["venues_seeded"] = True
    db.create_db_and_tables()  # venues present → True → marked
    assert state["n"] == 3 and eng in db._backfilled_engines

    db.create_db_and_tables()  # now skipped forever
    assert state["n"] == 3
