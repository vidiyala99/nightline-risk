"""The shared AI-provenance primitive: every AI artifact carries
{provider, model, prompt_version, input_hash} so its output is reproducible and
auditable — the sibling of `decision_source`. Hashing follows the house
snapshot-hash discipline (canonical JSON, list order doesn't matter) so a
Postgres JSON re-order can't change a fingerprint."""
from app.ai_provenance import AIProvenance, canonical_input_hash, make_provenance


def test_make_provenance_stamps_all_fields():
    p = make_provenance(
        provider="gemini",
        model="gemini-2.5-flash",
        prompt_version="vision-2026-06-10",
        inputs={"summary": "brawl", "flags": ["injury", "police"]},
    )
    assert isinstance(p, AIProvenance)
    assert p.provider == "gemini"
    assert p.model == "gemini-2.5-flash"
    assert p.prompt_version == "vision-2026-06-10"
    assert len(p.input_hash) == 16
    assert p.fallback_reason is None


def test_input_hash_is_stable_across_key_and_list_order():
    a = canonical_input_hash({"summary": "brawl", "flags": ["injury", "police"]})
    b = canonical_input_hash({"flags": ["police", "injury"], "summary": "brawl"})
    assert a == b  # dict-key order and list order must not change the fingerprint


def test_input_hash_changes_when_inputs_change():
    a = canonical_input_hash({"summary": "brawl"})
    b = canonical_input_hash({"summary": "slip and fall"})
    assert a != b


def test_provenance_round_trips_through_a_json_dict():
    # Artifacts persist as JSON dicts (findings / fraud_signal / audit metadata),
    # so provenance must survive model_dump -> dict -> reload.
    p = make_provenance(
        provider="deterministic", model="template-v1", prompt_version="v1",
        inputs={"x": 1}, fallback_reason="gemini RateLimitError",
    )
    d = p.model_dump()
    assert d["fallback_reason"] == "gemini RateLimitError"
    assert AIProvenance(**d) == p
