"""Seed data for the broker-platform tables (Carrier, CoverageLine).

All carriers and coverage lines here correspond to entities a real nightlife
broker would interact with. Names, NAIC codes, and ISO codes are accurate
to the extent we can verify; appetite descriptions are heuristic — real
appetite varies per program year and underwriter, so treat them as starting
hints not policy.

`seed_broker_platform_data` is idempotent: it inserts rows that don't yet
exist by id. Safe to call on every app bootstrap, in tests, and in scripts.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Sequence

from sqlmodel import Session

from app.models import Carrier, CoverageLine


# ─── Coverage Lines ───────────────────────────────────────────────────────
# id is the canonical short form used in Submission.coverage_lines / quote
# breakdowns. ISO classification codes are approximate — real underwriting
# uses more granular sub-codes per venue type. is_required_by_default flags
# the lines a NY nightlife venue almost always carries.

COVERAGE_LINES: list[dict] = [
    {
        "id": "gl",
        "name": "General Liability",
        "iso_code": "47001",
        "description": "Third-party bodily injury, property damage, personal & advertising injury.",
        "is_required_by_default": True,
        "default_per_occurrence_limit": Decimal("1000000"),
        "default_aggregate_limit": Decimal("2000000"),
        "default_deductible": Decimal("2500"),
    },
    {
        "id": "liquor",
        "name": "Liquor Liability",
        "iso_code": "58161",
        "description": "Claims arising from sale or service of alcoholic beverages.",
        "is_required_by_default": True,
        "default_per_occurrence_limit": Decimal("1000000"),
        "default_aggregate_limit": Decimal("2000000"),
        "default_deductible": Decimal("2500"),
    },
    {
        "id": "assault_battery",
        "name": "Assault & Battery",
        "iso_code": "58162",
        "description": "Coverage (or sublimit) for intentional acts — often excluded from GL by default.",
        "is_required_by_default": False,
        "default_per_occurrence_limit": Decimal("250000"),
        "default_aggregate_limit": Decimal("500000"),
        "default_deductible": Decimal("5000"),
    },
    {
        "id": "property",
        "name": "Commercial Property",
        "iso_code": None,
        "description": "Building, fixtures, equipment. Per-occurrence limit is replacement value.",
        "is_required_by_default": False,
        "default_per_occurrence_limit": Decimal("500000"),
        "default_aggregate_limit": None,
        "default_deductible": Decimal("5000"),
    },
    {
        "id": "wc",
        "name": "Workers Compensation",
        "iso_code": None,
        "description": "Statutory in NY. Covers employee injury / illness claims.",
        "is_required_by_default": True,
        "default_per_occurrence_limit": Decimal("1000000"),    # employer's liability piece
        "default_aggregate_limit": Decimal("1000000"),
        "default_deductible": Decimal("0"),                     # WC typically zero ded
    },
    {
        "id": "epli",
        "name": "Employment Practices Liability",
        "iso_code": None,
        "description": "Harassment, discrimination, wrongful termination claims by employees.",
        "is_required_by_default": False,
        "default_per_occurrence_limit": Decimal("1000000"),
        "default_aggregate_limit": Decimal("1000000"),
        "default_deductible": Decimal("10000"),
    },
    {
        "id": "cyber",
        "name": "Cyber Liability",
        "iso_code": None,
        "description": "POS data breach, customer-info exposure, ransomware.",
        "is_required_by_default": False,
        "default_per_occurrence_limit": Decimal("1000000"),
        "default_aggregate_limit": Decimal("1000000"),
        "default_deductible": Decimal("10000"),
    },
    {
        "id": "umbrella",
        "name": "Commercial Umbrella",
        "iso_code": None,
        "description": "Excess limits over GL / Liquor / Auto. Typical $5M xs $1M primary.",
        "is_required_by_default": False,
        "default_per_occurrence_limit": Decimal("5000000"),
        "default_aggregate_limit": Decimal("5000000"),
        "default_deductible": Decimal("0"),
    },
]


# ─── Carriers ────────────────────────────────────────────────────────────
# id is a kebab-case short form. market_type is the regulatory status —
# admitted carriers are state-licensed and follow filed rates; e&s
# (Excess & Surplus / non-admitted) write risks the admitted market won't
# touch but cost more and aren't covered by state guaranty funds.

CARRIERS: list[dict] = [
    {
        "id": "markel-specialty",
        "name": "Markel Specialty",
        "market_type": "admitted",
        "naic_code": "38970",
        "am_best_rating": "A",
        "appetite": {
            "venue_types": ["dive_bar", "rooftop_bar", "music_venue", "music venue and bar"],
            "max_capacity": 2000,
            "coverage_lines": ["gl", "liquor", "epli", "property"],
        },
        "contact_email": "submissions@markel.example",
        "submission_portal_url": "https://example-markel.com/submit",
    },
    {
        "id": "brit-syndicate",
        "name": "Brit Syndicate 2987 (Lloyd's)",
        "market_type": "e&s",
        "naic_code": None,
        "am_best_rating": "A",
        "appetite": {
            "venue_types": ["club", "nightclub and performance space", "latin_club", "outdoor music venue"],
            "max_capacity": 5000,
            "coverage_lines": ["gl", "liquor", "assault_battery", "umbrella"],
        },
        "contact_email": "newbusiness@brit.example",
        "submission_portal_url": None,
    },
    {
        "id": "atrium-syndicate",
        "name": "Atrium Syndicate 609 (Lloyd's)",
        "market_type": "e&s",
        "naic_code": None,
        "am_best_rating": "A",
        "appetite": {
            "venue_types": ["club", "music_venue", "nightclub and performance space"],
            "max_capacity": 3500,
            "coverage_lines": ["gl", "liquor", "assault_battery"],
        },
        "contact_email": "uw@atrium.example",
        "submission_portal_url": None,
    },
    {
        "id": "burns-wilcox",
        "name": "Burns & Wilcox (wholesaler)",
        "market_type": "e&s",
        "naic_code": None,
        "am_best_rating": "A-",
        "appetite": {
            "venue_types": [
                "dive_bar", "rooftop_bar", "music_venue", "music venue and bar",
                "outdoor music venue", "nightclub and performance space",
                "outdoor bar and music venue", "diy music venue and bar",
                "latin_club", "club",
            ],
            "max_capacity": 10000,
            "coverage_lines": ["gl", "liquor", "assault_battery", "property", "umbrella"],
        },
        "contact_email": "brokerage@burnswilcox.example",
        "submission_portal_url": "https://example-burnswilcox.com/quote",
    },
    {
        "id": "rt-specialty",
        "name": "RT Specialty (wholesaler)",
        "market_type": "e&s",
        "naic_code": None,
        "am_best_rating": "A-",
        "appetite": {
            "venue_types": ["music_venue", "music venue and bar", "rooftop_bar", "diy music venue and bar"],
            "max_capacity": 2500,
            "coverage_lines": ["gl", "liquor", "epli", "cyber"],
        },
        "contact_email": "submissions@rtspecialty.example",
        "submission_portal_url": None,
    },
    {
        "id": "nautilus",
        "name": "Nautilus Insurance",
        "market_type": "admitted",
        "naic_code": "17370",
        "am_best_rating": "A+",
        "appetite": {
            "venue_types": [
                "dive_bar", "rooftop_bar", "music_venue", "music venue and bar",
                "club", "nightclub and performance space",
            ],
            "max_capacity": 1500,
            "coverage_lines": ["property"],
        },
        "contact_email": "submissions@nautilus.example",
        "submission_portal_url": None,
    },
]


# ─── Loader ──────────────────────────────────────────────────────────────

def seed_broker_platform_data(session: Session) -> tuple[int, int]:
    """Insert any missing CoverageLine and Carrier rows. Idempotent — safe
    on every app bootstrap and in tests. Returns (new_lines, new_carriers).

    Order matters: Carrier doesn't FK to CoverageLine, but appetite values
    reference CoverageLine.id strings — seeding coverage lines first means
    a downstream `appetite_check(carrier, lines)` validation has the
    referenced rows to look up."""
    new_lines = _upsert_coverage_lines(session, COVERAGE_LINES)
    new_carriers = _upsert_carriers(session, CARRIERS)
    session.flush()
    return (new_lines, new_carriers)


def _upsert_coverage_lines(session: Session, lines: Sequence[dict]) -> int:
    count = 0
    for row in lines:
        if session.get(CoverageLine, row["id"]):
            continue
        session.add(CoverageLine(**row))
        count += 1
    return count


def _upsert_carriers(session: Session, carriers: Sequence[dict]) -> int:
    count = 0
    for row in carriers:
        if session.get(Carrier, row["id"]):
            continue
        session.add(Carrier(**row))
        count += 1
    return count
