"""Shared sync core for compliance-evidence upload.

Extracted from the async ``POST /api/venues/{venue_id}/compliance/{item_id}/upload``
route so the copilot's ``resolve_compliance`` act-tool and the HTTP route share
ONE persistence path (DRY). The route owns HTTP concerns (auth, reading the
UploadFile, the 413 size-cap); this service owns:

  1. snapshot the predicted citation (before the signal flips to resolved),
  2. persist the file via ``app.storage.get_storage()`` + a ``ComplianceEvidence``
     row,
  3. transition the ComplianceSignal to ``resolved`` if one exists and is open
     (idempotent — re-upload to an already-resolved item is a no-op, the
     evidence row is still persisted).

Returns the same dict the route returns to the client.
"""
from __future__ import annotations

from uuid import uuid4

from sqlmodel import Session

from app.models import ComplianceEvidence, ComplianceSignal


def upload_compliance_evidence_sync(
    session: Session,
    venue_id: str,
    item_id: str,
    file_bytes: bytes,
    filename: str | None,
    content_type: str | None,
    uploaded_by: str = "operator",
) -> dict:
    """Persist `file_bytes` as evidence for (venue_id, item_id), link the
    predicted citation, and resolve the signal. Caller owns the size-cap check
    and commit semantics at the HTTP boundary; this service commits its own
    multi-step mutation so both callers behave identically."""
    from app.main import _find_compliance_item, _predict_evidence_citation, _resolve_venue
    from app.services.compliance_signals import transition_compliance_signal
    from app.storage import get_storage

    venue = _resolve_venue(venue_id, session)

    # Snapshot the citation BEFORE resolving the signal (which changes status).
    # Best-effort: missing item or missing policy docs just leaves cited_* null.
    item = _find_compliance_item(venue_id, venue, item_id, session=session)
    citation = _predict_evidence_citation(venue_id, item.description, session) if item else None

    evidence_id = f"ce-{uuid4().hex[:12]}"
    safe_name = f"{evidence_id}_{filename or 'upload'}"
    file_ref = get_storage().save(safe_name, file_bytes)

    record = ComplianceEvidence(
        id=evidence_id,
        venue_id=venue_id,
        compliance_item_id=item_id,
        filename=filename or "upload",
        content_type=content_type or "application/octet-stream",
        file_path=file_ref,
        file_size=len(file_bytes),
        uploaded_by=uploaded_by,
        cited_source_id=citation.source_id if citation else None,
        cited_doc_id=citation.doc_id if citation else None,
        cited_node_id=citation.node_id if citation else None,
        cited_page_start=citation.page_start if citation else None,
        cited_page_end=citation.page_end if citation else None,
    )
    session.add(record)
    session.commit()

    # Transition the ComplianceSignal to resolved if it exists in the DB.
    # Best-effort: if the row isn't found (e.g. legacy item_id), skip silently.
    # Idempotent: an already-resolved item stays resolved — re-uploading
    # evidence must not 500 on the lifecycle guard (resolved→resolved is not a
    # legal transition). The evidence row above is still persisted either way.
    signal_row = session.get(ComplianceSignal, item_id)
    if (
        signal_row is not None
        and signal_row.venue_id == venue_id
        and signal_row.status != "resolved"
    ):
        transition_compliance_signal(
            session, signal_row, to="resolved",
            actor_id=uploaded_by, evidence_ref=file_ref,
        )
        session.commit()

    return {
        "status": "accepted",
        "evidence_id": evidence_id,
        "item_id": item_id,
        "filename": record.filename,
        "file_size": record.file_size,
        "uploaded_at": record.uploaded_at.isoformat(),
        "citation": citation.model_dump() if citation else None,
    }
