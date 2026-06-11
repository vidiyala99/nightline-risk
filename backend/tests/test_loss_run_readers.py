import io

import openpyxl

from app.extraction.readers import read_table


def test_read_csv_uses_first_row_as_header_and_skips_blank_lines():
    data = b"Date of Loss,Paid\n2026-05-01,100\n\n2026-05-02,200\n"
    table = read_table(data, "csv")
    assert table.header == ["Date of Loss", "Paid"]
    assert table.rows == [["2026-05-01", "100"], ["2026-05-02", "200"]]


def test_read_xlsx_detects_header_row_past_metadata():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Acme Insurance - Loss Run"])   # logo/metadata row
    ws.append([])                               # blank
    ws.append(["Date of Loss", "Paid"])         # real header
    ws.append(["2026-05-01", 100])
    buf = io.BytesIO()
    wb.save(buf)
    table = read_table(buf.getvalue(), "xlsx")
    assert table.header == ["Date of Loss", "Paid"]
    assert table.rows == [["2026-05-01", "100"]]


def test_unsupported_format_raises():
    import pytest
    with pytest.raises(ValueError):
        read_table(b"x", "pdf")
