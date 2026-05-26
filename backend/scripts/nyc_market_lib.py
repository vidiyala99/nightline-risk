"""Pure (network-free) logic for the NYC nightlife market-map prep pipeline.

Split out from `build_nyc_market.py` so the classification + estimation +
aggregation logic is unit-testable without hitting the SLA / GeoSearch APIs.

Everything here reuses the existing pricing + appetite primitives so the
numbers are produced by the *same engine* the product uses:
  - app.underwriting.pricing.PremiumCalculator  (market vs tier-adjusted)
  - app.services.submissions.check_appetite      (likely-carrier inference)
  - app.seed_carriers.CARRIERS                   (the real-mapped carrier set)

Estimation methodology (see also the methodology_note emitted in the JSON):
  market_premium = Tier B baseline ("what a comparable venue pays without
                   Nightline intelligence").
  Third Space estimated premium range = Tier A (best case) .. Tier B (market
                   neutral). We do NOT extend to Tier C/D: those are surcharge
                   tiers (>market), and a *savings* surface shows achievable
                   savings, not the downside for a poorly-run venue. The
                   methodology note discloses that higher-risk venues may not
                   see savings.
  savings range  = market - ts_high (=0 at Tier B) .. market - ts_low (max, at
                   Tier A). savings_mid = midpoint, used for map coloring.

All money is emitted as cent-quantized strings via app.money.usd_to_json.
"""
from __future__ import annotations

import re
from decimal import Decimal

from app.models import Carrier
from app.money import usd, usd_to_json
from app.seed_carriers import CARRIERS
from app.services.submissions import check_appetite
from app.underwriting.pricing import PremiumCalculator

# Coverage profile assumed for a typical nightlife venue when inferring
# likely carriers (GL + liquor are near-universal; A&B is the nightlife driver).
NIGHTLIFE_COVERAGE: list[str] = ["gl", "liquor", "assault_battery"]

# Carrier objects built once from the real seeded set (no DB needed).
_CARRIERS: list[Carrier] = [Carrier(**row) for row in CARRIERS]

# NYC county name -> borough label (SLA data uses county names).
COUNTY_TO_BOROUGH: dict[str, str] = {
    "NEW YORK": "Manhattan",
    "KINGS": "Brooklyn",
    "QUEENS": "Queens",
    "BRONX": "The Bronx",
    "RICHMOND": "Staten Island",
}


# Names that unambiguously indicate a non-nightlife premises. The SLA
# "Food & Beverage Business" license class is broad enough to admit banks,
# delis, grocers, museums, and universities that happen to serve alcohol;
# their *names* are the only signal we have to drop them from a nightlife map.
_NON_NIGHTLIFE_TERMS = (
    "BANK", "DELI", "GROCERY", "SUPERMARKET", "BAGEL", "BAKERY", "PANADERIA",
    "PHARMACY", "MUSEUM", "UNIVERSITY", "CATERING", "CONCESSION",
)
# Social-venue words that keep a row even when a denylist word is also present
# (e.g. "THE UNIVERSITY CLUB", "BROOKLYN BOWL"). Genuine nightlife wins ties.
_NIGHTLIFE_GUARD = (
    "CLUB", "BOWL", "LOUNGE", "BAR", "TAVERN", "PUB", "CABARET", "NIGHTCLUB",
)


# Legal-entity tokens stripped from licensee names so a venue reads as a
# trade name, not an LLC. Compared case-insensitively, punctuation-stripped.
_LEGAL_TOKENS = {
    "inc", "incorporated", "llc", "llp", "lp", "corp", "corporation",
    "ltd", "limited", "co", "company",
}
# Acronyms kept uppercase through title-casing (most names have none).
_ACRONYMS = {"NYC", "NY", "USA", "DJ", "LIC", "BK", "LES", "II", "III", "IV"}
_SMALL_WORDS = {"of", "and", "a", "an", "at", "in", "on", "for", "to", "the", "&"}


