"""The deterministic exposure→exclusion brain (pure, no I/O).

Two jobs, both keyword-deterministic so a broker can see exactly *why* a clause
was flagged (no LLM, no TF-IDF index — respecting the findings framework's
"trustworthy, explainable" contract):

  1. `rank_exposures` — from a venue's incidents, which loss categories does it
     actually face, ranked by frequency? (assault & battery dominates nightlife.)
  2. `clause_matches_category` — does a given policy *exclusion* clause bite on
     a category? (an "assault & battery is excluded" clause vs. an A&B-heavy venue
     is the canonical nightlife E&O gap.)

Categories are anchored on the canonical coverage-line / subjectivity vocabulary
already in the codebase (`app/underwriting/recommender.py`, `seed_carriers.py`).
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class ExposureCategory:
    key: str
    label: str
    # Tokens that, found in an incident's category/summary, mean the venue is
    # exposed to this loss type.
    incident_signals: tuple[str, ...]
    # Tokens that, found in a policy *exclusion* clause, mean that exclusion
    # removes coverage for this exposure.
    exclusion_keywords: tuple[str, ...]


# Focused on the exclusions that actually bite a nightlife book. Extensible —
# add a category here and both the finding and its eval pick it up.
EXPOSURE_CATEGORIES: tuple[ExposureCategory, ...] = (
    ExposureCategory(
        key="assault_battery",
        label="Assault & battery",
        incident_signals=(
            "assault", "battery", "altercation", "fight", "brawl", "violence",
            "violent", "punch", "attack", "beaten",
        ),
        exclusion_keywords=(
            "assault", "battery", "altercation", "physical altercation", "violent",
        ),
    ),
    ExposureCategory(
        key="liquor",
        label="Liquor liability",
        incident_signals=(
            "liquor", "alcohol", "intoxicat", "over-service", "over service",
            "overserved", "over-served", "dram", "drunk", "serving",
        ),
        exclusion_keywords=(
            "liquor", "alcohol", "intoxication", "dram shop", "host liquor",
            "furnishing of alcohol",
        ),
    ),
    ExposureCategory(
        key="firearms",
        label="Firearms / weapons",
        incident_signals=(
            "firearm", "gun", "weapon", "shooting", "shot", "discharge",
        ),
        exclusion_keywords=(
            "firearm", "weapon", "discharge of any firearm", "gun",
        ),
    ),
)

_BY_KEY = {cat.key: cat for cat in EXPOSURE_CATEGORIES}


def category_label(key: str) -> str:
    cat = _BY_KEY.get(key)
    return cat.label if cat else ""


def signals_for_incident(incident_category: str | None, summary: str) -> set[str]:
    """Which exposure categories a single incident signals. Matches the
    structured `incident_category` and the free-text summary together, so a
    classified incident and a legacy summary-only one both resolve."""
    haystack = f"{incident_category or ''} {summary or ''}".lower()
    return {
        cat.key
        for cat in EXPOSURE_CATEGORIES
        if any(sig in haystack for sig in cat.incident_signals)
    }


def rank_exposures(
    incidents: Iterable[tuple[str | None, str]],
) -> list[tuple[str, int]]:
    """(incident_category, summary) pairs → [(category_key, count), ...] sorted
    by count desc then key, dropping categories with no signal. The #1 entry is
    the venue's dominant loss exposure — the one an exclusion most hurts."""
    counts: Counter[str] = Counter()
    for category, summary in incidents:
        for key in signals_for_incident(category, summary):
            counts[key] += 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def clause_matches_category(clause_text: str, category_key: str) -> bool:
    """True when an exclusion clause's text removes coverage for this category."""
    cat = _BY_KEY.get(category_key)
    if cat is None:
        return False
    haystack = (clause_text or "").lower()
    return any(kw in haystack for kw in cat.exclusion_keywords)
