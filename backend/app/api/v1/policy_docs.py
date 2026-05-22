"""Phase B — policy document ingestion + venue source-record listing.

URLs preserved:
  POST /api/venues/{venue_id}/policy-docs
  GET  /api/venues/{venue_id}/sources

The PolicyDocument id is a SHA-256 of (venue_id, source_file, text), so
re-uploading identical content returns the existing doc_id and zero
newly-inserted chunks (idempotent at both the doc and chunk level).
"""
from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.auth import require_broker
from app.database import get_session
from app.knowledge_sources import INGESTED_ORIGIN
from app.models import PolicyDocument, SourceRecord
from app.policy_document import build_policy_tree
from app.schemas.errors import error_response

router = APIRouter()


@router.post("/venues/{venue_id}/policy-docs", status_code=201)
def ingest_policy_doc(
    venue_id: str,
    payload: dict,
    session: Session = Depends(get_session),
    _: None = Depends(require_broker),
) -> dict:
    """Ingest a markdown policy document for this venue."""
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)

    text = (payload.get("text") or "").strip()
    if not text:
        raise error_response(
            "policy_text_required",
            "`text` (markdown body) is required",
            status_code=400,
        )
    source_file = payload.get("source_file", "uploaded_policy.md")

    tree_json, leaves = build_policy_tree(text=text, source_file=source_file)
    if not leaves:
        raise error_response(
            "policy_no_chunks",
            "No chunks extracted. Policy must use '## Section' / '### Clause' headings.",
            status_code=400,
        )

    doc_hash_input = f"{venue_id}|{source_file}|{text}".encode("utf-8")
    doc_id = f"policy-{hashlib.sha256(doc_hash_input).hexdigest()[:16]}"

    existing_doc = session.get(PolicyDocument, doc_id)
    if existing_doc is None:
        session.add(PolicyDocument(
            id=doc_id,
            venue_id=venue_id,
            source_file=source_file,
            content_type="text/markdown",
            page_count=len(leaves),
            tree_json=tree_json,
            status="ready",
        ))

    inserted_ids: list[str] = []
    for chunk in leaves:
        content = chunk["content"]
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        source_id = f"ingested-{content_hash[:16]}"
        if session.get(SourceRecord, source_id):
            continue
        meta = dict(chunk.get("metadata", {}))
        meta["doc_id"] = doc_id
        source_type = "policy_exclusion" if meta.get("is_exclusion") else "policy"
        session.add(SourceRecord(
            id=source_id,
            venue_id=venue_id,
            source_type=source_type,
            origin_system=INGESTED_ORIGIN,
            external_ref=source_file,
            excerpt=content[:2000],
            content_hash=content_hash,
            source_metadata=meta,
        ))
        inserted_ids.append(source_id)

    session.commit()
    return {
        "venue_id": venue_id,
        "doc_id": doc_id,
        "chunks_extracted": len(leaves),
        "chunks_inserted": len(inserted_ids),
        "source_ids": inserted_ids,
    }


@router.get("/venues/{venue_id}/sources")
def list_venue_sources(
    venue_id: str,
    session: Session = Depends(get_session),
) -> list[dict]:
    """Source registry — all evidence sources for a venue."""
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)

    sources = session.exec(
        select(SourceRecord)
        .where(SourceRecord.venue_id == venue_id)
        .order_by(SourceRecord.created_at.desc())
    ).all()
    return [
        {
            "id": s.id,
            "source_type": s.source_type,
            "excerpt": s.excerpt,
            "incident_id": s.incident_id,
            "content_hash": s.content_hash,
            "created_at": s.created_at.isoformat(),
        }
        for s in sources
    ]
