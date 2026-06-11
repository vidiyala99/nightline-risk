from datetime import date
from decimal import Decimal

from app.extraction.schema import RawTable
from app.extraction.loss_run_parser import parse_loss_run


def test_maps_synonym_headers_and_coerces_values():
    table = RawTable(
        header=["DOL", "Coverage", "Net Paid", "Outstanding", "Claim No"],
        rows=[["05/01/2026", "A&B", "$1,200.50", "500", "CL-9"]],
    )
    [row] = parse_loss_run(table)
    assert row.date_of_loss == date(2026, 5, 1)
    assert row.coverage_line == "assault_battery"
    assert row.paid == Decimal("1200.50")
    assert row.reserve == Decimal("500.00")
    assert row.carrier_claim_number == "CL-9"
    assert row.field_confidence["paid"] == 0.9          # synonym header
    assert row.raw_values["paid"] == "$1,200.50"


def test_bad_money_cell_lowers_confidence_and_keeps_raw():
    table = RawTable(header=["Date of Loss", "Paid"], rows=[["2026-05-01", "N/A"]])
    [row] = parse_loss_run(table)
    assert row.paid is None
    assert row.field_confidence["paid"] == 0.5          # coercion failed on a mapped field
    assert row.raw_values["paid"] == "N/A"
    assert row.field_confidence["date_of_loss"] == 1.0  # exact header


def test_skips_rows_with_no_mapped_data():
    table = RawTable(header=["Paid"], rows=[["100"], ["   "], ["TOTAL"]])
    rows = parse_loss_run(table)
    assert [r.paid for r in rows] == [Decimal("100.00"), None]  # blank skipped; TOTAL kept (coerces None)


def test_extractor_seam_overrides_deterministic():
    sentinel = object()
    assert parse_loss_run(RawTable(header=[], rows=[]), extractor=lambda t: sentinel) is sentinel
