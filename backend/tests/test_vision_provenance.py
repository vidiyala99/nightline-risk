"""Vision findings carry AI provenance, and it survives the findings-JSON
round-trip the corroboration step depends on (VisionFinding(**a.findings))."""
import os
from unittest.mock import patch

from app.agents.vision_agent import (
    VISION_PROMPT_VERSION,
    VisionFinding,
    analyze_image,
)


def _template_finding() -> VisionFinding:
    env = patch.dict(os.environ, {"GEMINI_API_KEY": ""})
    with env:
        return analyze_image(
            file_path="/does/not/exist.jpg",
            incident_summary="Brawl in the patio",
            incident_location="patio",
            injury_observed=True,
            police_called=False,
            ems_called=False,
        )


def test_template_path_stamps_deterministic_provenance():
    f = _template_finding()
    assert f.provenance is not None
    p = f.provenance
    assert p["provider"] == "deterministic"
    assert p["model"] == "template-v1"
    assert p["prompt_version"] == VISION_PROMPT_VERSION
    assert len(p["input_hash"]) == 16
    # The no-key path is an LLM fallback — record why.
    assert p["fallback_reason"]


def test_provenance_survives_the_findings_json_round_trip():
    f = _template_finding()
    # This is exactly what _run_corroboration_and_update_packet does.
    rebuilt = VisionFinding(**f.__dict__)
    assert rebuilt.provenance == f.provenance
    assert rebuilt.corroboration == f.corroboration
