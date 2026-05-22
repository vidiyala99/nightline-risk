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

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.database import get_session
from app.models import EvidenceAnalysis, EvidenceFile, IncidentRecord
from app.schemas.errors import error_response

router = APIRouter()


MAX_IMAGE_SIZE = 20 * 1024 * 1024   # 20MB
MAX_VIDEO_SIZE = 200 * 1024 * 1024  # 200MB


@router.post("/incidents/{incident_id}/evidence", status_code=201)
async def upload_evidence(
    incident_id: str,
    file: UploadFile = File(...),
    uploaded_by: str = "operator",
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
    from uuid import uuid4
    from app.main import EVIDENCE_DIR, _process_evidence_sync

    evidence_id = f"ev-{uuid4().hex[:12]}"
    safe_name = f"{evidence_id}_{file.filename}"
    dest = EVIDENCE_DIR / safe_name

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
    dest.write_bytes(contents)

    evidence = EvidenceFile(
        id=evidence_id,
        incident_id=incident_id,
        filename=file.filename or "upload",
        content_type=file.content_type or "application/octet-stream",
        file_path=str(dest),
        file_size=len(contents),
        uploaded_by=uploaded_by,
    )
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
    }


@router.get("/incidents/{incident_id}/evidence")
def list_evidence(
    incident_id: str,
    session: Session = Depends(get_session),
) -> list[dict]:
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
    session: Session = Depends(get_session),
) -> dict:
    """Aggregated vision analysis status for all evidence on an incident."""
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
    session: Session = Depends(get_session),
):
    ev = session.get(EvidenceFile, evidence_id)
    if ev is None:
        raise error_response(
            "evidence_not_found",
            f"Evidence {evidence_id!r} not found",
            status_code=404,
        )
    path = Path(ev.file_path)
    if not path.exists():
        raise error_response(
            "evidence_file_missing",
            "Evidence row exists but the file is not on disk.",
            status_code=404,
        )
    return FileResponse(str(path), media_type=ev.content_type, filename=ev.filename)
