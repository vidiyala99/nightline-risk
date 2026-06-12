"""Merge the seed knowledge corpus with venue-uploaded policy chunks.

The retriever expects a flat list of {source_id, venue_id, source_type, text} dicts.
Seed sources live in seed_data.KNOWLEDGE_SOURCES; user-uploaded policy chunks live
in the SourceRecord table tagged origin_system="policy_ingestion".
"""

import json

from sqlmodel import Session, select

from app.models import SourceRecord
from app.seed_data import KNOWLEDGE_SOURCES

INGESTED_ORIGIN = "policy_ingestion"


def _as_meta(value) -> dict:
    """Coerce a Column(JSON) dict value to a real dict. On Postgres/Neon a JSON
    column can read back as a JSON *string* (it round-trips as a dict on SQLite);
    un-coerced .get() then raises only on prod. Mirrors `_as_list` for JSON list
    columns (see app/defense_package.py)."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def load_ingested_policy_sources(session: Session, venue_id: str) -> list[dict]:
    rows = session.exec(
        select(SourceRecord).where(
            SourceRecord.origin_system == INGESTED_ORIGIN,
            (SourceRecord.venue_id == venue_id) | (SourceRecord.venue_id == "*"),
        )
    ).all()
    result = []
    for r in rows:
        meta = _as_meta(r.source_metadata)
        result.append({
            "source_id": r.id,
            "venue_id": r.venue_id,
            "source_type": r.source_type,
            "text": r.excerpt,
            # PageIndex-derived locators flow through to Citation so the FE can
            # render "Policy §4.2(b) · p.14". Missing keys default to None at
            # the Citation layer — seed knowledge sources stay unaffected.
            "doc_id": meta.get("doc_id"),
            "node_id": meta.get("node_id"),
            "page_start": meta.get("page_start"),
            "page_end": meta.get("page_end"),
            "path": meta.get("path"),
            "clause_id": meta.get("clause_id"),
        })
    return result


def load_knowledge_sources_for_venue(session: Session, venue_id: str) -> list[dict]:
    return [*KNOWLEDGE_SOURCES, *load_ingested_policy_sources(session, venue_id)]
