from decimal import Decimal

import pytest
from sqlmodel import select

from app.database import get_session
from app.models import AuditEvent, LossRunImport, LossRunImportRow
from app.services.loss_run_import import LossRunImportError, create_loss_run_import, link_to_submission

# Money value is quoted so its thousands-comma survives CSV parsing (real loss runs quote it).
_CSV = b'Date of Loss,Coverage,Net Paid,Outstanding\n2026-05-01,A&B,"$1,200.50",500\n'


def test_create_persists_rows_provenance_and_audit():
    session = next(get_session())
    try:
        imp = create_loss_run_import(
            session, file_bytes=_CSV, filename="../lr.csv", source_format="csv", uploaded_by="user-x",
        )
        session.flush()
        assert imp.filename == "lr.csv"                       # sanitized
        assert imp.row_count == 1
        assert imp.provenance["provider"] == "deterministic"
        assert imp.provenance["model"] == "loss-run-parser-v1"

        rows = session.exec(select(LossRunImportRow).where(LossRunImportRow.import_id == imp.id)).all()
        assert rows[0].paid == Decimal("1200.50")
        assert rows[0].coverage_line == "assault_battery"

        events = session.exec(select(AuditEvent).where(AuditEvent.entity_id == imp.id)).all()
        assert any(e.event_type == "loss_run_import.extracted" for e in events)
    finally:
        session.rollback()
        session.close()


def test_unsupported_format_raises():
    session = next(get_session())
    try:
        with pytest.raises(LossRunImportError):
            create_loss_run_import(session, file_bytes=b"x", filename="x.pdf",
                                   source_format="pdf", uploaded_by="u")
    finally:
        session.rollback()
        session.close()


def test_empty_loss_run_raises():
    session = next(get_session())
    try:
        with pytest.raises(LossRunImportError):
            create_loss_run_import(session, file_bytes=b"Date of Loss,Paid\n",
                                   source_format="csv", filename="empty.csv", uploaded_by="u")
    finally:
        session.rollback()
        session.close()


def test_link_to_submission_sets_id_and_audits():
    session = next(get_session())
    try:
        imp = create_loss_run_import(session, file_bytes=_CSV, filename="lr.csv",
                                     source_format="csv", uploaded_by="u")
        session.flush()
        link_to_submission(session, imp.id, "sub-123")
        session.flush()
        assert session.get(LossRunImport, imp.id).submission_id == "sub-123"
    finally:
        session.rollback()
        session.close()
