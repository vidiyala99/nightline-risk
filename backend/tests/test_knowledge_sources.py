from sqlmodel import Session, SQLModel, create_engine

from app.knowledge_sources import (
    INGESTED_ORIGIN,
    load_ingested_policy_sources,
    load_knowledge_sources_for_venue,
)
from app.models import SourceRecord
from app.rag import SemanticKnowledgeBase
from app.seed_data import KNOWLEDGE_SOURCES


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed_ingested(session: Session, *, venue_id: str, source_id: str, text: str) -> None:
    session.add(SourceRecord(
        id=source_id,
        venue_id=venue_id,
        source_type="policy",
        origin_system=INGESTED_ORIGIN,
        external_ref="uploaded_policy.md",
        excerpt=text,
        content_hash="hash-" + source_id,
    ))
    session.commit()


def test_load_ingested_returns_venue_and_wildcard_only_not_other_venues():
    with make_session() as session:
        _seed_ingested(session, venue_id="elsewhere-brooklyn", source_id="ingested-eb-1", text="EB-specific policy.")
        _seed_ingested(session, venue_id="*", source_id="ingested-shared-1", text="Shared policy applies to all venues.")
        _seed_ingested(session, venue_id="other-venue", source_id="ingested-other-1", text="Other venue policy.")

        rows = load_ingested_policy_sources(session, "elsewhere-brooklyn")
        ids = {r["source_id"] for r in rows}
        assert ids == {"ingested-eb-1", "ingested-shared-1"}


def test_load_ingested_excludes_non_ingestion_origin_sources():
    """SourceRecords without origin_system=policy_ingestion (e.g. those created
    by create_packet_snapshot when persisting citations) must not pollute the
    knowledge base — otherwise the retriever would loop on its own citations."""
    with make_session() as session:
        session.add(SourceRecord(
            id="cited-by-packet",
            venue_id="elsewhere-brooklyn",
            source_type="policy",
            origin_system=None,
            excerpt="Citation source carved out during packet generation.",
        ))
        session.commit()

        assert load_ingested_policy_sources(session, "elsewhere-brooklyn") == []


def test_merged_loader_includes_seed_plus_ingested_and_feeds_retriever():
    with make_session() as session:
        _seed_ingested(
            session,
            venue_id="elsewhere-brooklyn",
            source_id="ingested-eb-flammable",
            text="Pyrotechnic displays and open flames are excluded from coverage at this venue.",
        )

        merged = load_knowledge_sources_for_venue(session, "elsewhere-brooklyn")
        seed_ids = {s["source_id"] for s in KNOWLEDGE_SOURCES}
        merged_ids = {s["source_id"] for s in merged}
        assert seed_ids.issubset(merged_ids)
        assert "ingested-eb-flammable" in merged_ids

        # Retriever should rank the ingested chunk first for a matching query
        kb = SemanticKnowledgeBase(merged, [])
        results = kb.retrieve("elsewhere-brooklyn", "pyrotechnic open flame coverage", limit=3)
        top_ids = [c.source_id for c in results]
        assert "ingested-eb-flammable" in top_ids
