"""
Corroboration Agent — compares visual evidence findings against the written incident report.

This is the highest-value agent in the vision pipeline. It flags when footage
contradicts the operator's written account, which is critical for underwriters.
"""

from dataclasses import dataclass
from app.agents.vision_agent import VisionFinding


# Flag strings consumed by fraud_agent — exported as constants so the two agents
# share a single source of truth (a reword here updates fraud detection too).
INJURY_NOT_VISIBLE_FLAG = "Injury reported but NOT visible in uploaded evidence"
TIMESTAMP_DISCREPANCY_FLAG = "Timestamp discrepancy detected between evidence and report"


@dataclass
class CorroborationResult:
    status: str  # CONSISTENT | PARTIAL | CONTRADICTED | INCONCLUSIVE
    confidence_adjustment: float
    flags: list[str]
    summary: str


def corroborate(
    findings: list[VisionFinding],
    incident_summary: str,
    injury_observed: bool,
    police_called: bool,
    ems_called: bool,
) -> CorroborationResult:
    """
    Compare aggregated vision findings against the written incident report.
    Returns a corroboration status and confidence adjustment.
    """
    if not findings:
        return CorroborationResult(
            status="INCONCLUSIVE",
            confidence_adjustment=0.0,
            flags=["No evidence files processed"],
            summary="No visual evidence available to corroborate the incident report.",
        )

    flags: list[str] = []
    contradictions = 0
    consistencies = 0

    # Aggregate findings across all files
    all_indicators = [ind for f in findings for ind in f.incident_indicators]
    any_injury_visible = any("injury" in f.injury_detail.lower() and "no" not in f.injury_detail.lower() for f in findings)
    all_timestamps_match = all(f.timestamp_matches_report for f in findings)
    avg_confidence_delta = sum(f.confidence_delta for f in findings) / len(findings)

    # Check injury corroboration
    if injury_observed and any_injury_visible:
        consistencies += 1
        flags.append("Visual injury evidence CONSISTENT with report")
    elif injury_observed and not any_injury_visible:
        contradictions += 1
        flags.append(INJURY_NOT_VISIBLE_FLAG)
    elif not injury_observed and any_injury_visible:
        contradictions += 1
        flags.append("Injury visible in footage but NOT reported — review required")

    # Check police/security corroboration
    any_police_visible = any("law enforcement" in " ".join(f.incident_indicators).lower() for f in findings)
    if police_called and any_police_visible:
        consistencies += 1
        flags.append("Law enforcement presence CONSISTENT with report")

    # Check timestamp corroboration
    if all_timestamps_match:
        consistencies += 1
        flags.append("Evidence timestamps CONSISTENT with reported incident time")
    else:
        contradictions += 1
        flags.append(TIMESTAMP_DISCREPANCY_FLAG)

    # Determine overall status
    if contradictions == 0 and consistencies >= 2:
        status = "CONSISTENT"
        confidence_adjustment = avg_confidence_delta
        summary = (
            f"Visual evidence across {len(findings)} file(s) is consistent with the written report. "
            f"Key indicators corroborated: {', '.join(flags[:2])}."
        )
    elif contradictions >= 2:
        status = "CONTRADICTED"
        confidence_adjustment = -0.08
        summary = (
            f"Visual evidence raises concerns about the accuracy of the written report. "
            f"Discrepancies detected: {'; '.join([f for f in flags if 'NOT' in f or 'discrepancy' in f.lower()])}. "
            f"Human review required before approving this packet."
        )
    elif contradictions == 1:
        status = "PARTIAL"
        confidence_adjustment = avg_confidence_delta * 0.5
        summary = (
            f"Visual evidence partially corroborates the written report. "
            f"One discrepancy noted: {next((f for f in flags if 'NOT' in f or 'discrepancy' in f.lower()), '')}. "
            f"Underwriter should review flagged items."
        )
    else:
        status = "INCONCLUSIVE"
        confidence_adjustment = 0.0
        summary = "Insufficient visual context to draw corroboration conclusions. Standard review applies."

    return CorroborationResult(
        status=status,
        confidence_adjustment=confidence_adjustment,
        flags=flags,
        summary=summary,
    )
