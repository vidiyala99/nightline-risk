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

from fastapi import APIRouter, Depends, File, Header, UploadFile
from sqlmodel import Session, select

from app.auth import require_broker, require_venue_access
from app.database import get_session
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
    item = _find_compliance_item(venue_id, venue, item_id, session=session)
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
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Persist the uploaded file and link it to (venue_id, item_id).

    HTTP concerns live here (auth, reading the UploadFile, the 413 size-cap);
    the file-persist + citation-link + signal-resolve core is shared with the
    copilot ``resolve_compliance`` act-tool via
    ``app.services.compliance_upload.upload_compliance_evidence_sync``.
    """
    # Operator-write gate: only the owning operator + brokers/admins.
    require_venue_access(venue_id, authorization, session)
    from app.main import COMPLIANCE_EVIDENCE_MAX_BYTES
    from app.services.compliance_upload import upload_compliance_evidence_sync

    contents = await file.read()
    if len(contents) > COMPLIANCE_EVIDENCE_MAX_BYTES:
        limit_mb = COMPLIANCE_EVIDENCE_MAX_BYTES // (1024 * 1024)
        raise error_response(
            "compliance_evidence_too_large",
            f"File too large. Maximum size for compliance evidence is {limit_mb}MB.",
            status_code=413,
            details={"limit_mb": limit_mb, "received_bytes": len(contents)},
        )

    return upload_compliance_evidence_sync(
        session,
        venue_id,
        item_id,
        contents,
        file.filename,
        file.content_type,
        uploaded_by=uploaded_by,
    )


@router.patch("/venues/{venue_id}/compliance/{item_id}/resolve")
def resolve_compliance_item_as_broker(
    venue_id: str,
    item_id: str,
    body: dict | None = None,
    session: Session = Depends(get_session),
    user: dict = Depends(require_broker),
) -> dict:
    """Broker/admin waiver: close out a compliance item without operator
    evidence. Records an audit event so the waiver is traceable. Operator
    resolution stays upload-driven (see upload route above)."""
    from app.main import _resolve_venue
    from app.models import ComplianceSignal
    from app.services.compliance_signals import transition_compliance_signal

    _resolve_venue(venue_id, session)
    row = session.get(ComplianceSignal, item_id)
    if row is None or row.venue_id != venue_id:
        raise error_response(
            "compliance_item_not_found",
            f"Compliance item {item_id!r} not found for venue {venue_id!r}.",
            status_code=404,
        )
    # Idempotent: waiving an already-resolved item is a no-op, not a 500.
    # 'resolved' is the desired end-state, so a repeat click just succeeds.
    if row.status != "resolved":
        transition_compliance_signal(
            session, row, to="resolved", actor_id=user["sub"],
            metadata={"reason": (body or {}).get("reason")},
        )
        session.commit()
    return {"status": "resolved", "item_id": item_id}


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
