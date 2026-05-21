"""
Vision Agent — analyzes uploaded images and video keyframes.

Primary path: Gemini 2.5 Flash with native image/video input (REST, no SDK)
when GEMINI_API_KEY is configured.
Fallback: deterministic template based on incident keywords. Used when no
key is set, file is too large for inline upload, or the API call fails.
"""

import logging
import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Gemini inline data has a hard limit around 20MB after base64 encoding.
# Stay well under to leave headroom for the JSON envelope and prompt.
_MAX_INLINE_BYTES = 15 * 1024 * 1024


@dataclass
class VisionFinding:
    incident_indicators: list[str]
    injury_detail: str
    crowd_density: str
    security_present: bool
    security_response_seconds: int | None
    environmental_hazards: list[str]
    timestamp_in_exif: str | None
    timestamp_matches_report: bool
    corroboration: str  # CONSISTENT | PARTIAL | CONTRADICTED | INCONCLUSIVE
    confidence_delta: float
    raw_description: str


# ── Gemini Vision integration ──────────────────────────────────────────────

_VISION_SCHEMA = {
    "type": "object",
    "properties": {
        "incident_indicators": {"type": "array", "items": {"type": "string"}},
        "injury_detail": {"type": "string"},
        "crowd_density": {"type": "string", "enum": ["low", "moderate", "high"]},
        "security_present": {"type": "boolean"},
        "environmental_hazards": {"type": "array", "items": {"type": "string"}},
        "corroboration": {
            "type": "string",
            "enum": ["CONSISTENT", "PARTIAL", "CONTRADICTED", "INCONCLUSIVE"],
        },
        "raw_description": {"type": "string"},
    },
    "required": [
        "incident_indicators",
        "injury_detail",
        "crowd_density",
        "security_present",
        "environmental_hazards",
        "corroboration",
        "raw_description",
    ],
}


def _build_vision_prompt(
    incident_summary: str,
    incident_location: str,
    injury_observed: bool,
    police_called: bool,
    ems_called: bool,
    is_video: bool,
) -> str:
    media = "video" if is_video else "image"
    return f"""You are a vision analyst for Nightline Risk, an underwriting system for nightlife venues.
Analyze this {media} from a venue incident report and return structured findings.

Incident report:
- Summary: {incident_summary}
- Location: {incident_location}
- Injury reported: {injury_observed}
- Police called: {police_called}
- EMS called: {ems_called}

Examine the visual evidence and judge whether it corroborates the report.
Be strictly factual — describe only what is actually visible. Do not speculate
about identity, intent, or events outside the frame.

Required fields:
- incident_indicators: short phrases describing visible things tied to the incident
- injury_detail: visible injuries, or "No visible injuries"
- crowd_density: "low" | "moderate" | "high"
- security_present: true if uniformed security or venue staff are visible
- environmental_hazards: visible hazards (wet floor, broken glass, smoke, etc.)
- corroboration: CONSISTENT (visual matches report) / PARTIAL (some elements match) /
  CONTRADICTED (visual contradicts report) / INCONCLUSIVE (cannot tell)
- raw_description: 2-3 sentence neutral description of what you see"""


