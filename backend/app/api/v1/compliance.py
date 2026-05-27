"""Phase B — compliance citation prediction + evidence upload + listing.

URLs preserved:
  GET  /api/venues/{venue_id}/compliance/{item_id}/citation
  POST /api/venues/{venue_id}/compliance/{item_id}/upload
  GET  /api/venues/{venue_id}/compliance/{item_id}/evidence

`_predict_evidence_citation` + `_find_compliance_item` helpers and the
`COMPLIANCE_EVIDENCE_MAX_BYTES` constant + `EVIDENCE_DIR` are lazy-
imported from main.py to avoid the circular at module load.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile
from sqlmodel import Session, select

from app.database import get_session
from app.live_state import live_state_manager
from app.models import ComplianceEvidence
from app.schemas.errors import error_response

router = APIRouter()


@router.get("/venues/{venue_id}/compliance/{item_id}/citation")
def predict_compliance_citation(
    venue_id: str,
    item_id: str,
    session: Session = Depends(get_session),
) -> dict:
    """Predict the policy clause this compliance item maps to. Returns
    `{citation: null}` when no policy doc is ingested yet or the item
    is unknown — the FE chip stays hidden in that case."""
    from app.main import _resolve_venue, _find_compliance_item, _predict_evidence_citation
    venue = _resolve_venue(venue_id, session)
    item = _find_compliance_item(venue_id, venue, item_id)
    if item is None:
        return {"citation": None}
    hit = _predict_evidence_citation(venue_id, item.description, session)
    return {"citation": hit.model_dump() if hit else None}


@router.post("/venues/{venue_id}/compliance/{item_id}/upload")
async def upload_compliance_evidence(
    venue_id: str,
    item_id: str,
    file: UploadFile = File(...),
    uploaded_by: str = "operator",
    session: Session = Depends(get_session),
) -> dict:
    """Persist the uploaded file and link it to (venue_id, item_id)."""
    from uuid import uuid4
    from app.main import (
        COMPLIANCE_EVIDENCE_MAX_BYTES,
        _find_compliance_item,
        _predict_evidence_citation,
        _resolve_venue,
    )
    from app.storage import get_storage
    venue = _resolve_venue(venue_id, session)

    contents = await file.read()
    if len(contents) > COMPLIANCE_EVIDENCE_MAX_BYTES:
        limit_mb = COMPLIANCE_EVIDENCE_MAX_BYTES // (1024 * 1024)
        raise error_response(
            "compliance_evidence_too_large",
            f"File too large. Maximum size for compliance evidence is {limit_mb}MB.",
            status_code=413,
            details={"limit_mb": limit_mb, "received_bytes": len(contents)},
        )

    # Snapshot the citation BEFORE resolve_compliance_item runs (which
    # removes the item from the live queue). Best-effort: missing item or
    # missing policy docs just leaves the cited_* columns null.
    item = _find_compliance_item(venue_id, venue, item_id)
    citation = _predict_evidence_citation(venue_id, item.description, session) if item else None

    evidence_id = f"ce-{uuid4().hex[:12]}"
    safe_name = f"{evidence_id}_{file.filename or 'upload'}"
    file_ref = get_storage().save(safe_name, contents)

    record = ComplianceEvidence(
        id=evidence_id,
        venue_id=venue_id,
        compliance_item_id=item_id,
        filename=file.filename or "upload",
        content_type=file.content_type or "application/octet-stream",
        file_path=file_ref,
        file_size=len(contents),
        uploaded_by=uploaded_by,
        cited_source_id=citation.source_id if citation else None,
        cited_doc_id=citation.doc_id if citation else None,
        cited_node_id=citation.node_id if citation else None,
        cited_page_start=citation.page_start if citation else None,
        cited_page_end=citation.page_end if citation else None,
    )
    session.add(record)
    session.commit()

    # Preserve existing auto-resolve behavior — broker validation gate is
    # tracked separately in the audit queue.
    live_state_manager.resolve_compliance_item(venue_id, item_id)

    return {
        "status": "accepted",
        "evidence_id": evidence_id,
        "item_id": item_id,
        "filename": record.filename,
        "file_size": record.file_size,
        "uploaded_at": record.uploaded_at.isoformat(),
        "citation": citation.model_dump() if citation else None,
    }


@router.get("/venues/{venue_id}/compliance/{item_id}/evidence")
def list_compliance_evidence(
    venue_id: str,
    item_id: str,
    session: Session = Depends(get_session),
) -> list[dict]:
    """All persisted evidence files for a compliance item (audit-trail read)."""
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    rows = session.exec(
        select(ComplianceEvidence)
        .where(ComplianceEvidence.venue_id == venue_id)
        .where(ComplianceEvidence.compliance_item_id == item_id)
        .order_by(ComplianceEvidence.uploaded_at)
    ).all()
    return [
        {
            "id": r.id,
            "filename": r.filename,
            "content_type": r.content_type,
            "file_size": r.file_size,
            "uploaded_by": r.uploaded_by,
            "uploaded_at": r.uploaded_at.isoformat(),
        }
        for r in rows
    ]
