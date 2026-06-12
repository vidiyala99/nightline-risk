"""Correction flywheel — turn human overrides of AI suggestions into labeled
eval scenarios so the gold set grows from production and baselines re-gate
against real disagreements. This is the line between "product with AI features"
(corrections evaporate) and "AI-native product" (it learns and proves it).

Stage 2 — the pure transform. Stages 1 (capture overrides at the carrier desk)
and 3 (collect → append to the gold set → re-gate) wire around this core.

The emitted scenario matches the `UNDERWRITING_SCENARIOS` shape exactly, so the
existing scorer/runner consumes prod-derived scenarios with no changes.
"""
from __future__ import annotations

from typing import Optional


def override_to_scenario(
    *,
    inputs: dict,
    recommended_posture: str,
    recommended_rate_adequacy: str,
    human_posture: str,
    human_rate_adequacy: Optional[str] = None,
    scenario_id: str,
    lineage: Optional[str] = None,
) -> Optional[dict]:
    """A human override of the underwriting recommendation → a labeled scenario.

    `inputs` is the RecommenderInputs kwargs that were scored (money as strings).
    The label is the HUMAN's decision (the correction signal), never the AI's.
    Returns None when the human agreed with the AI — no correction to learn from.
    `lineage` is the recommendation's provenance `input_hash`, kept in `why` so a
    scenario traces back to the exact prod decision it came from.
    """
    rate = human_rate_adequacy or recommended_rate_adequacy
    if human_posture == recommended_posture and rate == recommended_rate_adequacy:
        return None

    why = (
        f"Prod override: underwriter chose {human_posture}/{rate} over "
        f"recommended {recommended_posture}/{recommended_rate_adequacy}"
    )
    if lineage:
        why += f" (lineage {lineage})"
    why += "."

    return {
        "id": scenario_id,
        "inputs": inputs,
        "expected_posture": human_posture,
        "expected_rate_adequacy": rate,
        "why": why,
    }
