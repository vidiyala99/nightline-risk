"""Build the static NYC nightlife market-map dataset.

Fetch-once pipeline (Approach A):
  1. Fetch active liquor licenses for the five NYC counties from the NY Open
     Data SODA API (dataset 9s3h-dpkz — the publicly accessible one; hrvs-fxs2
     requires login).
  2. Keep on-premises NIGHTLIFE license descriptions (Club / Cabaret / Bottle
     Club / Food & Beverage Business); drop grocery, liquor stores, wholesale,
     restaurants, and supplementary "additional bar" permits.
  3. Read coordinates from the dataset's built-in `georeference` GeoJSON Point
     (no external geocoder needed).
  4. Classify + estimate via scripts.nyc_market_lib (reuses PremiumCalculator
     + check_appetite).
  5. Emit frontend/public/nyc_market.json (venues[] + aggregate).

Run from the backend/ directory:
    python -m scripts.build_nyc_market
    MARKET_MAX_VENUES=50 python -m scripts.build_nyc_market   # quick run

Scope is NYC only (the five counties). Re-running overwrites the JSON.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx  # noqa: E402

from scripts.nyc_market_lib import COUNTY_TO_BOROUGH, aggregate, dedupe_rows, transform_record  # noqa: E402

SODA_URL = "https://data.ny.gov/resource/9s3h-dpkz.json"

# Nightlife license descriptions to keep (see the live histogram). Clubs +
# cabarets + bottle clubs are true nightlife; "Food & Beverage Business" is the
# modern on-premises bar/lounge class. Easy to widen later.
NIGHTLIFE_DESCRIPTIONS = ["Club", "Cabaret", "Bottle Club", "Food & Beverage Business"]

MAX_VENUES = int(os.environ.get("MARKET_MAX_VENUES", "300"))

OUTPUT_PATH = Path(__file__).parent.parent.parent / "frontend" / "public" / "nyc_market.json"

METHODOLOGY_NOTE = (
    "Estimates only. Venues are real NYC on-premises nightlife licensees (NY "
    "State Liquor Authority open data). Current premium is a class-based market "
    "benchmark; Nightline figures are modeled (best-tier to market-neutral), "
    "not quotes. 'Likely carriers' is an appetite-based inference over carriers "
    "active in this space — not a statement of any venue's actual insurer. "
    "Actual pricing depends on a full underwriting review."
)


def _coords(record: dict) -> tuple[float | None, float | None]:
    geo = record.get("georeference") or {}
    coords = geo.get("coordinates") if isinstance(geo, dict) else None
    if coords and len(coords) == 2:
        lng, lat = coords
        try:
            return (float(lat), float(lng))
        except (TypeError, ValueError):
            pass
    return (None, None)


def fetch_nightlife(client: httpx.Client) -> list[dict]:
    counties = ",".join(f"'{c.title()}'" for c in COUNTY_TO_BOROUGH)
    descs = ",".join(f"'{d}'" for d in NIGHTLIFE_DESCRIPTIONS)
    params = {
        "$where": f"premisescounty in({counties}) AND description in({descs})",
        "$limit": "50000",
    }
    resp = client.get(SODA_URL, params=params, timeout=90.0)
    resp.raise_for_status()
    rows = resp.json()
    print(f"[fetch] {len(rows)} NYC nightlife license rows")
    return rows


def build() -> dict:
    venues: list[dict] = []
    seen_ids: set[str] = set()
    skipped_no_geo = 0
    # Prioritise true nightlife (clubs/cabarets) ahead of generic bars so the
    # MAX_VENUES cap yields a nightlife-weighted map, not 99% generic bars.
    priority = {"Cabaret": 0, "Bottle Club": 0, "Club": 1, "Food & Beverage Business": 2}

    with httpx.Client(headers={"User-Agent": "nightline-market-map/1.0"}) as client:
        rows = fetch_nightlife(client)
        rows.sort(key=lambda r: priority.get(str(r.get("description")), 3))
        for record in rows:
            if len(venues) >= MAX_VENUES:
                break
            lat, lng = _coords(record)
            row = transform_record(record, lat=lat, lng=lng)
            if row is None:
                skipped_no_geo += 1
                continue
            if row["id"] in seen_ids:
                continue
            seen_ids.add(row["id"])
            venues.append(row)

    venues = dedupe_rows(venues)
    print(f"[build] {len(venues)} venues kept, {skipped_no_geo} skipped (no coords)")
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "methodology_note": METHODOLOGY_NOTE,
        "aggregate": aggregate(venues),
        "venues": venues,
    }


def main() -> int:
    try:
        data = build()
    except httpx.HTTPError as e:
        print(f"[error] network/API failure: {e}", file=sys.stderr)
        return 1
    if data["aggregate"]["venue_count"] == 0:
        print("[error] produced 0 venues — check filters / column names", file=sys.stderr)
        return 1
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    agg = data["aggregate"]
    print(f"[done] wrote {agg['venue_count']} venues -> {OUTPUT_PATH}")
    print(f"       total market premium {agg['total_market_premium']}, "
          f"savings {agg['total_savings_low']}-{agg['total_savings_high']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
