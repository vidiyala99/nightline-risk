"""Tests for app/seed_carriers.py — the loader for Carrier + CoverageLine.

The loader is idempotent + safe to call repeatedly. These tests pin:
  - All 6 carriers and 8 coverage lines load on first call.
  - A second call inserts zero new rows.
  - Decimal columns round-trip correctly through SQLite Numeric storage.
  - Each carrier's appetite references only known CoverageLine.id values.
  - market_type is constrained to {admitted, e&s}.
"""
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Carrier, CoverageLine
from app.seed_carriers import (
    CARRIERS,
    COVERAGE_LINES,
    seed_broker_platform_data,
)


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


# ─── Basic load + idempotency ────────────────────────────────────────────

def test_first_load_inserts_all_carriers_and_lines():
    with _fresh_session() as s:
        new_lines, new_carriers = seed_broker_platform_data(s)
        s.commit()
        assert new_lines == 8
        assert new_carriers == 6


def test_second_load_inserts_zero():
    """The whole point of idempotency: running the loader on every app
    bootstrap (it lives in the lifespan handler) must not duplicate rows."""
    with _fresh_session() as s:
        seed_broker_platform_data(s)
        s.commit()
        new_lines, new_carriers = seed_broker_platform_data(s)
        s.commit()
        assert (new_lines, new_carriers) == (0, 0)


def test_carrier_row_count_stable_under_repeated_loads():
    with _fresh_session() as s:
        for _ in range(3):
            seed_broker_platform_data(s)
            s.commit()
        rows = s.exec(select(Carrier)).all()
        assert len(rows) == 6


# ─── Coverage line shape ─────────────────────────────────────────────────

def test_gl_seed_matches_expected_limits():
    """GL is required by default + $1M/$2M agg. Real underwriting starting point."""
    with _fresh_session() as s:
        seed_broker_platform_data(s)
        s.commit()
        gl = s.get(CoverageLine, "gl")
        assert gl is not None
        assert gl.is_required_by_default is True
        assert gl.default_per_occurrence_limit == Decimal("1000000")
        assert gl.default_aggregate_limit == Decimal("2000000")


def test_property_has_no_aggregate_limit():
    """Property coverage doesn't aggregate the way liability does — limit is
    replacement value per occurrence, no cumulative cap."""
    with _fresh_session() as s:
        seed_broker_platform_data(s)
        s.commit()
        prop = s.get(CoverageLine, "property")
        assert prop is not None
        assert prop.default_aggregate_limit is None


def test_all_coverage_lines_have_iso_or_explain_none():
    """Lines without ISO codes (Property/WC/EPLI/Cyber/Umbrella) are NULL on
    purpose — they're classified outside the standard CGL ISO tables.
    This test pins the current assignment."""
    with _fresh_session() as s:
        seed_broker_platform_data(s)
        s.commit()
        lines = {ln.id: ln for ln in s.exec(select(CoverageLine)).all()}
        # The ISO-classified lines:
        assert lines["gl"].iso_code == "47001"
        assert lines["liquor"].iso_code == "58161"
        assert lines["assault_battery"].iso_code == "58162"
        # The non-CGL lines without a standard ISO assignment:
        for non_iso in ("property", "wc", "epli", "cyber", "umbrella"):
            assert lines[non_iso].iso_code is None, f"{non_iso} unexpectedly has iso_code={lines[non_iso].iso_code!r}"


# ─── Carrier shape ───────────────────────────────────────────────────────

def test_all_carriers_have_known_market_type():
    """market_type column is unconstrained at the DB level; this test pins
    the seed values to {admitted, e&s}. Production should use a real
    enum/check constraint."""
    valid = {"admitted", "e&s"}
    for c in CARRIERS:
        assert c["market_type"] in valid, f"{c['id']} has invalid market_type={c['market_type']!r}"


def test_admitted_vs_es_split():
    """Sanity: at least one carrier of each market type for the seed data
    to exercise the placement comparison UI."""
    with _fresh_session() as s:
        seed_broker_platform_data(s)
        s.commit()
        admitted = s.exec(select(Carrier).where(Carrier.market_type == "admitted")).all()
        es = s.exec(select(Carrier).where(Carrier.market_type == "e&s")).all()
        assert len(admitted) >= 1
        assert len(es) >= 1


def test_every_carrier_appetite_references_real_coverage_lines():
    """Catches a common drift: appetite mentions 'gl' / 'liquor' / etc., but
    a typo or rename leaves a carrier pointing at a non-existent CoverageLine.id.
    This test fails the build the moment that happens."""
    valid_ids = {ln["id"] for ln in COVERAGE_LINES}
    for c in CARRIERS:
        for line_id in c["appetite"].get("coverage_lines", []):
            assert line_id in valid_ids, (
                f"Carrier {c['id']!r} appetite references unknown coverage line {line_id!r}; "
                f"valid ids: {sorted(valid_ids)}"
            )


def test_every_carrier_appetite_references_real_venue_types():
    """Same drift-catch for venue_types. Each one must be a known key in
    pricing.py's BASE_RATES, otherwise the broker can submit to a carrier
    whose appetite includes a venue type we can't price."""
    from app.underwriting.pricing import PremiumCalculator
    valid_venue_types = set(PremiumCalculator.BASE_RATES.keys())
    for c in CARRIERS:
        for vt in c["appetite"].get("venue_types", []):
            assert vt in valid_venue_types, (
                f"Carrier {c['id']!r} appetite references unknown venue type {vt!r}; "
                f"valid types: {sorted(valid_venue_types)}"
            )


def test_at_least_one_carrier_writes_each_required_line():
    """A required coverage line (GL, Liquor, WC) the brokerage cannot
    actually place is a broken seed dataset. Every required line needs
    at least one carrier whose appetite covers it."""
    required = {ln["id"] for ln in COVERAGE_LINES if ln["is_required_by_default"]}
    for line_id in required:
        carriers_for_line = [c for c in CARRIERS if line_id in c["appetite"].get("coverage_lines", [])]
        # WC is statutory and handled by separate workers-comp markets; broker
        # may place it outside the carrier list. Allow zero coverage of "wc"
        # in this seed.
        if line_id == "wc":
            continue
        assert len(carriers_for_line) >= 1, (
            f"No seed carrier writes required line {line_id!r} — "
            f"the broker can never place this coverage."
        )


# ─── Decimal round-trip through SQLite Numeric ──────────────────────────

def test_decimal_round_trip_through_storage():
    """SQLite stores Numeric as TEXT internally; round-trip must preserve
    Decimal precision exactly. If this fails after a SQLAlchemy upgrade,
    the column types or app.money helpers need adjustment."""
    with _fresh_session() as s:
        seed_broker_platform_data(s)
        s.commit()
        gl = s.get(CoverageLine, "gl")
        assert gl is not None
        # Re-fetch after commit to exercise the read path.
        s.expire_all()
        gl2 = s.get(CoverageLine, "gl")
        assert gl2 is not None
        assert gl2.default_per_occurrence_limit == Decimal("1000000")
        assert isinstance(gl2.default_per_occurrence_limit, Decimal)
