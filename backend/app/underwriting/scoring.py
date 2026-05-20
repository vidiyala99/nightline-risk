"""
Third Space Risk - Underwriting Scoring Engine

Calculates venue risk scores based on:
- Incident history (35%)
- Compliance (25%)
- Operational (25%)
- Business profile (15%)
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional


@dataclass
class RiskScoreBreakdown:
    venue_id: str
    total_score: int
    tier: str  # A, B, C, D
    factors: dict  # Breakdown by factor
    updated_at: str


class RiskScoringEngine:
    """Calculate risk scores for venues."""

    # Weights for each factor
    WEIGHTS = {
        "incident_history": 0.35,
        "compliance": 0.25,
        "operational": 0.25,
        "business_profile": 0.15,
    }

    # Tier boundaries
    TIER_THRESHOLDS = {
        "A": (80, 100),
        "B": (60, 79),
        "C": (40, 59),
        "D": (0, 39),
    }

    def __init__(self, venues: dict):
        self.venues = venues

    def calculate_score(self, venue_id: str) -> RiskScoreBreakdown:
        """Calculate total risk score for a venue."""
        if venue_id not in self.venues:
            raise ValueError(f"Venue not found: {venue_id}")

        venue = self.venues[venue_id]

        # Calculate individual factor scores (0-100)
        incident_score = self._score_incident_history(venue)
        compliance_score = self._score_compliance(venue)
        operational_score = self._score_operational(venue)
        business_score = self._score_business_profile(venue)

        # Weighted total
        total_score = int(
            incident_score * self.WEIGHTS["incident_history"]
            + compliance_score * self.WEIGHTS["compliance"]
            + operational_score * self.WEIGHTS["operational"]
            + business_score * self.WEIGHTS["business_profile"]
        )

        # Ensure bounds
        total_score = max(0, min(100, total_score))

        # Determine tier
        tier = self._get_tier(total_score)

        return RiskScoreBreakdown(
            venue_id=venue_id,
            total_score=total_score,
            tier=tier,
            factors={
                "incident_history": {"score": incident_score, "weight": self.WEIGHTS["incident_history"]},
                "compliance": {"score": compliance_score, "weight": self.WEIGHTS["compliance"]},
                "operational": {"score": operational_score, "weight": self.WEIGHTS["operational"]},
                "business_profile": {"score": business_score, "weight": self.WEIGHTS["business_profile"]},
            },
            updated_at=datetime.now().isoformat(),
        )

    def _score_incident_history(self, venue: dict) -> int:
        """
        Score based on incident history (0-100, higher is better).
        
        Factors:
        - Fewer incidents = higher score
        - More recent incidents = lower score
        - Injury/police/ems calls = lower score
        """
        incident_count = venue.get("incident_count", 0)

        # Base score: 0 incidents = 100, 10+ incidents = 0
        if incident_count == 0:
            base = 100
        elif incident_count >= 10:
            base = 0
        else:
            base = 100 - (incident_count * 10)

        return max(0, min(100, base))

    def _score_compliance(self, venue: dict) -> int:
        """
        Score based on compliance status (0-100, higher is better).
        
        Factors:
        - Outstanding compliance items = lower score
        - More items = significantly lower score
        """
        compliance_items = venue.get("compliance_items", 0)

        if compliance_items == 0:
            return 100
        elif compliance_items == 1:
            return 70
        elif compliance_items == 2:
            return 40
        elif compliance_items == 3:
            return 20
        else:  # 4+
            return 0

    def _score_operational(self, venue: dict) -> int:
        """
        Score based on operational factors (0-100, higher is better).
        
        Factors:
        - Security level (high=100, medium=70, low=40)
        """
        security = venue.get("security_level", "medium")

        security_scores = {
            "high": 100,
            "medium": 70,
            "low": 40,
        }

        return security_scores.get(security, 70)

    def _score_business_profile(self, venue: dict) -> int:
        """
        Score based on business profile (0-100, higher is better).
        
        Factors:
        - Years in operation (more = better)
        - Prior carrier (has history = better)
        - Venue type risk
        """
        years = venue.get("years_in_operation", 1)

        # Years scoring: 10+ years = 100, 1 year = 50
        if years >= 10:
            year_score = 100
        elif years >= 7:
            year_score = 85
        elif years >= 5:
            year_score = 70
        elif years >= 3:
            year_score = 60
        elif years >= 2:
            year_score = 55
        else:
            year_score = 50

        # Prior carrier bonus
        prior = venue.get("prior_carrier")
        if prior and prior != "None":
            carrier_bonus = 15
        else:
            carrier_bonus = 0

        # Venue type risk
        vtype = venue.get("venue_type", "dive_bar")
        type_risk = {
            "dive_bar": 10,
            "rooftop_bar": 5,
            "music_venue": -5,
            "latin_club": -5,
            "club": -10,
        }
        type_score = type_risk.get(vtype, 0)

        return max(0, min(100, year_score + carrier_bonus + type_score))

    def _get_tier(self, score: int) -> str:
        """Map score to tier."""
        for tier, (min_s, max_s) in self.TIER_THRESHOLDS.items():
            if min_s <= score <= max_s:
                return tier
        return "D"


class IncidentDeltaTracker:
    """Tracks incidents logged *after* the curated underwriter baseline.

    VENUES[vid]["incident_count"] represents an underwriter's curated 12-month
    claim history (per the design comment in seed_data.py). When the operator
    or a demo simulator writes a NEW incident via the API, that's a delta on
    top of the baseline — and that delta is what should move the risk score
    in real time.

    Restart resets the tracker; the curated VENUES baseline is preserved.
    This is intentional: the next quote cycle should fold the delta into the
    baseline manually, not silently extend the curated history forever.
    """

    def __init__(self) -> None:
        self._deltas: dict[str, int] = {}
        self._compliance_deltas: dict[str, int] = {}

    def bump_incident(self, venue_id: str, by: int = 1) -> int:
        self._deltas[venue_id] = self._deltas.get(venue_id, 0) + by
        return self._deltas[venue_id]

    def bump_compliance(self, venue_id: str, by: int = 1) -> int:
        self._compliance_deltas[venue_id] = self._compliance_deltas.get(venue_id, 0) + by
        return self._compliance_deltas[venue_id]

    def incident_delta(self, venue_id: str) -> int:
        return self._deltas.get(venue_id, 0)

    def compliance_delta(self, venue_id: str) -> int:
        return self._compliance_deltas.get(venue_id, 0)

    def snapshot(self, venue_id: str) -> dict[str, int]:
        return {
            "incident_delta": self.incident_delta(venue_id),
            "compliance_delta": self.compliance_delta(venue_id),
        }

    def reset(self, venue_id: str | None = None) -> None:
        if venue_id is None:
            self._deltas.clear()
            self._compliance_deltas.clear()
        else:
            self._deltas.pop(venue_id, None)
            self._compliance_deltas.pop(venue_id, None)


# Module-level singleton — used by main.py call sites and by the incident_flow
# hook that bumps the counter when a new incident is persisted.
incident_delta_tracker = IncidentDeltaTracker()


def get_risk_score(
    venue_id: str,
    venues: dict,
    session: Any | None = None,  # accepted for API symmetry; not currently read
    live_state_manager: Any | None = None,  # accepted for API symmetry; live_state's compliance_queue is the operator queue, not the underwriter view, so it's intentionally not consulted here
    delta_tracker: "IncidentDeltaTracker | None" = None,
) -> dict:
    """Compute a venue's risk score.

    Baseline (`VENUES[vid]["incident_count"]` and `compliance_items`) is the
    underwriter's curated 12-month view. New incidents and compliance items
    logged at runtime are tracked as deltas on top of that baseline via the
    module-level `incident_delta_tracker`, so the score moves in real time
    during a demo without overwriting the curated history.

    LiveStateManager.compliance_queue is intentionally NOT consulted here:
    that queue is the *operator's* active floor view (including auto-generated
    items from camera anomalies), which is a different concept from the
    underwriter's curated compliance count. Auto-generated items that should
    affect scoring must explicitly bump `delta_tracker.bump_compliance()`.
    """
    _ = (session, live_state_manager)  # accepted but unused; see docstring
    base_venue = venues.get(venue_id, {})
    tracker = delta_tracker if delta_tracker is not None else incident_delta_tracker

    overrides: dict = {}

    incident_delta = tracker.incident_delta(venue_id)
    if incident_delta > 0:
        overrides["incident_count"] = base_venue.get("incident_count", 0) + incident_delta

    compliance_delta = tracker.compliance_delta(venue_id)
    if compliance_delta > 0:
        overrides["compliance_items"] = base_venue.get("compliance_items", 0) + compliance_delta

    effective_venues = {**venues, venue_id: {**base_venue, **overrides}} if overrides else venues

    engine = RiskScoringEngine(effective_venues)
    result = engine.calculate_score(venue_id)
    return {
        "venue_id": result.venue_id,
        "total_score": result.total_score,
        "tier": result.tier,
        "factors": result.factors,
        "updated_at": result.updated_at,
        "delta": tracker.snapshot(venue_id),
    }