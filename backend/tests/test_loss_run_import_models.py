from decimal import Decimal
from uuid import uuid4

from app.database import get_session
from app.models import LossRunImport, LossRunImportRow


def test_import_and_row_roundtrip_money_and_json():
    # Unique ids + flush/rollback (never commit) so the test is idempotent against
    # the shared test_run.db. expire_all() forces a real SELECT to exercise the
    # Numeric/JSON column round-trip rather than reading the identity-map cache.
    imp_id = f"lri-{uuid4().hex[:12]}"
    row_id = f"lrr-{uuid4().hex[:12]}"
    session = next(get_session())
    try:
        session.add(LossRunImport(
            id=imp_id, filename="lr.csv", storage_key=f"loss_runs/{imp_id}_lr.csv",
            source_format="csv", uploaded_by="user-x", row_count=1,
            provenance={"provider": "deterministic", "model": "loss-run-parser-v1"},
        ))
        session.flush()  # parent before child (column FK)
        session.add(LossRunImportRow(
            id=row_id, import_id=imp_id, row_index=0,
            coverage_line="assault_battery", paid=Decimal("1200.50"),
            field_confidence={"paid": 0.9}, raw_values={"paid": "$1,200.50"},
        ))
        session.flush()
        session.expire_all()  # drop cached instances -> get() re-reads from the DB

        got = session.get(LossRunImportRow, row_id)
        assert got.paid == Decimal("1200.50")
        assert got.field_confidence == {"paid": 0.9}
        assert session.get(LossRunImport, imp_id).status == "extracted"
    finally:
        session.rollback()
        session.close()
