"""Deterministic baseline for the fraud scorer. Each fixture pairs a scenario with
its expected tier; the scorer reports accuracy so thresholds can be tuned. Mirrors
comms_classifier_eval.py."""
from __future__ import annotations

from datetime import datetime, timezone

from app.agents.fraud_agent import assess_fraud

_REPORTED = datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc)
_BASE = {"occurred_at": "2026-05-01T22:00:00Z", "injury_observed": False,
         "police_called": False, "ems_called": False}

# (label, kwargs-for-assess_fraud, expected_tier)
FIXTURES: list[tuple[str, dict, str]] = [
    ("clean", dict(risk_signal={"severity": "low"}, incident=_BASE, reported_at=_REPORTED,
                   prior_claim_count=0, evidence_file_count=2), "none"),
    ("frequency+injury", dict(risk_signal={"severity": "high"},
                              incident={**_BASE, "injury_observed": True}, reported_at=_REPORTED,
                              prior_claim_count=5, evidence_file_count=2), "elevated"),
    ("late_report", dict(risk_signal={"severity": "low"},
                         incident={**_BASE, "occurred_at": "2026-05-01T00:00:00Z"},
                         reported_at=datetime(2026, 5, 10, tzinfo=timezone.utc),
                         prior_claim_count=0, evidence_file_count=1), "low"),
    ("contradicted", dict(risk_signal={"severity": "high"},
                          incident={**_BASE, "injury_observed": True}, reported_at=_REPORTED,
                          prior_claim_count=0, evidence_file_count=2,
                          corroboration_status="CONTRADICTED",
                          corroboration_flags=["Injury reported but NOT visible in uploaded evidence",
                                               "Timestamp discrepancy detected between evidence and report"]),
     "high"),
    ("partial_only", dict(risk_signal={"severity": "low"}, incident=_BASE, reported_at=_REPORTED,
                          prior_claim_count=0, evidence_file_count=2,
                          corroboration_status="PARTIAL", corroboration_flags=[]), "low"),
]


def score_fraud_scorer() -> dict:
    correct = 0
    misses: list[str] = []
    for label, kwargs, expected in FIXTURES:
        got = assess_fraud(**kwargs).tier
        if got == expected:
            correct += 1
        else:
            misses.append(f"{label}: expected {expected}, got {got}")
    return {
        "accuracy": round(correct / len(FIXTURES), 3) if FIXTURES else 1.0,
        "n": len(FIXTURES),
        "misses": misses,
    }
