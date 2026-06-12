"""Neon/Postgres hardening: a Column(JSON) dict field round-trips as a dict on
SQLite but can read back as a JSON *string* on Postgres. The ingested-policy
read path .get()s into source_metadata — un-coerced, that raises only on prod
(and the coverage/citation consumers then silently degrade). Coerce at the
boundary, like _as_list does for JSON list columns."""
from app.knowledge_sources import _as_meta


def test_dict_passes_through():
    assert _as_meta({"node_id": "n1"}) == {"node_id": "n1"}


def test_json_string_is_parsed():
    assert _as_meta('{"node_id": "n1", "clause_id": "9.1"}') == {"node_id": "n1", "clause_id": "9.1"}


def test_none_becomes_empty_dict():
    assert _as_meta(None) == {}


def test_empty_string_becomes_empty_dict():
    assert _as_meta("") == {}


def test_garbage_string_becomes_empty_dict():
    assert _as_meta("not json at all") == {}


def test_json_string_of_non_dict_becomes_empty_dict():
    # A JSON array is valid JSON but not a metadata dict — must not leak a list.
    assert _as_meta("[1, 2, 3]") == {}