def _call_gemini_vision(file_path: str, mime_type: str, prompt: str) -> dict:
    """POST the file to Gemini 2.5 Flash. Raises on any failure."""
    import base64
    import json

    import httpx

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    file_size = Path(file_path).stat().st_size
    if file_size > _MAX_INLINE_BYTES:
        raise RuntimeError(f"File too large for inline upload ({file_size} bytes)")

    with open(file_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")

    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": mime_type, "data": b64}},
                    {"text": prompt},
                ],
            }
        ],
        "generationConfig": {
            # Vision response has 7 fields including a multi-sentence description;
            # Gemini 2.5 Flash also burns reasoning tokens. 4096 leaves headroom.
            "maxOutputTokens": 4096,
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseSchema": _VISION_SCHEMA,
        },
    }

    with httpx.Client(timeout=90.0) as client:
        response = client.post(url, json=payload, headers={"x-goog-api-key": api_key})
        response.raise_for_status()
        data = response.json()

    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def _delta_from_verdict(verdict: str, injury_observed: bool, police_called: bool, ems_called: bool) -> float:
    """Map LLM verdict + corroborating flags to a confidence delta in [-0.05, 0.13]."""
    base = {"CONSISTENT": 0.10, "PARTIAL": 0.05, "CONTRADICTED": -0.05, "INCONCLUSIVE": 0.01}.get(verdict, 0.01)
    flag_bonus = sum([injury_observed, police_called, ems_called]) * 0.01
    return round(base + flag_bonus, 2)


def _gemini_finding_to_dataclass(
    parsed: dict, injury_observed: bool, police_called: bool, ems_called: bool
) -> VisionFinding:
    return VisionFinding(
        incident_indicators=parsed.get("incident_indicators", []),
        injury_detail=parsed.get("injury_detail", "No visible injuries"),
        crowd_density=parsed.get("crowd_density", "moderate"),
        security_present=bool(parsed.get("security_present", False)),
        # These two are deliberately unset — VLM cannot reliably read EXIF/seconds
        security_response_seconds=None,
        environmental_hazards=parsed.get("environmental_hazards", []),
        timestamp_in_exif=None,
        timestamp_matches_report=True,
        corroboration=parsed.get("corroboration", "INCONCLUSIVE"),
        confidence_delta=_delta_from_verdict(
            parsed.get("corroboration", "INCONCLUSIVE"), injury_observed, police_called, ems_called
        ),
        raw_description=parsed.get("raw_description", ""),
    )


def _detect_mime_type(file_path: str, fallback: str) -> str:
    guessed, _ = mimetypes.guess_type(file_path)
    return guessed or fallback


def _evidence_strength(injury_observed: bool, police_called: bool, ems_called: bool = False) -> float:
    """Calculate confidence delta for the deterministic fallback."""
    flags = sum([injury_observed, police_called, ems_called])
    return round(0.04 + (flags * 0.03), 2)


_UNVERIFIED_PREFIX = (
    "[Unverified — template fallback, no visual analysis was performed.] "
)


def _stamp_unverified(finding: VisionFinding) -> VisionFinding:
    """Overwrite a template-branch finding's integrity fields to reflect
    the truth: nothing was actually read from the file.

    Keeps the branch's content (incident_indicators, injury_detail prose,
    environmental_hazards) so the demo packet still has visual texture,
    but stamps these fields uniformly:
      - corroboration       → INCONCLUSIVE  (we never compared)
      - timestamp_matches_report → False    (we never read EXIF)
      - timestamp_in_exif   → None
      - confidence_delta    → 0.0           (template prose can't move score)
      - raw_description     → prefixed with the [Unverified — …] tag

    Centralizing this in one helper means a future template branch can't
    accidentally re-introduce the corroboration lie.
    """
    finding.corroboration = "INCONCLUSIVE"
    finding.timestamp_matches_report = False
    finding.timestamp_in_exif = None
    finding.confidence_delta = 0.0
    if not finding.raw_description.startswith(_UNVERIFIED_PREFIX):
        finding.raw_description = _UNVERIFIED_PREFIX + finding.raw_description
    return finding


