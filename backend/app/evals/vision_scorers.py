"""Deterministic eval for the vision agent (`app/agents/vision_agent.py`).

The vision agent is the only LLM that emits *factual* findings (injury detail,
crowd density, security response, hazards) which flow downstream into risk
scoring AND fraud detection. This scorer brings it under the same eval-gated
discipline as the packet agents — and does so **key-free**, scoring the three
properties that hold whether or not `GEMINI_API_KEY` is set:

  * `score_vision_routing`  — the no-key template path routes an incident
    summary to the correct finding family (its factual output).
  * `score_vision_honesty`  — every template finding is honestly stamped
    'unverified' (corroboration INCONCLUSIVE, confidence_delta 0.0, EXIF/
    timestamp-match cleared, raw_description tagged), so the no-key path can
    never claim a corroboration it did not perform.
  * `score_vision_mapping`  — the Gemini→dataclass mapping clamps any LLM
    response to the contract: `security_response_seconds` and
    `timestamp_in_exif` are forced to None (a VLM can't read them) and
    `confidence_delta` is bound strictly to the verdict, so the LLM can't
    inject a fabricated response time or EXIF claim.

Mirrors `fraud_scorer.py`: each `score_*` returns {accuracy, n, misses}.
"""
from __future__ import annotations

from app.agents.vision_agent import (
    _UNVERIFIED_PREFIX,
    _delta_from_verdict,
    _gemini_finding_to_dataclass,
    _template_finding,
)

_LOCATION = "main floor"

# (label, incident_summary, marker-that-must-appear-in-the-finding)
_ROUTING_FIXTURES: list[tuple[str, str, str]] = [
    ("altercation", "Brawl broke out near the bar; security intervened", "altercation"),
    ("slip_fall", "Patron slipped and fell on the stairs", "wet floor"),
    ("medical", "Patron unresponsive after possible overdose; EMS called", "unresponsive"),
    ("property", "Electrical fire near the stage filled the room with smoke", "fire suppression"),
    ("vandalism", "Vandals broke furniture and damaged the restroom", "damage"),
    ("general", "Neighbor noise complaint about the rooftop area", "anomalous activity"),
]


def _template_for(summary: str):
    return _template_finding(
        incident_summary=summary,
        incident_location=_LOCATION,
        injury_observed=False,
        police_called=False,
        ems_called=False,
    )


def score_vision_routing() -> dict:
    """The deterministic template routes a summary to the right finding family."""
    correct = 0
    misses: list[str] = []
    for label, summary, marker in _ROUTING_FIXTURES:
        finding = _template_for(summary)
        haystack = " ".join(
            [
                *finding.incident_indicators,
                *finding.environmental_hazards,
                finding.raw_description,
            ]
        ).lower()
        if marker.lower() in haystack:
            correct += 1
        else:
            misses.append(f"{label}: marker {marker!r} missing from finding")
    return {
        "accuracy": round(correct / len(_ROUTING_FIXTURES), 3) if _ROUTING_FIXTURES else 1.0,
        "n": len(_ROUTING_FIXTURES),
        "misses": misses,
    }


def score_vision_honesty() -> dict:
    """The no-key path must never assert a corroboration it didn't perform."""
    correct = 0
    misses: list[str] = []
    for label, summary, _ in _ROUTING_FIXTURES:
        f = _template_for(summary)
        honest = (
            f.corroboration == "INCONCLUSIVE"
            and f.confidence_delta == 0.0
            and f.timestamp_matches_report is False
            and f.timestamp_in_exif is None
            and f.raw_description.startswith(_UNVERIFIED_PREFIX)
        )
        if honest:
            correct += 1
        else:
            misses.append(
                f"{label}: unverified stamp violated "
                f"(corrob={f.corroboration}, delta={f.confidence_delta}, "
                f"ts_match={f.timestamp_matches_report})"
            )
    return {
        "accuracy": round(correct / len(_ROUTING_FIXTURES), 3) if _ROUTING_FIXTURES else 1.0,
        "n": len(_ROUTING_FIXTURES),
        "misses": misses,
    }


# (label, parsed-Gemini-dict, (injury, police, ems))
_MAPPING_FIXTURES: list[tuple[str, dict, tuple[bool, bool, bool]]] = [
    (
        "consistent+flags",
        {
            "incident_indicators": ["visible injury"],
            "injury_detail": "laceration on forearm",
            "crowd_density": "high",
            "security_present": True,
            "environmental_hazards": ["broken glass"],
            "corroboration": "CONSISTENT",
            "raw_description": "Two patrons in contact near the bar.",
            # Adversarial: an LLM trying to assert a response time / EXIF must be ignored.
            "security_response_seconds": 3,
            "timestamp_in_exif": "fabricated match",
        },
        (True, True, False),
    ),
    (
        "contradicted",
        {
            "incident_indicators": [],
            "injury_detail": "No visible injuries",
            "crowd_density": "low",
            "security_present": False,
            "environmental_hazards": [],
            "corroboration": "CONTRADICTED",
            "raw_description": "Empty corridor, no incident visible.",
        },
        (False, False, False),
    ),
    (
        "inconclusive",
        {
            "incident_indicators": ["unclear"],
            "injury_detail": "Cannot determine",
            "crowd_density": "moderate",
            "security_present": False,
            "environmental_hazards": [],
            "corroboration": "INCONCLUSIVE",
            "raw_description": "Frame too dark to assess.",
        },
        (False, False, False),
    ),
]


def score_vision_mapping() -> dict:
    """The Gemini→dataclass mapping clamps any LLM response to the contract."""
    correct = 0
    misses: list[str] = []
    for label, parsed, (injury, police, ems) in _MAPPING_FIXTURES:
        f = _gemini_finding_to_dataclass(parsed, injury, police, ems)
        expected_delta = _delta_from_verdict(parsed["corroboration"], injury, police, ems)
        clamped = (
            f.security_response_seconds is None
            and f.timestamp_in_exif is None
            and f.confidence_delta == expected_delta
            and f.corroboration == parsed["corroboration"]
        )
        if clamped:
            correct += 1
        else:
            misses.append(
                f"{label}: contract clamp violated "
                f"(secs={f.security_response_seconds}, exif={f.timestamp_in_exif}, "
                f"delta={f.confidence_delta} vs {expected_delta})"
            )
    return {
        "accuracy": round(correct / len(_MAPPING_FIXTURES), 3) if _MAPPING_FIXTURES else 1.0,
        "n": len(_MAPPING_FIXTURES),
        "misses": misses,
    }


def score_vision_scorer() -> dict:
    """Aggregate report (mirrors the underwriting multi-scorer shape)."""
    return {
        "routing": score_vision_routing(),
        "honesty": score_vision_honesty(),
        "mapping": score_vision_mapping(),
    }
