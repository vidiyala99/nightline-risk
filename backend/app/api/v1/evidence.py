"""Phase B — evidence upload + analysis read routes.

URLs preserved:
  POST /api/incidents/{incident_id}/evidence
  GET  /api/incidents/{incident_id}/evidence
  GET  /api/incidents/{incident_id}/evidence-analysis
  GET  /api/evidence/{evidence_id}/file

`_process_evidence_sync` (the background vision-analysis trigger) and
`EVIDENCE_DIR` stay in main.py and are lazy-imported here; both
collapse into a services/evidence.py module after Phase B completes.
"""
from __future__ import annotations

import hashlib
import re

from fastapi import APIRouter, BackgroundTasks, Depends, File, Header, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlmodel import Session, select

from app.auth import require_venue_access
from app.database import get_session
from app.models import EvidenceAnalysis, EvidenceFile, IncidentRecord
from app.schemas.errors import error_response
from app.storage import get_storage

router = APIRouter()


MAX_IMAGE_SIZE = 20 * 1024 * 1024   # 20MB
MAX_VIDEO_SIZE = 200 * 1024 * 1024  # 200MB

# CRLF / NUL / other control chars — a filename carrying these injects into the
# `Content-Disposition` header on serve.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _sanitize_filename(raw: str | None) -> str:
    """Reduce a client-supplied filename to a safe basename.

    Defends two sinks with one rule: the storage key (path traversal — a
    `../`-bearing name escaping the evidence root; the `evidence_id` prefix only
    neutralizes the *first* segment) and the `Content-Disposition` header on
    serve (CRLF / quote injection). Strips directory components (both `/` and
    `\\`, so it holds regardless of server OS), control chars, and quotes;
    drops leading dots/space so bare `..` can't survive; falls back to "upload".
    """
    if not raw:
        return "upload"
    basename = raw.replace("\\", "/").split("/")[-1]
    cleaned = _CONTROL_CHARS.sub("", basename).replace('"', "")
    cleaned = cleaned.lstrip(". ").strip()
    return cleaned or "upload"


@router.post("/incidents/{incident_id}/evidence", status_code=201)
async def upload_evidence(
    incident_id: str,
    file: UploadFile = File(...),
    uploaded_by: str = "operator",
    captured_at: str | None = None,   # client-supplied capture time; falls back to upload time
    authorization: str = Header(None),
    background_tasks: BackgroundTasks = None,
    session: Session = Depends(get_session),
) -> dict:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise error_response(
            "incident_not_found",
            f"Incident {incident_id!r} not found",
            status_code=404,
        )
    # Operator-write gate: resolve the venue from the incident, then require
    # access. Entity-404 precedes auth (matches GET /incidents/{id}).
    require_venue_access(record.venue_id, authorization, session)

    if record.status == "closed_archived":
        raise error_response(
            "incident_archived",
            "This incident is archived; evidence can no longer be added.",
            status_code=409,
        )

    from uuid import uuid4
    from app.main import _process_evidence_sync

    evidence_id = f"ev-{uuid4().hex[:12]}"
    # Sanitize BEFORE building the storage key — the raw client filename can carry
    # `../` (path traversal) or CRLF/quotes (Content-Disposition injection on serve).
    safe_filename = _sanitize_filename(file.filename)
    safe_name = f"{evidence_id}_{safe_filename}"

    contents = await file.read()
    max_size = MAX_VIDEO_SIZE if (file.content_type or "").startswith("video/") else MAX_IMAGE_SIZE
    if len(contents) > max_size:
        limit_mb = max_size // (1024 * 1024)
        raise error_response(
            "evidence_too_large",
            f"File too large. Maximum size for this file type is {limit_mb}MB. "
            "For larger videos, use the S3 upload path.",
            status_code=413,
            details={"limit_mb": limit_mb, "received_bytes": len(contents)},
        )
    file_ref = get_storage().save(safe_name, contents)
    content_hash = hashlib.sha256(contents).hexdigest()

    evidence = EvidenceFile(
        id=evidence_id,
        incident_id=incident_id,
        filename=safe_filename,
        content_type=file.content_type or "application/octet-stream",
        file_path=file_ref,
        file_size=len(contents),
        uploaded_by=uploaded_by,
        content_hash=content_hash,
        captured_at=captured_at,
    )
    # Fall back to upload time when the client doesn't supply a capture time.
    if not evidence.captured_at:
        evidence.captured_at = evidence.uploaded_at.isoformat()
    session.add(evidence)
    session.commit()

    # Trigger async vision analysis for image/video uploads.
    if background_tasks and file.content_type and (
        file.content_type.startswith("image/") or file.content_type.startswith("video/")
    ):
        background_tasks.add_task(_process_evidence_sync, evidence_id)

    return {
        "id": evidence_id,
        "filename": evidence.filename,
        "content_type": evidence.content_type,
        "file_size": evidence.file_size,
        "uploaded_at": evidence.uploaded_at.isoformat(),
        "content_hash": evidence.content_hash,
        "captured_at": evidence.captured_at,
    }


