"""Join a venue's real loss exposure to its ingested policy *exclusion* clauses.

This is the consumer that turns the master-policy ingestion engine into the
broker's E&O cover: it fires only when an exclusion the carrier wrote bites on a
loss the venue actually has, and returns the clause as a `Citation` so the broker
sees exactly which contract language is the gap.

Failure-isolated: ANY error → [] (a coverage-review hiccup must never blank the
broker's findings panel — mirrors the engine's per-module isolation).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from app.coverage.exposure_map import (
    category_label,
    clause_matches_category,
    rank_exposures,
)
from app.knowledge_sources import load_ingested_policy_sources
from app.models import IncidentRecord, Policy
from app.schemas.domain import Citation


@dataclass
class ExclusionMatch:
    category_key: str          # e.g. "assault_battery"
    category_label: str        # "Assault & battery"
    exposure_rank: int         # 1 = the venue's dominant loss exposure
    citation: Citation         # the exclusion clause that bites


def review_policy_exclusions(
    session: Session, policy: Policy, *, now: Optional[datetime] = None
) -> list[ExclusionMatch]:
    try:
        venue_id = policy.venue_id

        incidents = session.exec(
            select(IncidentRecord).where(IncidentRecord.venue_id == venue_id)
        ).all()
        ranked = rank_exposures([(i.incident_category, i.summary) for i in incidents])
        if not ranked:
            return []
        rank_by_key = {key: idx + 1 for idx, (key, _count) in enumerate(ranked)}

        sources = load_ingested_policy_sources(session, venue_id)
        exclusions = [s for s in sources if s.get("source_type") == "policy_exclusion"]
        if not exclusions:
            return []

        matches: list[ExclusionMatch] = []
        for src in exclusions:
            text = src.get("text") or ""
            # Attribute the clause to the strongest exposure it bites on — iterate
            # in rank order so the first match is the most consequential.
            for key, _count in ranked:
                if clause_matches_category(text, key):
                    matches.append(ExclusionMatch(
                        category_key=key,
                        category_label=category_label(key),
                        exposure_rank=rank_by_key[key],
                        citation=Citation(
                            source_id=src["source_id"],
                            source_type=src.get("source_type", "policy_exclusion"),
                            excerpt=text[:200],
                            doc_id=src.get("doc_id"),
                            node_id=src.get("node_id"),
                            page_start=src.get("page_start"),
                            page_end=src.get("page_end"),
                            path=src.get("path"),
                            clause_id=src.get("clause_id"),
                        ),
                    ))
                    break

        matches.sort(key=lambda m: (m.exposure_rank, m.citation.source_id))
        return matches
    except Exception:  # noqa: BLE001 — advisory only, never blank the panel
        return []
