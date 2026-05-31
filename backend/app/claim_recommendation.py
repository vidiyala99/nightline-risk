"""Decision-support recommender — should this incident become a filed claim?

Deterministic rule-based recommender. The carrier still makes the actual
coverage decision; this surfaces the expected-value math (payout vs premium
impact) to the broker BEFORE they file. That's the AI-native upstream
intervention the product is built around.

Kept deterministic + cheap on purpose: this runs on every packet fetch, must
never crash a response, and the rules are explainable so brokers can defend
the recommendation to the operator and (eventually) to a carrier audit.
"""

from dataclasses import dataclass, asdict
from decimal import Decimal
from typing import Optional


@dataclass(frozen=True)
class PayoutRange:
    low_usd: int
    median_usd: int
    high_usd: int


@dataclass(frozen=True)
class PremiumImpact:
    annual_delta_usd: int
    duration_years: int
    cumulative_usd: int


@dataclass(frozen=True)
class ClaimRecommendation:
    should_file: bool
    probability: float           # P(claim is paid by carrier) in [0, 1]
    expected_payout: PayoutRange
    expected_premium_impact: PremiumImpact
    net_expected_value_usd: int  # payout_median - cumulative_premium_impact
    reasons: list[str]
    confidence: float            # how confident we are in this recommendation
    rubric_version: str = "claim-recommendation-v1"
    deductible_usd: Optional[int] = None
    carrier_payout_usd: int = 0
    pay_out_of_pocket_cost_usd: int = 0


# Base payout ranges per incident type — orders of magnitude, not point estimates.
# Sourced from internal calibration on the seed corpus; will graduate to learned
# values once we have outcome data from real filed claims.
_PAYOUT_BASE: dict[str, tuple[int, int, int]] = {
    "medical_emergency":   (15_000, 35_000,  120_000),
    "altercation_event":   ( 8_000, 22_000,   75_000),
    "premises_liability":  (10_000, 28_000,   95_000),
    "liquor_liability":    (25_000, 60_000,  250_000),
    "property_damage":     ( 5_000, 18_000,   80_000),
    "crowd_management":    (12_000, 30_000,  100_000),
    "general_incident":    ( 1_500,  5_000,   20_000),
}

# Severity multipliers stack on top of the per-type base.
_SEVERITY_MULTIPLIER = {"low": 0.4, "medium": 0.8, "high": 1.4, "critical": 2.2}

# Premium delta is rough — a paid claim of $X moves annual premium by
# roughly 8-12% of $X spread over 3 years. Tuned against industry rules of thumb.
_PREMIUM_DELTA_RATE = 0.10
_PREMIUM_AMORTIZATION_YEARS = 3


def recommend_claim_filing(
    *,
    risk_signal: dict,
    incident: dict,
    venue_prior_claim_count: int = 0,
    deductible: "Decimal | None" = None,
) -> ClaimRecommendation:
    risk_type = (risk_signal.get("type") or "general_incident").lower()
    severity = (risk_signal.get("severity") or "low").lower()
    classifier_confidence = float(risk_signal.get("confidence", 0.7))

    injury = bool(incident.get("injury_observed"))
    police = bool(incident.get("police_called"))
    ems = bool(incident.get("ems_called"))

    payout = _estimate_payout(risk_type, severity)
    premium = _estimate_premium_impact(payout.median_usd)
    probability = _filing_probability(severity, injury, police, ems, risk_type)
    reasons = _build_reasons(
        risk_type=risk_type,
        severity=severity,
        injury=injury,
        police=police,
        ems=ems,
        probability=probability,
        venue_prior_claim_count=venue_prior_claim_count,
    )

    ded = int(deductible) if deductible is not None else None
    carrier_payout = payout.median_usd if ded is None else max(0, payout.median_usd - ded)
    expected_payout_value = int(carrier_payout * probability)
    net_ev = expected_payout_value - premium.cumulative_usd
    should_file = net_ev > 0 and carrier_payout > 0 and probability >= 0.45

    # Confidence in our own recommendation: bounded by the classifier's confidence,
    # reduced if there's no corroborating hard signal, boosted by hard signals.
    rec_confidence = classifier_confidence
    hard_signal_count = int(injury) + int(police) + int(ems)
    if hard_signal_count >= 2:
        rec_confidence = min(0.99, rec_confidence + 0.05)
    elif hard_signal_count == 0 and severity in ("low", "medium"):
        rec_confidence = max(0.4, rec_confidence - 0.1)

    return ClaimRecommendation(
        should_file=should_file,
        probability=round(probability, 2),
        expected_payout=payout,
        expected_premium_impact=premium,
        net_expected_value_usd=net_ev,
        reasons=reasons,
        confidence=round(rec_confidence, 2),
        deductible_usd=ded,
        carrier_payout_usd=carrier_payout,
        pay_out_of_pocket_cost_usd=payout.median_usd,
    )


