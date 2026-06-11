"""Loss-run import endpoints (broker + carrier). Mounted at /api by main.py.

  POST /api/loss-run-imports                    (multipart upload)
  GET  /api/loss-run-imports                    (list)
  GET  /api/loss-run-imports/{id}               (detail + rows)
  POST /api/loss-run-imports/{id}/link-submission

LossRunImportError -> 400, mirroring the other v1 routers.
"""
from __future__ import annotations

import json
from typing import NoReturn, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth import require_broker_or_carrier
from app.database import get_session
from app.models import LossRunImport, LossRunImportRow
from app.money import usd_to_json
from app.services.loss_run_import import LossRunImportError, create_loss_run_import, link_to_submission

router = APIRouter()


class LinkSubmissionBody(BaseModel):
    submission_id: str = Field(..., min_length=1)


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, LossRunImportError):
        raise HTTPException(status_code=400, detail=str(e))
    raise e


def _as_dict(value) -> dict:
    """Coerce a Column(JSON) read: Postgres returns a string, SQLite a dict."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value or {}


def _import_to_dict(imp: LossRunImport) -> dict:
    return {
        "id": imp.id, "filename": imp.filename, "source_format": imp.source_format,
        "venue_id": imp.venue_id, "submission_id": imp.submission_id,
        "uploaded_by": imp.uploaded_by, "row_count": imp.row_count, "status": imp.status,
        "provenance": _as_dict(imp.provenance), "created_at": imp.created_at.isoformat(),
    }


def _row_to_dict(r: LossRunImportRow) -> dict:
    return {
        "id": r.id, "row_index": r.row_index,
        "date_of_loss": r.date_of_loss.isoformat() if r.date_of_loss else None,
        "coverage_line": r.coverage_line, "claim_status": r.claim_status,
        "claimant": r.claimant, "description": r.description,
        "carrier_claim_number": r.carrier_claim_number,
        "reserve": usd_to_json(r.reserve) if r.reserve is not None else None,
        "paid": usd_to_json(r.paid) if r.paid is not None else None,
        "incurred": usd_to_json(r.incurred) if r.incurred is not None else None,
        "field_confidence": _as_dict(r.field_confidence), "raw_values": _as_dict(r.raw_values),
    }


@router.post("/loss-run-imports", status_code=201)
async def api_create_loss_run_import(
    file: UploadFile = File(...),
    source_format: str = Form(...),
    venue_id: Optional[str] = Form(None),
    submission_id: Optional[str] = Form(None),
    user: dict = Depends(require_broker_or_carrier),
    session: Session = Depends(get_session),
) -> dict:
    data = await file.read()
    try:
        imp = create_loss_run_import(
            session, file_bytes=data, filename=file.filename or "upload",
            source_format=source_format, uploaded_by=user.get("sub", "unknown"),
            venue_id=venue_id, submission_id=submission_id,
        )
        session.commit()
        session.refresh(imp)
        return _import_to_dict(imp)
    except LossRunImportError as e:
        session.rollback()
        _map_service_error(e)


@router.get("/loss-run-imports", dependencies=[Depends(require_broker_or_carrier)])
def api_list_loss_run_imports(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.exec(select(LossRunImport).order_by(LossRunImport.created_at.desc())).all()
    return [_import_to_dict(i) for i in rows]


@router.get("/loss-run-imports/{import_id}", dependencies=[Depends(require_broker_or_carrier)])
def api_get_loss_run_import(import_id: str, session: Session = Depends(get_session)) -> dict:
    imp = session.get(LossRunImport, import_id)
    if imp is None:
        raise HTTPException(status_code=404, detail=f"loss-run import {import_id} not found")
    rows = session.exec(
        select(LossRunImportRow).where(LossRunImportRow.import_id == import_id)
        .order_by(LossRunImportRow.row_index)
    ).all()
    return {**_import_to_dict(imp), "rows": [_row_to_dict(r) for r in rows]}


@router.post("/loss-run-imports/{import_id}/link-submission",
             dependencies=[Depends(require_broker_or_carrier)])
def api_link_submission(
    import_id: str, body: LinkSubmissionBody, session: Session = Depends(get_session),
) -> dict:
    try:
        imp = link_to_submission(session, import_id, body.submission_id)
        session.commit()
        session.refresh(imp)
        return _import_to_dict(imp)
    except LossRunImportError as e:
        session.rollback()
        _map_service_error(e)
