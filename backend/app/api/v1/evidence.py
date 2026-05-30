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
    from uuid import uuid4
    from app.main import _process_evidence_sync
    from app.storage import get_storage

    evidence_id = f"ev-{uuid4().hex[:12]}"
    safe_name = f"{evidence_id}_{file.filename}"

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
        filename=file.filename or "upload",
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
    local = storage.local_path(ev.file_path)
    if local is not None:
        return FileResponse(str(local), media_type=ev.content_type, filename=ev.filename)
    return StreamingResponse(
        iter([storage.read(ev.file_path)]),
        media_type=ev.content_type,
        headers={"Content-Disposition": f'attachment; filename="{ev.filename}"'},
    )
