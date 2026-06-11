from app.extraction.synonyms import normalize_coverage_line, resolve_header


def test_exact_canonical_header_is_full_confidence():
    assert resolve_header("Date of Loss") == ("date_of_loss", 1.0)


def test_known_synonym_is_high_confidence():
    assert resolve_header("DOL") == ("date_of_loss", 0.9)
    assert resolve_header("Net Paid") == ("paid", 0.9)
    assert resolve_header("Outstanding") == ("reserve", 0.9)


def test_unknown_header_is_unmapped():
    assert resolve_header("Random Column") == (None, 0.0)


def test_coverage_line_normalization():
    assert normalize_coverage_line("A&B") == "assault_battery"
    assert normalize_coverage_line("General Liability") == "general_liability"
    assert normalize_coverage_line("Mystery Line") == "mystery line"  # unmapped -> normalized raw
