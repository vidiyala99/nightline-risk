"""The pure exposure→exclusion mapping brain. No I/O — given a venue's loss
signals it names the exposure categories, and given an exclusion clause's text
it decides whether that clause bites on a category. This is what makes a
'your policy excludes X but X is your top loss' finding deterministic + cited."""

from app.coverage.exposure_map import (
    EXPOSURE_CATEGORIES,
    signals_for_incident,
    rank_exposures,
    clause_matches_category,
    category_label,
)


def test_signals_match_structured_incident_category():
    assert signals_for_incident("assault_battery", "patron escorted out") == {"assault_battery"}


def test_signals_match_summary_keyword_when_category_missing():
    assert signals_for_incident(None, "Brawl broke out near the bar") == {"assault_battery"}


def test_signals_can_match_multiple_categories():
    got = signals_for_incident(None, "An intoxicated patron started a fight")
    assert "liquor" in got
    assert "assault_battery" in got


def test_signals_empty_for_unrelated_loss():
    assert signals_for_incident(None, "Guest slipped on a wet floor by the stairs") == set()


def test_signals_are_case_insensitive():
    assert signals_for_incident(None, "GUN was DISCHARGED") == {"firearms"}


def test_rank_exposures_orders_by_frequency_desc():
    incidents = [
        (None, "fight at the door"),
        (None, "altercation on the floor"),
        (None, "intoxicated guest over-served"),
    ]
    ranked = rank_exposures(incidents)
    # assault_battery (2) outranks liquor (1)
    assert ranked[0][0] == "assault_battery"
    assert ranked[0][1] == 2
    assert ("liquor", 1) in ranked


def test_rank_exposures_empty_when_no_signals():
    assert rank_exposures([(None, "routine close, nothing of note")]) == []


def test_clause_matches_category_on_exclusion_keyword():
    clause = "This policy excludes any claim arising from assault and battery on the premises."
    assert clause_matches_category(clause, "assault_battery") is True


def test_clause_does_not_match_unrelated_category():
    clause = "This policy excludes any claim arising from assault and battery on the premises."
    assert clause_matches_category(clause, "liquor") is False


def test_clause_match_is_case_insensitive():
    assert clause_matches_category("LIQUOR LIABILITY is EXCLUDED", "liquor") is True


def test_every_category_has_label_signals_and_exclusion_keywords():
    assert EXPOSURE_CATEGORIES, "must define at least one exposure category"
    for cat in EXPOSURE_CATEGORIES:
        assert category_label(cat.key)
        assert cat.incident_signals
        assert cat.exclusion_keywords