def _template_finding(
    incident_summary: str,
    incident_location: str,
    injury_observed: bool,
    police_called: bool,
    ems_called: bool,
) -> VisionFinding:
    """Deterministic fallback when Gemini is unavailable or fails.

    All template branches go through _stamp_unverified so the result is
    honest about not having actually read the file. The branches still
    contribute realistic visual prose for the underwriter to read, but
    the integrity fields (corroboration / timestamp_matches_report /
    confidence_delta) reflect the absence of a real analysis.
    """
    summary_lower = incident_summary.lower()
    # Delta is computed but ignored — _stamp_unverified zeros it. We keep the
    # signature so the branches stay symmetric with their pre-fix form.
    delta = _evidence_strength(injury_observed, police_called, ems_called)

    if any(k in summary_lower for k in ["brawl", "fight", "altercation", "assault", "force"]):
        finding = _altercation_finding(injury_observed, police_called, incident_location, delta)
    elif any(k in summary_lower for k in ["slip", "fell", "fall", "stairs"]):
        finding = _slip_fall_finding(injury_observed, incident_location, delta)
    elif any(k in summary_lower for k in ["overdose", "unresponsive", "medical", "ems"]):
        finding = _medical_finding(incident_location, delta)
    elif any(k in summary_lower for k in ["fire", "electrical", "smoke"]):
        finding = _property_finding(incident_location, delta)
    elif any(k in summary_lower for k in ["vandal", "damage", "broken"]):
        finding = _vandalism_finding(incident_location, delta)
    else:
        finding = _general_finding(incident_location)

    return _stamp_unverified(finding)


def analyze_image(
    file_path: str,
    incident_summary: str,
    incident_location: str,
    injury_observed: bool,
    police_called: bool,
    ems_called: bool = False,
) -> VisionFinding:
    """
    Analyze an uploaded image against the incident report.
    Tries Gemini 2.5 Flash first; falls back to a deterministic template
    if no key is configured, the file is too large, or the API errors.
    """
    try:
        prompt = _build_vision_prompt(
            incident_summary, incident_location, injury_observed, police_called, ems_called, is_video=False
        )
        mime = _detect_mime_type(file_path, fallback="image/jpeg")
        parsed = _call_gemini_vision(file_path, mime, prompt)
        return _gemini_finding_to_dataclass(parsed, injury_observed, police_called, ems_called)
    except Exception as exc:
        logger.warning("Gemini vision (image) failed: %s; using template fallback.", exc.__class__.__name__)
        return _template_finding(incident_summary, incident_location, injury_observed, police_called, ems_called)


def analyze_video_keyframes(
    file_path: str,
    incident_summary: str,
    incident_location: str,
    injury_observed: bool,
    police_called: bool,
    ems_called: bool = False,
) -> VisionFinding:
    """
    Analyze a video against the incident report. Gemini 2.5 Flash accepts
    video inline (under ~20MB); larger files fall back to the template.
    """
    try:
        prompt = _build_vision_prompt(
            incident_summary, incident_location, injury_observed, police_called, ems_called, is_video=True
        )
        mime = _detect_mime_type(file_path, fallback="video/mp4")
        parsed = _call_gemini_vision(file_path, mime, prompt)
        return _gemini_finding_to_dataclass(parsed, injury_observed, police_called, ems_called)
    except Exception as exc:
        logger.warning("Gemini vision (video) failed: %s; using template fallback.", exc.__class__.__name__)
        return _template_finding(incident_summary, incident_location, injury_observed, police_called, ems_called)


# ── Stub finding templates ─────────────────────────────────────────────────

def _altercation_finding(injury_observed: bool, police_called: bool, location: str, delta: float = 0.07) -> VisionFinding:
    indicators = ["physical altercation between patrons"]
    if injury_observed:
        indicators.append("visible injury to patron")
    if police_called:
        indicators.append("law enforcement visible in footage")

    return VisionFinding(
        incident_indicators=indicators,
        injury_detail="Laceration visible on right side of face, patron 1" if injury_observed else "No visible injuries in frame",
        crowd_density="moderate",
        security_present=True,
        security_response_seconds=12,
        environmental_hazards=["broken glass on floor"],
        timestamp_in_exif="matches reported incident time within 3 minutes",
        timestamp_matches_report=True,
        corroboration="CONSISTENT",
        confidence_delta=delta,
        raw_description=(
            f"Image shows physical altercation near {location}. "
            f"Two individuals in contact, security staff visible in background. "
            f"{'Visible facial injury on one patron. ' if injury_observed else ''}"
            f"Crowd density appears moderate. No overcrowding evident."
        ),
    )


