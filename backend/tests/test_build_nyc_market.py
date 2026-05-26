"""Tests for the NYC market-map prep logic (scripts/nyc_market_lib.py).

Network-free: exercises classification, estimation (reusing PremiumCalculator),
record transformation, and aggregation against fixtures.
"""
from decimal import Decimal

from app.underwriting.pricing import PremiumCalculator
from scripts.nyc_market_lib import (
    aggregate,
    classify_venue_type,
    clean_venue_name,
    dedupe_rows,
    estimate_for_venue,
    is_nightlife_name,
    likely_carriers,
    transform_record,
)


def test_clean_venue_name_prefers_dba_and_strips_legal():
    assert clean_venue_name("ARTISTS AS WAITRESSES INC AS MGR DBA: WOLLMAN RINK") == "Wollman Rink"
    assert clean_venue_name("EDISON BALLROOM LLC") == "Edison Ballroom"
    assert clean_venue_name("AMERICAN LEGION INC") == "American Legion"


def test_clean_venue_name_title_cases_and_keeps_acronyms_and_the():
    assert clean_venue_name("MELROSE BALLROOM") == "Melrose Ballroom"
    assert clean_venue_name("LE POISSON ROUGE GROUP NYC, LLC") == "Le Poisson Rouge Group NYC"
    assert clean_venue_name("THE UNIVERSITY CLUB") == "The University Club"


def test_dedupe_rows_collapses_same_name_and_address():
    rows = [
        {"id": "1", "name": "Nexus Club", "address": "1 A St"},
        {"id": "2", "name": "nexus club ", "address": " 1 a st"},  # same after norm
        {"id": "3", "name": "Nexus Club", "address": "2 B Ave"},  # different address
    ]
    out = dedupe_rows(rows)
    assert [r["id"] for r in out] == ["1", "3"]


def test_is_nightlife_name_drops_clearly_non_nightlife():
    # Real names that slipped through the SLA license-class filter.
    for name in [
        "JPMORGAN CHASE BANK NATIONAL ASSOCIATION",
        "HARI DELI",
        "TOP NEWS & GROCERY",
        "LOWER EAST SIDE TENEMENT MUSEUM",
        "Syracuse University",
        "SPECTRUM CATERING AND CONCESSIONS",
        "ZARAGOZA MEXICAN DELI & GROCERY, INC.",
    ]:
        assert not is_nightlife_name(name), name


def test_is_nightlife_name_keeps_social_venues_with_denylist_words():
    # A denylist word must not drop a genuine bar/club/music venue.
    for name in [
        "THE UNIVERSITY CLUB",   # CLUB overrides UNIVERSITY
        "BROOKLYN BOWL LLC",     # music venue
        "COLLEGE POINT YACHT CLUB INC",
        "House of Yes",
        "Output",
    ]:
        assert is_nightlife_name(name), name


def test_transform_record_skips_non_nightlife_name():
    record = {
        "dba": "JPMORGAN CHASE BANK NATIONAL ASSOCIATION",
        "premisescounty": "New York",
        "description": "Food & Beverage Business",
        "licensepermitid": "999",
    }
    assert transform_record(record, lat=40.75, lng=-73.98) is None


def test_classify_always_maps_to_a_real_base_rate_key():
    samples = [
        "On-Premises Liquor", "Tavern Wine", "Cabaret", "Club Liquor",
        "Restaurant Wine", "", "Eating Place Beer",
    ]
    for s in samples:
        assert classify_venue_type(s) in PremiumCalculator.BASE_RATES


def test_classify_specific_cases():
    assert classify_venue_type("Cabaret") == "nightclub and performance space"
    assert classify_venue_type("Club Liquor") == "club"
    assert classify_venue_type("On-Premises Liquor") == "dive_bar"
    # Places enrichment seam takes precedence
    assert classify_venue_type("On-Premises Liquor", places_category="Live Music Venue") == "music_venue"


def test_estimate_savings_range_is_coherent():
    est = estimate_for_venue("music_venue")  # base 12000
    market = Decimal(est["market_premium"])
    ts_low = Decimal(est["ts_low"])
    ts_high = Decimal(est["ts_high"])
    savings_low = Decimal(est["savings_low"])
    savings_high = Decimal(est["savings_high"])

    # Tier A is cheapest; Tier B == market.
    assert ts_low < ts_high
    assert ts_high == market
    # Savings floor at market-neutral is exactly 0; ceiling is positive.
    assert savings_low == Decimal("0.00")
    assert savings_high > 0
    # Characterization against the real engine: Tier A = 0.7x base.
    assert ts_low == (market * Decimal("0.7")).quantize(Decimal("0.01"))
    assert savings_high == (market - ts_low).quantize(Decimal("0.01"))


def test_likely_carriers_are_appetite_matched_admitted_first():
    # A club is in Brit/Atrium/Burns&Wilcox appetite (E&S) but NOT Markel's.
    carriers = likely_carriers("club")
    ids = [c["id"] for c in carriers]
    assert "burns-wilcox" in ids          # writes all nightlife types
    assert "markel-specialty" not in ids  # club not in Markel's venue_types
    # Admitted carriers (if any matched) sort before E&S.
    market_types = [c["market_type"] for c in carriers]
    assert market_types == sorted(market_types, key=lambda m: m != "admitted")


def test_transform_record_builds_a_full_row():
    record = {
        "dba": "House of Yes",
        "actualaddressofpremises": "2 Wyckoff Ave",
        "city": "Brooklyn",
        "premisescounty": "Kings",
        "description": "Cabaret",
        "licensepermitid": "1234567",
    }
    row = transform_record(record, lat=40.7066, lng=-73.9229)
    assert row is not None
    assert row["id"] == "1234567"
    assert row["name"] == "House of Yes"
    assert row["borough"] == "Brooklyn"
    assert row["venue_type"] in PremiumCalculator.BASE_RATES
    assert row["venue_type"] == "nightclub and performance space"
    assert "savings_high" in row and "likely_carriers" in row


def test_transform_record_skips_when_no_coords():
    record = {"doing_business_as_name": "X", "county": "QUEENS", "license_type_name": "Tavern"}
    assert transform_record(record, lat=None, lng=None) is None


def test_aggregate_rolls_up():
    rows = [
        transform_record(
            {"dba": "A", "premisescounty": "Kings", "description": "Club", "licensepermitid": "1"},
            lat=40.7, lng=-73.9,
        ),
        transform_record(
            {"dba": "B", "premisescounty": "New York", "description": "Food & Beverage Business", "licensepermitid": "2"},
            lat=40.75, lng=-73.98,
        ),
    ]
    agg = aggregate(rows)
    assert agg["venue_count"] == 2
    assert Decimal(agg["total_savings_high"]) > 0
    assert {"borough": "Brooklyn", "count": 1} in agg["by_borough"]
    assert {"borough": "Manhattan", "count": 1} in agg["by_borough"]