def _estimate_payout(risk_type: str, severity: str) -> PayoutRange:
    base = _PAYOUT_BASE.get(risk_type, _PAYOUT_BASE["general_incident"])
    mult = _SEVERITY_MULTIPLIER.get(severity, 1.0)
    return PayoutRange(
        low_usd=int(base[0] * mult),
        median_usd=int(base[1] * mult),
        high_usd=int(base[2] * mult),
    )


def _estimate_premium_impact(payout_median: int) -> PremiumImpact:
    annual_delta = int(payout_median * _PREMIUM_DELTA_RATE / _PREMIUM_AMORTIZATION_YEARS)
    cumulative = annual_delta * _PREMIUM_AMORTIZATION_YEARS
    return PremiumImpact(
        annual_delta_usd=annual_delta,
        duration_years=_PREMIUM_AMORTIZATION_YEARS,
        cumulative_usd=cumulative,
    )


def _filing_probability(
    severity: str,
    injury: bool,
    police: bool,
    ems: bool,
    risk_type: str,
) -> float:
    base = {"low": 0.15, "medium": 0.45, "high": 0.72, "critical": 0.88}.get(severity, 0.3)
    if injury: base += 0.06
    if police: base += 0.04
    if ems:    base += 0.08
    # Medical emergencies are almost always reported even at lower severity
    if risk_type == "medical_emergency": base += 0.05
    # Liquor liability has the strongest defense cost regardless of severity
    if risk_type == "liquor_liability":  base += 0.04
    return min(0.98, base)


def _build_reasons(
    *,
    risk_type: str,
    severity: str,
    injury: bool,
    police: bool,
    ems: bool,
    probability: float,
    venue_prior_claim_count: int,
) -> list[str]:
    reasons: list[str] = []
    pretty_type = risk_type.replace("_", " ").title()
    reasons.append(f"Classified as {pretty_type} at {severity.upper()} severity")
    if ems:    reasons.append("EMS was called — coverage typically applies under duty-of-care")
    if injury: reasons.append("Injury observed — third-party liability exposure")
    if police: reasons.append("Police involvement — strengthens documentation defensibility")
    if not (injury or police or ems):
        reasons.append("No hard signals (injury / police / EMS) — claim quantum likely small")
    if risk_type == "liquor_liability":
        reasons.append("Dram-shop risk — carriers expect early notice for defense reservation")
    if probability >= 0.7:
        reasons.append(f"Historical pattern: similar incidents are filed ~{int(probability * 100)}% of the time")
    if venue_prior_claim_count >= 3:
        reasons.append(f"Venue has {venue_prior_claim_count} prior claims — additional filings may compound premium impact")
    return reasons


def recommendation_to_dict(rec: ClaimRecommendation) -> dict:
    """Stable JSON shape for API responses + frontend consumption."""
    return {
        "should_file": rec.should_file,
        "probability": rec.probability,
        "expected_payout": asdict(rec.expected_payout),
        "expected_premium_impact": asdict(rec.expected_premium_impact),
        "net_expected_value_usd": rec.net_expected_value_usd,
        "reasons": list(rec.reasons),
        "confidence": rec.confidence,
        "rubric_version": rec.rubric_version,
        "deductible": rec.deductible_usd,
        "carrier_payout": rec.carrier_payout_usd,
        "pay_out_of_pocket_cost": rec.pay_out_of_pocket_cost_usd,
    }