def clean_venue_name(raw: str | None) -> str:
    """Turn a raw SLA licensee name into a presentable venue name.

    - Prefer the trade name after a 'DBA:' marker (drops the licensee/legal
      prefix, e.g. 'ARTISTS AS WAITRESSES INC AS MGR DBA: WOLLMAN RINK').
    - Strip trailing/standalone legal tokens (INC/LLC/CORP/LTD/CO…).
    - Smart title-case (preserve known acronyms, lowercase small connectors).
    """
    s = (raw or "").strip()
    if not s:
        return "Unnamed venue"
    m = re.search(r"\bD\.?\s*B\.?\s*A\.?[:.\s]+(.+)$", s, re.IGNORECASE)
    if m:
        s = m.group(1).strip()
    s = re.sub(r"[,/]+", " ", s)
    tokens = [t for t in s.split() if t.strip(".,&").lower() not in _LEGAL_TOKENS]
    cleaned = " ".join(tokens).strip()
    if not cleaned:
        cleaned = s  # all tokens were legal noise — fall back to the raw string
    return _smart_title(cleaned)


def _smart_title(s: str) -> str:
    words = s.split()
    out: list[str] = []
    for i, w in enumerate(words):
        bare = w.strip(".,")
        if bare.upper() in _ACRONYMS:
            out.append(bare.upper())
        elif i != 0 and w.lower() in _SMALL_WORDS:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)


def _norm(s: str | None) -> str:
    return " ".join((s or "").strip().casefold().split())


def dedupe_rows(rows: list[dict]) -> list[dict]:
    """Collapse rows that share a normalized (name, address); first wins."""
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for r in rows:
        key = (_norm(r.get("name")), _norm(r.get("address")))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def is_nightlife_name(name: str) -> bool:
    """True unless the venue name unambiguously reads as non-nightlife.

    Conservative: only drops a row when a denylist term appears *and* no
    social-venue guard word is present, so real bars/clubs/music venues
    survive even if their name contains a denylist substring.
    """
    upper = (name or "").upper()
    if any(re.search(rf"\b{term}", upper) for term in _NIGHTLIFE_GUARD):
        return True
    return not any(re.search(rf"\b{term}", upper) for term in _NON_NIGHTLIFE_TERMS)


def classify_venue_type(license_class: str, *, places_category: str | None = None) -> str:
    """Heuristic SLA-license-class -> PremiumCalculator venue_type.

    SLA license data only distinguishes coarse classes (on-premises liquor,
    tavern, club, cabaret), so this is intentionally coarse. `places_category`
    is the documented seam for future Google Places enrichment — when present
    it takes precedence and can resolve finer types (music_venue, rooftop_bar).
    Returns a key guaranteed to exist in PremiumCalculator.BASE_RATES.
    """
    text = f"{places_category or ''} {license_class or ''}".lower()

    if any(w in text for w in ("nightclub", "cabaret")):
        return "nightclub and performance space"
    if "club" in text:
        return "club"
    if any(w in text for w in ("music", "concert", "performance", "live")):
        return "music_venue"
    if "rooftop" in text:
        return "rooftop_bar"
    # tavern / on-premises liquor / bar / restaurant -> generic bar baseline.
    return "dive_bar"


def likely_carriers(venue_type: str, coverage_lines: list[str] | None = None) -> list[dict]:
    """Appetite-matched carriers for a venue_type (inference, not fact).

    Capacity is unknown from SLA data, so matching is on venue_type + coverage
    only (check_appetite skips the capacity dimension when capacity is 0).
    Admitted carriers are listed before E&S; ties broken by name.
    """
    coverage = coverage_lines or NIGHTLIFE_COVERAGE
    venue = {"venue_type": venue_type}  # no capacity -> capacity check skipped
    matched: list[dict] = []
    for carrier in _CARRIERS:
        ok, _reasons = check_appetite(carrier, venue, coverage)
        if ok:
            matched.append(
                {"id": carrier.id, "name": carrier.name, "market_type": carrier.market_type}
            )
    matched.sort(key=lambda c: (c["market_type"] != "admitted", c["name"]))
    return matched


