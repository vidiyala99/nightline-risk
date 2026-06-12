"""The pure renewal-term diff brain. Given the expiring policy's coverage terms
and the renewal's proposed terms, name what changed AND whether it's adverse to
the insured — a dropped line, a carved-out exclusion, a lowered limit, or a
raised deductible is the canonical broker-E&O fact pattern (the silent renewal
change that gets brokers sued). No DB, no I/O — diffs two normalized term sets."""
from decimal import Decimal

from app.coverage.renewal_diff import (
    PolicyTerms,
    terms_from_coverage_terms,
    diff_renewal_terms,
)


def _terms(carrier, lines_dict):
    return terms_from_coverage_terms(carrier, list(lines_dict.keys()), lines_dict)


def test_extract_coerces_money_strings_and_exclusions():
    t = terms_from_coverage_terms(
        "c1", ["gl"],
        {"gl": {"per_occurrence": "1000000", "aggregate": "2000000",
                "deductible": "2500", "exclusions": ["AssaultAndBattery"]}},
    )
    assert isinstance(t, PolicyTerms)
    assert t.lines["gl"].per_occurrence == Decimal("1000000")
    assert t.lines["gl"].deductible == Decimal("2500")
    assert "AssaultAndBattery" in t.lines["gl"].exclusions


def test_dropped_line_is_detected_and_adverse():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000"},
                             "liquor": {"per_occurrence": "1000000"}})
    renewal = _terms("c1", {"gl": {"per_occurrence": "1000000"}})
    d = diff_renewal_terms(expiring, renewal)
    assert d.dropped_lines == ["liquor"]
    assert d.has_adverse is True


def test_added_line_is_not_adverse():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000"}})
    renewal = _terms("c1", {"gl": {"per_occurrence": "1000000"},
                            "epli": {"per_occurrence": "500000"}})
    d = diff_renewal_terms(expiring, renewal)
    assert d.added_lines == ["epli"]
    assert d.dropped_lines == []
    assert d.has_adverse is False


def test_lowered_limit_is_adverse():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000"}})
    renewal = _terms("c1", {"gl": {"per_occurrence": "500000"}})
    d = diff_renewal_terms(expiring, renewal)
    change = next(c for c in d.limit_changes if c.field == "per_occurrence")
    assert change.old == Decimal("1000000")
    assert change.new == Decimal("500000")
    assert change.adverse is True
    assert d.has_adverse is True


def test_raised_deductible_is_adverse():
    expiring = _terms("c1", {"gl": {"deductible": "2500"}})
    renewal = _terms("c1", {"gl": {"deductible": "10000"}})
    d = diff_renewal_terms(expiring, renewal)
    change = next(c for c in d.limit_changes if c.field == "deductible")
    assert change.adverse is True


def test_higher_limit_is_favorable_not_adverse():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000"}})
    renewal = _terms("c1", {"gl": {"per_occurrence": "2000000"}})
    d = diff_renewal_terms(expiring, renewal)
    change = next(c for c in d.limit_changes if c.field == "per_occurrence")
    assert change.adverse is False
    assert d.has_adverse is False


def test_added_exclusion_is_adverse():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000", "exclusions": []}})
    renewal = _terms("c1", {"gl": {"per_occurrence": "1000000",
                                   "exclusions": ["AssaultAndBattery"]}})
    d = diff_renewal_terms(expiring, renewal)
    assert ("gl", "AssaultAndBattery") in d.added_exclusions
    assert d.has_adverse is True


def test_removed_exclusion_is_favorable():
    expiring = _terms("c1", {"gl": {"exclusions": ["AssaultAndBattery"]}})
    renewal = _terms("c1", {"gl": {"exclusions": []}})
    d = diff_renewal_terms(expiring, renewal)
    assert ("gl", "AssaultAndBattery") in d.removed_exclusions
    assert d.added_exclusions == []
    assert d.has_adverse is False


def test_carrier_change_is_flagged():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000"}})
    renewal = _terms("c2", {"gl": {"per_occurrence": "1000000"}})
    d = diff_renewal_terms(expiring, renewal)
    assert d.carrier_changed is True


def test_identical_terms_have_no_adverse_change():
    same = {"gl": {"per_occurrence": "1000000", "aggregate": "2000000",
                   "deductible": "2500", "exclusions": ["Pyro"]}}
    d = diff_renewal_terms(_terms("c1", same), _terms("c1", same))
    assert d.has_adverse is False
    assert d.dropped_lines == [] and d.added_exclusions == [] and not d.carrier_changed
    assert all(not c.adverse for c in d.limit_changes)


def test_adverse_findings_are_human_readable():
    expiring = _terms("c1", {"gl": {"per_occurrence": "1000000"},
                             "liquor": {"per_occurrence": "1000000"}})
    renewal = _terms("c2", {"gl": {"per_occurrence": "500000",
                                   "exclusions": ["AssaultAndBattery"]}})
    d = diff_renewal_terms(expiring, renewal)
    blob = " ".join(d.adverse_findings).lower()
    assert "liquor" in blob          # dropped line
    assert "assault" in blob         # added exclusion
    assert "gl" in blob              # lowered limit line