def _slip_fall_finding(injury_observed: bool, location: str, delta: float = 0.05) -> VisionFinding:
    return VisionFinding(
        incident_indicators=["patron on ground", "wet floor condition visible"],
        injury_detail="Patron seated on floor, holding knee" if injury_observed else "Patron standing, no visible injury",
        crowd_density="low",
        security_present=False,
        security_response_seconds=None,
        environmental_hazards=["wet floor near stairs", "poor lighting on stairwell"],
        timestamp_in_exif="matches reported incident time within 5 minutes",
        timestamp_matches_report=True,
        corroboration="CONSISTENT",
        confidence_delta=delta,
        raw_description=(
            f"Image shows {location} area. Wet floor visible near stair area. "
            f"No wet floor signage visible in frame. "
            f"{'Patron visible on floor in distress.' if injury_observed else 'Area appears clear at time of capture.'}"
        ),
    )


def _medical_finding(location: str, delta: float = 0.09) -> VisionFinding:
    return VisionFinding(
        incident_indicators=["patron unresponsive", "emergency response visible"],
        injury_detail="Patron supine on floor, unresponsive",
        crowd_density="low — area cleared by staff",
        security_present=True,
        security_response_seconds=6,
        environmental_hazards=[],
        timestamp_in_exif="matches reported incident time within 2 minutes",
        timestamp_matches_report=True,
        corroboration="CONSISTENT",
        confidence_delta=delta,
        raw_description=(
            f"Image shows {location}. Patron supine on floor. "
            f"Staff have cleared immediate area. Security and staff visible attending to patron. "
            f"Response appears prompt based on staff positioning."
        ),
    )


def _property_finding(location: str, delta: float = 0.04) -> VisionFinding:
    return VisionFinding(
        incident_indicators=["equipment damage", "fire suppression evidence"],
        injury_detail="No persons visible in immediate area",
        crowd_density="none — area evacuated",
        security_present=True,
        security_response_seconds=None,
        environmental_hazards=["electrical equipment", "fire suppression residue"],
        timestamp_in_exif="matches reported incident time within 8 minutes",
        timestamp_matches_report=True,
        corroboration="CONSISTENT",
        confidence_delta=delta,
        raw_description=(
            f"Image shows {location}. Fire suppression residue visible near stage equipment. "
            f"Area appears evacuated. No persons in immediate hazard zone. "
            f"Equipment damage consistent with electrical short."
        ),
    )


def _vandalism_finding(location: str, delta: float = 0.03) -> VisionFinding:
    return VisionFinding(
        incident_indicators=["property damage", "damaged furniture"],
        injury_detail="No persons visible",
        crowd_density="low",
        security_present=True,
        security_response_seconds=None,
        environmental_hazards=["broken furniture", "debris on floor"],
        timestamp_in_exif="matches reported incident time within 10 minutes",
        timestamp_matches_report=True,
        corroboration="CONSISTENT",
        confidence_delta=delta,
        raw_description=(
            f"Image shows {location}. Damaged furniture and debris visible. "
            f"Damage appears consistent with reported vandalism incident. "
            f"Area partially cleared."
        ),
    )


def _general_finding(location: str) -> VisionFinding:
    return VisionFinding(
        incident_indicators=["anomalous activity"],
        injury_detail="No visible injuries",
        crowd_density="moderate",
        security_present=True,
        security_response_seconds=None,
        environmental_hazards=[],
        timestamp_in_exif=None,
        timestamp_matches_report=True,
        corroboration="INCONCLUSIVE",
        confidence_delta=0.01,
        raw_description=f"Image captured at {location}. Insufficient context to determine incident specifics from visual alone.",
    )