def estimate_for_venue(venue_type: str, coverage_lines: list[str] | None = None) -> dict:
    """Compute market premium + Third Space savings range for a venue_type,
    reusing PremiumCalculator. Returns money as cent strings."""
    vid = "_est"
    calc = PremiumCalculator({vid: {"id": vid, "venue_type": venue_type}})
    market = usd(calc.calculate_quote(vid, tier_override="B").market_rate_annual)
    ts_best = usd(calc.calculate_quote(vid, tier_override="A").annual_premium)  # cheapest
    ts_neutral = market  # Tier B == market rate

    savings_high = usd(market - ts_best)   # best case (Tier A)
    savings_low = usd(market - ts_neutral)  # market-neutral (Tier B) -> 0
    savings_mid = usd((savings_high + savings_low) / 2)

    return {
        "venue_type": venue_type,
        "market_premium": usd_to_json(market),
        "ts_low": usd_to_json(ts_best),       # low end of TS premium (best tier)
        "ts_high": usd_to_json(ts_neutral),   # high end of TS premium (market neutral)
        "savings_low": usd_to_json(savings_low),
        "savings_high": usd_to_json(savings_high),
        "savings_mid": usd_to_json(savings_mid),
        "likely_carriers": likely_carriers(venue_type, coverage_lines),
    }


# ─── SLA record field accessors ──────────────────────────────────────────
# The hrvs-fxs2 SODA dataset's exact column names must be confirmed against a
# live sample; these readers try the common variants and fall back gracefully.

def _first(record: dict, *keys: str, default: str = "") -> str:
    for k in keys:
        v = record.get(k)
        if v:
            return str(v).strip()
    return default


def transform_record(record: dict, *, lat: float | None, lng: float | None) -> dict | None:
    """Map one SLA SODA record (+ geocoded coords) to a market-map venue row.

    Returns None when the row can't be placed on the map (no coordinates) —
    the caller skips+logs those. License-class filtering to nightlife happens
    upstream in the fetch script; this assembles the row + estimate.
    """
    if lat is None or lng is None:
        return None

    # Column names match the NY Open Data dataset 9s3h-dpkz.
    name = _first(record, "dba", "legalname", default="Unnamed venue")
    if not is_nightlife_name(name):
        return None
    address = _first(record, "actualaddressofpremises")
    city = _first(record, "city")
    county = _first(record, "premisescounty").upper()
    license_class = _first(record, "description")
    license_serial = _first(record, "licensepermitid", "legacyserialnumber", default=name)

    venue_type = classify_venue_type(license_class)
    est = estimate_for_venue(venue_type)

    row = {
        "id": license_serial,
        "name": clean_venue_name(name),
        "address": ", ".join(p for p in (address, city) if p),
        "borough": COUNTY_TO_BOROUGH.get(county, county.title()),
        "lat": lat,
        "lng": lng,
        "license_class": license_class,
    }
    row.update(est)
    return row


def aggregate(venues: list[dict]) -> dict:
    """Roll up the TAM summary across venue rows. Money as cent strings."""
    total_market = sum((Decimal(v["market_premium"]) for v in venues), Decimal("0"))
    total_low = sum((Decimal(v["savings_low"]) for v in venues), Decimal("0"))
    total_high = sum((Decimal(v["savings_high"]) for v in venues), Decimal("0"))

    by_borough: dict[str, int] = {}
    by_type: dict[str, int] = {}
    for v in venues:
        by_borough[v["borough"]] = by_borough.get(v["borough"], 0) + 1
        by_type[v["venue_type"]] = by_type.get(v["venue_type"], 0) + 1

    return {
        "venue_count": len(venues),
        "total_market_premium": usd_to_json(total_market),
        "total_savings_low": usd_to_json(total_low),
        "total_savings_high": usd_to_json(total_high),
        "by_borough": [{"borough": b, "count": c} for b, c in sorted(by_borough.items())],
        "by_type": [{"venue_type": t, "count": c} for t, c in sorted(by_type.items())],
    }
