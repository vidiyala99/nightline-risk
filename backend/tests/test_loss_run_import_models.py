from decimal import Decimal

from app.database import get_session
from app.models import LossRunImport, LossRunImportRow


def test_import_and_row_roundtrip_money_and_json():
    session = next(get_session())
    try:
        imp = LossRunImport(
            id="lri-test1", filename="lr.csv", storage_key="loss_runs/lri-test1_lr.csv",
            source_format="csv", uploaded_by="user-x", row_count=1,
            provenance={"provider": "deterministic", "model": "loss-run-parser-v1"},
        )
        session.add(imp)
        session.flush()  # parent before child (column FK)
        session.add(LossRunImportRow(
            id="lrr-test1", import_id="lri-test1", row_index=0,
            coverage_line="assault_battery", paid=Decimal("1200.50"),
            field_confidence={"paid": 0.9}, raw_values={"paid": "$1,200.50"},
        ))
        session.commit()

        got = session.get(LossRunImportRow, "lrr-test1")
        assert got.paid == Decimal("1200.50")
        assert got.field_confidence == {"paid": 0.9}
        assert session.get(LossRunImport, "lri-test1").status == "extracted"
    finally:
        session.rollback()
        session.close()
