"""Merge the seed knowledge corpus with venue-uploaded policy chunks.

The retriever expects a flat list of {source_id, venue_id, source_type, text} dicts.
Seed sources live in seed_data.KNOWLEDGE_SOURCES; user-uploaded policy chunks live
in the SourceRecord table tagged origin_system="policy_ingestion".
"""

from sqlmodel import Session, select

from app.models import SourceRecord
from app.seed_data import KNOWLEDGE_SOURCES

INGESTED_ORIGIN = "policy_ingestion"


def load_ingested_policy_sources(session: Session, venue_id: str) -> list[dict]:
    rows = session.exec(
        select(SourceRecord).where(
            SourceRecord.origin_system == INGESTED_ORIGIN,
            (SourceRecord.venue_id == venue_id) | (SourceRecord.venue_id == "*"),
        )
    ).all()
    return [
        {
            "source_id": r.id,
            "venue_id": r.venue_id,
            "source_type": r.source_type,
            "text": r.excerpt,
        }
        for r in rows
    ]


def load_knowledge_sources_for_venue(session: Session, venue_id: str) -> list[dict]:
    return [*KNOWLEDGE_SOURCES, *load_ingested_policy_sources(session, venue_id)]
