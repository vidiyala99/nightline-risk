"""Vision-agent eval gate (deterministic, key-free).

Governs the only LLM-factual-output path that previously had no contract and no
eval scorer (Gemini on uploaded media → findings feeding risk scoring + fraud).
Three key-free dimensions, mirroring the fraud-scorer pattern:

  - routing:  the incident summary routes to the correct finding family — the
              factual output of the no-key template path.
  - honesty:  every template finding is stamped 'unverified' so the no-key path
              can never claim a corroboration it did not perform.
  - mapping:  whatever a (hypothetical) Gemini response contains, the
              LLM→dataclass mapping clamps it to the VisionFinding contract —
              EXIF / security-response-seconds forced to None, confidence_delta
              bound strictly to the verdict. The LLM cannot fabricate those.
"""
from app.evals.vision_scorers import (
    score_vision_honesty,
    score_vision_mapping,
    score_vision_routing,
)


def test_vision_routing_is_100pct_on_labelled_fixtures():
    r = score_vision_routing()
    assert r["n"] >= 6
    assert r["accuracy"] == 1.0, r["misses"]


def test_vision_template_path_never_claims_unperformed_corroboration():
    r = score_vision_honesty()
    assert r["n"] >= 6
    assert r["accuracy"] == 1.0, r["misses"]


def test_vision_llm_output_is_clamped_to_the_contract():
    r = score_vision_mapping()
    assert r["n"] >= 3
    assert r["accuracy"] == 1.0, r["misses"]