@router.get("/incidents/{incident_id}/evidence")
def list_evidence(
    incident_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    incident = session.get(IncidentRecord, incident_id)
    if incident is None:
        raise error_response(
            "incident_not_found",
            f"Incident {incident_id!r} not found",
            status_code=404,
        )
    require_venue_access(incident.venue_id, authorization, session)
    files = session.exec(
        select(EvidenceFile)
        .where(EvidenceFile.incident_id == incident_id)
        .order_by(EvidenceFile.uploaded_at)
    ).all()
    return [
        {
            "id": f.id,
            "filename": f.filename,
            "content_type": f.content_type,
            "file_size": f.file_size,
            "uploaded_by": f.uploaded_by,
            "uploaded_at": f.uploaded_at.isoformat(),
        }
        for f in files
    ]


@router.get("/incidents/{incident_id}/evidence-analysis")
def get_evidence_analysis(
    incident_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Aggregated vision analysis status for all evidence on an incident."""
    incident = session.get(IncidentRecord, incident_id)
    if incident is None:
        raise error_response(
            "incident_not_found",
            f"Incident {incident_id!r} not found",
            status_code=404,
        )
    require_venue_access(incident.venue_id, authorization, session)
    analyses = session.exec(
        select(EvidenceAnalysis).where(EvidenceAnalysis.incident_id == incident_id)
    ).all()
    all_files = session.exec(
        select(EvidenceFile).where(EvidenceFile.incident_id == incident_id)
    ).all()
    processable = [f for f in all_files if f.content_type.startswith(("image/", "video/"))]
    complete = [a for a in analyses if a.status == "complete"]
    return {
        "total_files": len(processable),
        "processed": len(complete),
        "status": (
            "complete" if len(complete) >= len(processable) > 0
            else "processing" if processable
            else "no_media"
        ),
        "analyses": [
            {
                "evidence_id": a.evidence_id,
                "analysis_type": a.analysis_type,
                "corroboration": a.corroboration,
                "confidence_delta": a.confidence_delta,
                "raw_description": a.raw_description,
                "findings": a.findings,
                "analyzed_at": a.analyzed_at.isoformat() if a.analyzed_at else None,
            }
            for a in complete
        ],
    }


@router.get("/evidence/{evidence_id}/file")
def serve_evidence(
    evidence_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    ev = session.get(EvidenceFile, evidence_id)
    if ev is None:
        raise error_response(
            "evidence_not_found",
            f"Evidence {evidence_id!r} not found",
            status_code=404,
        )
    # Gate the raw bytes on the owning incident's venue — these are injury
    # photos / police reports, the most sensitive surface in the system.
    incident = session.get(IncidentRecord, ev.incident_id)
    if incident is None:
        raise error_response(
            "incident_not_found",
            f"Incident {ev.incident_id!r} not found",
            status_code=404,
        )
    require_venue_access(incident.venue_id, authorization, session)
    storage = get_storage()
    if not storage.exists(ev.file_path):
        raise error_response(
            "evidence_file_missing",
            "Evidence row exists but the file is not in storage.",
            status_code=404,
        )
    # Local backend → FileResponse (efficient); remote backend (local_path None)
    # → stream the bytes through read().
    # Defense-in-depth: sanitize again at serve so a row written before the
    # upload-time fix (or by another path) can't inject into the header.
    download_name = _sanitize_filename(ev.filename)
    local = storage.local_path(ev.file_path)
    if local is not None:
        return FileResponse(str(local), media_type=ev.content_type, filename=download_name)
    return StreamingResponse(
        iter([storage.read(ev.file_path)]),
        media_type=ev.content_type,
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@router.delete("/evidence/{evidence_id}")
def delete_evidence(
    evidence_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Remove an attachment. Deletion is allowed (operators upload wrong/dupe
    files) but is anti-spoliation-safe: an immutable `evidence.deleted` audit
    event records what was removed and by whom *before* the row/bytes go. The
    dependent vision analyses cascade; storage cleanup is best-effort."""
    from app.packet_core import _add_audit_event

    ev = session.get(EvidenceFile, evidence_id)
    if ev is None:
        raise error_response(
            "evidence_not_found",
            f"Evidence {evidence_id!r} not found",
            status_code=404,
        )
    incident = session.get(IncidentRecord, ev.incident_id)
    if incident is None:
        raise error_response(
            "incident_not_found",
            f"Incident {ev.incident_id!r} not found",
            status_code=404,
        )
    user = require_venue_access(incident.venue_id, authorization, session)
    if incident.status == "closed_archived":
        raise error_response(
            "incident_archived",
            "This incident is archived; evidence can no longer be modified.",
            status_code=409,
        )

    # Record what's being removed BEFORE deleting — the bytes go, the proof stays.
    _add_audit_event(
        session=session,
        actor_id=user.get("sub") or "operator",
        actor_type=user.get("role") or "operator",
        entity_type="evidence",
        entity_id=evidence_id,
        event_type="evidence.deleted",
        event_metadata={
            "incident_id": ev.incident_id,
            "filename": ev.filename,
            "content_hash": ev.content_hash,
            "file_size": ev.file_size,
        },
    )
    # Cascade dependent vision analyses (FK → evidencefile.id).
    for analysis in session.exec(
        select(EvidenceAnalysis).where(EvidenceAnalysis.evidence_id == evidence_id)
    ).all():
        session.delete(analysis)
    # Best-effort storage cleanup — a missing blob must not block the delete.
    try:
        get_storage().delete(ev.file_path)
    except Exception:
        pass
    session.delete(ev)
    session.commit()
    return {"deleted": evidence_id}
