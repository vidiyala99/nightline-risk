"""
Nightline Risk - Coverage Decision Engine

Determines coverage approval based on risk tier:
- A/B: Auto-approve
- C: Pending review
- D: Conditional decline
"""

from dataclasses import dataclass
from pydantic import BaseModel


class CoverageDecision(BaseModel):
    venue_id: str
    decision: str  # approved, pending_review, declined
    tier: str
    premium_quote: dict
    conditions: list[str]
    required_actions: list[str]
    improvement_plan: dict | None


class DecisionEngine:
    """Determine coverage decisions for venues."""

    # Decision rules by tier
    DECISION_RULES = {
        "A": "approved",
        "B": "approved",
        "C": "pending_review",
        "D": "declined",
    }

    # Improvement actions by tier
    IMPROVEMENT_ACTIONS = {
        "C": [
            "Complete all outstanding compliance items",
            "Respond to pending incident follow-ups within 7 days",
            "Provide additional security documentation",
        ],
        "D": [
            "Hire additional licensed security staff",
            "Address all outstanding compliance items",
            "Complete security assessment",
            "Implement incident prevention protocols",
            "Re-apply after 90 days with improvement documentation",
        ],
    }

    def __init__(self, venues: dict, pricing_engine):
        self.venues = venues
        self.pricing_engine = pricing_engine

    def make_decision(self, venue_id: str) -> CoverageDecision:
        """Make coverage decision for a venue."""
        if venue_id not in self.venues:
            raise ValueError(f"Venue not found: {venue_id}")

        venue = self.venues[venue_id]

        # Get tier from venue data
        tier = self._infer_tier(venue)

        # Get decision based on tier
        decision = self.DECISION_RULES.get(tier, "pending_review")

        # Get premium quote
        quote = self.pricing_engine.calculate_quote(venue_id)

        # Determine conditions and actions
        conditions = []
        required_actions = []

        if tier == "C":
            conditions = [
                "Underwriter review required before binding",
                "Additional documentation may be requested",
            ]
            required_actions = self.IMPROVEMENT_ACTIONS.get("C", [])
            improvement_plan = {
                "timeline": "30 days",
                "requirements": "Complete compliance items",
                "reassessment": "After improvements, re-apply for updated quote",
            }
        elif tier == "D":
            conditions = [
                "Coverage not available at this time",
                "Below minimum underwriting standards",
            ]
            required_actions = self.IMPROVEMENT_ACTIONS.get("D", [])
            improvement_plan = {
                "timeline": "90 days minimum",
                "requirements": "Hire security, resolve compliance, implement protocols",
                "reapplication": "Submit new application with documentation",
            }
        else:
            improvement_plan = None

        return CoverageDecision(
            venue_id=venue_id,
            decision=decision,
            tier=tier,
            premium_quote=quote.model_dump(),
            conditions=conditions,
            required_actions=required_actions,
            improvement_plan=improvement_plan,
        )

    def _infer_tier(self, venue: dict) -> str:
        """Infer tier from venue data."""
        incidents = venue.get("incident_count", 0)
        compliance = venue.get("compliance_items", 0)
        security = venue.get("security_level", "medium")

        if incidents <= 1 and compliance <= 0:
            return "A"
        elif incidents <= 2 and compliance <= 1:
            return "B"
        elif incidents <= 4 and compliance <= 2:
            return "C"
        else:
            return "D"


def get_coverage_decision(venue_id: str, venues: dict) -> dict:
    """Helper function to get coverage decision as dict."""
    from app.underwriting.pricing import PremiumCalculator

    pricing = PremiumCalculator(venues)
    engine = DecisionEngine(venues, pricing)
    result = engine.make_decision(venue_id)
    return result.model_dump()