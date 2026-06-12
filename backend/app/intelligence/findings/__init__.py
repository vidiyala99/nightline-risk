"""Registry mapping each judgment kind to its pure find() function."""
from app.intelligence.findings import (
    evidence_gap, compliance_overdue, renewal_approaching,
    coverage_gap_eo, coverage_exclusion_review, renewal_term_drift,
    renewal_at_risk, submission_stalled, reserve_light, fraud_unreviewed,
)

REGISTRY = {
    "evidence_gap": evidence_gap.find,
    "compliance_overdue": compliance_overdue.find,
    "renewal_approaching": renewal_approaching.find,
    "coverage_gap_eo": coverage_gap_eo.find,
    "coverage_exclusion_review": coverage_exclusion_review.find,
    "renewal_term_drift": renewal_term_drift.find,
    "renewal_at_risk": renewal_at_risk.find,
    "submission_stalled": submission_stalled.find,
    "reserve_light": reserve_light.find,
    "fraud_unreviewed": fraud_unreviewed.find,
}
