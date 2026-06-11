"""Loss-run import service: store -> parse -> persist (review-only artifact).

Never creates Claim/money rows. Never commits (the router owns the transaction).
"""
from __future__ import annotations

import hashlib
from uuid import uuid4

from sqlmodel import Session

from app.ai_provenance import make_provenance
from app.extraction.loss_run_parser import parse_loss_run
from app.extraction.readers import read_table
from app.files import sanitize_filename
from app.models import LossRunImport, LossRunImportRow
from app.packet_core import _add_audit_event
from app.storage import get_storage

_SUPPORTED = ("csv", "xlsx")
_PARSER_VERSION = "loss-run-parser-v1"


class LossRunImportError(Exception):
    """Bad format / unreadable file / empty document. Router maps to 400."""


def create_loss_run_import(
    session: Session,
    *,
    file_bytes: bytes,
    filename: str,
    source_format: str,
    uploaded_by: str,
    venue_id: str | None = None,
    submission_id: str | None = None,
) -> LossRunImport:
    if source_format not in _SUPPORTED:
        raise LossRunImportError(f"unsupported format {source_format!r} (supported: {_SUPPORTED})")

    safe = sanitize_filename(filename)
    import_id = f"lri-{uuid4().hex[:12]}"
    storage_ref = get_storage().save(f"loss_runs/{import_id}_{safe}", file_bytes)

    try:
        table = read_table(file_bytes, source_format)
    except Exception as exc:  # reader failure -> typed error, not a 500
        raise LossRunImportError(f"could not read {source_format} file: {exc}") from exc

    rows = parse_loss_run(table)
    if not rows:
        raise LossRunImportError("no data rows found in the loss run")

    provenance = make_provenance(
        provider="deterministic",
        model=_PARSER_VERSION,
        prompt_version=_PARSER_VERSION,
        inputs={"sha256": hashlib.sha256(file_bytes).hexdigest(), "format": source_format},
    ).model_dump()

    imp = LossRunImport(
        id=import_id, filename=safe, storage_key=storage_ref, source_format=source_format,
        venue_id=venue_id, submission_id=submission_id, uploaded_by=uploaded_by,
        row_count=len(rows), provenance=provenance,
    )
    session.add(imp)
    session.flush()  # parent visible before child FK insert (project_postgres_fk_ordering)

    for i, r in enumerate(rows):
        session.add(LossRunImportRow(
            id=f"lrr-{uuid4().hex[:12]}", import_id=import_id, row_index=i,
            date_of_loss=r.date_of_loss, coverage_line=r.coverage_line, claim_status=r.claim_status,
            claimant=r.claimant, description=r.description, carrier_claim_number=r.carrier_claim_number,
            reserve=r.reserve, paid=r.paid, incurred=r.incurred,
            field_confidence=r.field_confidence, raw_values=r.raw_values,
        ))

    _add_audit_event(
        session=session, actor_id=uploaded_by, actor_type="user",
        entity_type="loss_run_import", entity_id=import_id,
        event_type="loss_run_import.extracted",
        event_metadata={"row_count": len(rows), "format": source_format, "provenance": provenance},
    )
    return imp


def link_to_submission(session: Session, import_id: str, submission_id: str) -> LossRunImport:
    imp = session.get(LossRunImport, import_id)
    if imp is None:
        raise LossRunImportError(f"loss-run import {import_id!r} not found")
    imp.submission_id = submission_id
    session.add(imp)
    _add_audit_event(
        session=session, actor_id="system", actor_type="user",
        entity_type="loss_run_import", entity_id=import_id,
        event_type="loss_run_import.linked", event_metadata={"submission_id": submission_id},
    )
    return imp
