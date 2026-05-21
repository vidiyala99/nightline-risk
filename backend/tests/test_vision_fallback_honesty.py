"""Vision template fallback must NOT claim corroboration it didn't earn.

Before this fix, every template branch in vision_agent.py hardcoded
`corroboration="CONSISTENT"` and `timestamp_matches_report=True` — even
though no Gemini call was made and the actual file was never opened. The
corroboration aggregator then read those flags and emitted "CONSISTENT"
for the whole packet on the strength of templates alone.

After the fix, the template path is honest:
  - corroboration = "INCONCLUSIVE"
  - timestamp_matches_report = False  (we don't know — nothing was read)
  - timestamp_in_exif = None
  - confidence_delta = 0.0  (template prose doesn't move the score)
  - raw_description marked as template-generated

These tests pin those invariants per branch + the downstream effect on
the corroboration aggregator.
"""

import os
from unittest.mock import patch

from app.agents.vision_agent import analyze_image, analyze_video_keyframes, VisionFinding
from app.agents.corroboration_agent import corroborate


# ─── Helpers ─────────────────────────────────────────────────────────────

def _no_gemini_env():
    """Force the template fallback path by removing the key."""
    return patch.dict(os.environ, {}, clear=False) if "GEMINI_API_KEY" not in os.environ \
        else patch.dict(os.environ, {"GEMINI_API_KEY": ""})


def _run_image_fallback(summary: str = "Brawl in patio", **kwargs) -> VisionFinding:
    """Call analyze_image with a non-existent file so the Gemini call fails
    and we end up on the template path."""
    with _no_gemini_env():
        return analyze_image(
            file_path="/does/not/exist.jpg",
            incident_summary=summary,
            incident_location="patio",
            injury_observed=kwargs.get("injury_observed", False),
            police_called=kwargs.get("police_called", False),
            ems_called=kwargs.get("ems_called", False),
        )


# ─── Per-branch honesty (each summary triggers a different template) ────

def test_altercation_template_does_not_claim_corroboration():
    f = _run_image_fallback("Brawl in patio with two patrons fighting.")
    assert f.corroboration == "INCONCLUSIVE", f
    assert f.timestamp_matches_report is False
    assert f.timestamp_in_exif is None


def test_slip_fall_template_does_not_claim_corroboration():
    f = _run_image_fallback("Patron slipped on stairs near coat check.")
    assert f.corroboration == "INCONCLUSIVE"
    assert f.timestamp_matches_report is False


def test_medical_template_does_not_claim_corroboration():
    f = _run_image_fallback("Patron overdosed, unresponsive, EMS transported.")
    assert f.corroboration == "INCONCLUSIVE"
    assert f.timestamp_matches_report is False


def test_property_template_does_not_claim_corroboration():
    f = _run_image_fallback("Electrical fire and smoke near stage equipment.")
    assert f.corroboration == "INCONCLUSIVE"
    assert f.timestamp_matches_report is False


def test_vandalism_template_does_not_claim_corroboration():
    f = _run_image_fallback("Vandalism: broken furniture in main floor area.")
    assert f.corroboration == "INCONCLUSIVE"
    assert f.timestamp_matches_report is False


def test_general_template_is_inconclusive_too():
    """The 'general' branch was already INCONCLUSIVE — confirm it stays so."""
    f = _run_image_fallback("Unspecified disturbance at venue.")
    assert f.corroboration == "INCONCLUSIVE"
    assert f.timestamp_matches_report is False


# ─── Confidence neutrality on the template path ──────────────────────────

def test_template_findings_do_not_move_confidence():
    """The deterministic prose is a placeholder — it must not nudge
    confidence delta. Otherwise an offline demo silently confirms claims."""
    for summary in [
        "Brawl in patio.",
        "Patron slipped on stairs.",
        "Patron overdosed, unresponsive.",
        "Electrical fire near stage.",
        "Vandalism: broken furniture.",
    ]:
        f = _run_image_fallback(summary)
        assert f.confidence_delta == 0.0, f"summary='{summary}' → delta={f.confidence_delta}"


# ─── Visibility of the fallback in raw_description ───────────────────────

def test_raw_description_signals_unverified_status():
    """Underwriter glancing at raw_description should see this is template-
    generated, not an actual visual analysis."""
    f = _run_image_fallback("Brawl in patio.")
    text = f.raw_description.lower()
    assert "unverified" in text or "template" in text or "not analyzed" in text, f.raw_description


# ─── Video path mirrors the image path ───────────────────────────────────

def test_video_fallback_also_honest():
    with _no_gemini_env():
        f = analyze_video_keyframes(
            file_path="/does/not/exist.mp4",
            incident_summary="Brawl in patio.",
            incident_location="patio",
            injury_observed=True,
            police_called=False,
            ems_called=False,
        )
    assert f.corroboration == "INCONCLUSIVE"
    assert f.timestamp_matches_report is False
    assert f.confidence_delta == 0.0


# ─── Downstream effect: corroboration aggregator on all-template input ──

def test_corroboration_is_inconclusive_when_all_findings_are_templates():
    """The critical end-to-end claim: if every uploaded file ran through
    the template path, the underwriter's packet must NOT see 'CONSISTENT'."""
    findings = [
        _run_image_fallback("Brawl in patio."),
        _run_image_fallback("Brawl in patio."),
        _run_image_fallback("Brawl in patio."),
    ]
    result = corroborate(
        findings=findings,
        incident_summary="Brawl in patio.",
        injury_observed=False,
        police_called=False,
        ems_called=False,
    )
    assert result.status != "CONSISTENT", (
        f"All-template input must not produce CONSISTENT; got {result.status}"
    )


def test_corroboration_flags_timestamp_discrepancy_for_all_templates():
    """With timestamp_matches_report=False, the aggregator records a
    discrepancy flag — making the lack of verification visible."""
    findings = [_run_image_fallback("Brawl in patio.")]
    result = corroborate(
        findings=findings,
        incident_summary="Brawl in patio.",
        injury_observed=False,
        police_called=False,
        ems_called=False,
    )
    joined = " ".join(result.flags).lower()
    assert "timestamp discrepancy" in joined or "not" in joined, result.flags
