"""Fraud / SIU agent — deterministic claims-fraud screen for the packet flow.

Sibling to corroboration_agent: a pure function that turns incident metadata and
(optionally) corroboration results into an explainable, scored FraudSignal. No DB
access; callers assemble the inputs. See
docs/superpowers/specs/2026-06-04-fraud-siu-agent-design.md.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone

from app.agents.corroboration_agent import INJURY_NOT_VISIBLE_FLAG, TIMESTAMP_DISCREPANCY_FLAG


def _high_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_HIGH", "0.55"))


def _elevated_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_ELEVATED", "0.30"))


def _low_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_LOW", "0.10"))


@dataclass(frozen=True)
class FraudFlag:
    code: str
    label: str
    weight: float
    detail: str


@dataclass(frozen=True)
class FraudSignal:
    score: float
    tier: str
    red_flags: list[FraudFlag]
    summary: str
    assessed_stage: str  # "v1" | "v2"

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "tier": self.tier,
            "red_flags": [asdict(f) for f in self.red_flags],
            "summary": self.summary,
            "assessed_stage": self.assessed_stage,
        }


def tier_for_score(score: float) -> str:
    if score >= _high_threshold():
        return "high"
    if score >= _elevated_threshold():
        return "elevated"
    if score >= _low_threshold():
        return "low"
    return "none"


def _parse_dt(value) -> "datetime | None":
    if value is None:
        return None
    # datetime is a subclass of date, so check datetime FIRST.
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _summarize(tier: str, flags: list, stage: str) -> str:
    if not flags:
        return "No fraud indicators detected."
    lead = {
        "high": "High fraud risk",
        "elevated": "Elevated fraud risk",
        "low": "Low fraud risk",
    }.get(tier, "Fraud indicators present")
    return f"{lead} ({stage}): " + ", ".join(f.label for f in flags) + "."


def assess_fraud(
    *,
    risk_signal: dict,
    incident: dict,
    reported_at: "datetime | date | str | None",
    policy: object = None,
    prior_claim_count: int = 0,
    evidence_file_count: int = 0,
    corroboration_status: "str | None" = None,
    corroboration_flags: "list | None" = None,
) -> FraudSignal:
    stage = "v2" if corroboration_status is not None else "v1"
    flags: list[FraudFlag] = []

    occurred = _parse_dt(incident.get("occurred_at"))
    reported = _parse_dt(reported_at)

    # Reporting-delay anomaly (graduated; higher band replaces lower)
    if occurred and reported:
        delay_days = (reported - occurred).total_seconds() / 86400
        if delay_days > 7:
            flags.append(FraudFlag("FRAUD_LATE_REPORT", "Reported long after the incident",
                                   0.25, f"Logged {delay_days:.0f} days after it occurred"))
        elif delay_days > 3:
            flags.append(FraudFlag("FRAUD_LATE_REPORT", "Reported days after the incident",
                                   0.15, f"Logged {delay_days:.0f} days after it occurred"))

    # Policy bind / expiry proximity
    if policy is not None and reported:
        eff = _parse_dt(getattr(policy, "effective_date", None))
        exp = _parse_dt(getattr(policy, "expiry_date", None))
        if eff and 0 <= (reported - eff).days < 14:
            flags.append(FraudFlag("FRAUD_NEAR_BIND", "Claim soon after policy bind",
                                   0.15, f"Reported {(reported - eff).days} days after bind"))
        if exp and 0 <= (exp - reported).days < 14:
            flags.append(FraudFlag("FRAUD_NEAR_EXPIRY", "Claim soon before policy expiry",
                                   0.10, f"Reported {(exp - reported).days} days before expiry"))

    # Claim-frequency anomaly (graduated)
    if prior_claim_count >= 5:
        flags.append(FraudFlag("FRAUD_FREQUENCY", "High prior-claim count",
                               0.25, f"{prior_claim_count} prior claims"))
    elif prior_claim_count >= 3:
        flags.append(FraudFlag("FRAUD_FREQUENCY", "Elevated prior-claim count",
                               0.15, f"{prior_claim_count} prior claims"))

    # Unverified injury
    if incident.get("injury_observed") and not incident.get("police_called") \
            and not incident.get("ems_called"):
        flags.append(FraudFlag("FRAUD_UNVERIFIED_INJURY", "Injury reported with no police or EMS",
                               0.15, "Injury claimed but neither police nor EMS were called"))

    # Evidence-dependent flags (v2 only)
    if stage == "v2":
        status = str(corroboration_status or "").upper()
        cflags = [str(f) for f in (corroboration_flags or [])]
        if status == "CONTRADICTED":
            flags.append(FraudFlag("FRAUD_EVIDENCE_CONTRADICTED", "Footage contradicts the report",
                                   0.40, "Corroboration status is CONTRADICTED"))
        elif status == "PARTIAL":
            flags.append(FraudFlag("FRAUD_EVIDENCE_PARTIAL", "Footage only partly matches the report",
                                   0.15, "Corroboration status is PARTIAL"))
        if any(INJURY_NOT_VISIBLE_FLAG in f for f in cflags):
            flags.append(FraudFlag("FRAUD_INJURY_NOT_VISIBLE", "Injury claim not visible in evidence",
                                   0.15, "Corroboration flagged an injury/evidence mismatch"))
        if any(TIMESTAMP_DISCREPANCY_FLAG in f for f in cflags):
            flags.append(FraudFlag("FRAUD_TIMESTAMP_MISMATCH", "Evidence timestamps do not match",
                                   0.15, "Corroboration flagged a timestamp discrepancy"))
        # NOT corroboration-derived: reads risk_signal severity + evidence_file_count;
        # gated to v2 only because that's when evidence is expected.
        if str(risk_signal.get("severity", "")).lower() == "high" and evidence_file_count == 0:
            flags.append(FraudFlag("FRAUD_NO_EVIDENCE", "High-severity claim with no evidence",
                                   0.20, "No evidence files were provided for a high-severity claim"))

    score = min(1.0, round(sum(f.weight for f in flags), 3))
    tier = tier_for_score(score)
    return FraudSignal(score=score, tier=tier, red_flags=flags,
                       summary=_summarize(tier, flags, stage), assessed_stage=stage)
