"""
Third Space Risk - Premium Calculator

Calculates premium quotes based on venue type and risk tier.
Supports both annual and monthly billing options.
"""

from dataclasses import dataclass
from pydantic import BaseModel


class PremiumQuote(BaseModel):
    venue_id: str
    venue_type: str
    tier: str
    base_rate: float
    annual_premium: float
    monthly_premium: float
    market_rate_annual: float
    savings_annual: float
    savings_pct: float
    renewal_date: str
    billing_options: dict
    coverage_breakdown: dict


class PremiumCalculator:
    """Calculate premium quotes for venues."""

    # Base premium rates by venue type — market standard rates (annual)
    BASE_RATES = {
        "dive_bar": 6000,
        "rooftop_bar": 8000,
        "music_venue": 12000,
        "music venue and bar": 12000,
        "outdoor music venue": 15000,
        "nightclub and performance space": 16000,
        "outdoor bar and music venue": 11000,
        "diy music venue and bar": 10000,
        "latin_club": 11000,
        "club": 15000,
    }

    # Tier multipliers
    TIER_MULTIPLIERS = {
        "A": 0.7,
        "B": 1.0,
        "C": 1.5,
        "D": 2.5,  # D tier often declined, but option exists
    }

    # Monthly processing fee (3%)
    MONTHLY_FEE = 1.03

    def __init__(self, venues: dict):
        self.venues = venues

    def calculate_quote(self, venue_id: str, billing: str = "annual", tier_override: str | None = None) -> PremiumQuote:
        """Calculate premium quote for a venue."""
        if venue_id not in self.venues:
            raise ValueError(f"Venue not found: {venue_id}")

        venue = self.venues[venue_id]
        venue_type = venue.get("venue_type", "dive_bar")
        tier = tier_override or self._get_tier_for_venue(venue_id)

        # Get base rate — this is the market standard rate (Tier B, no intelligence discount)
        base_rate = self.BASE_RATES.get(venue_type.lower(), self.BASE_RATES.get(venue_type, 6000))

        # Market rate = what a comparable venue pays without Third Space (Tier B = 1.0x)
        market_rate_annual = round(base_rate * self.TIER_MULTIPLIERS["B"], 2)

        # Third Space rate = risk-adjusted with our intelligence
        multiplier = self.TIER_MULTIPLIERS.get(tier, 1.0)
        annual_premium = round(base_rate * multiplier, 2)
        monthly_premium = round((annual_premium / 12) * self.MONTHLY_FEE, 2)

        savings_annual = round(market_rate_annual - annual_premium, 2)
        savings_pct = round((savings_annual / market_rate_annual) * 100, 1) if market_rate_annual > 0 else 0.0

        return PremiumQuote(
            venue_id=venue_id,
            venue_type=venue_type,
            tier=tier,
            base_rate=base_rate,
            annual_premium=annual_premium,
            monthly_premium=monthly_premium,
            market_rate_annual=market_rate_annual,
            savings_annual=savings_annual,
            savings_pct=savings_pct,
            renewal_date=venue.get("renewal_date", ""),
            billing_options={
                "annual": {
                    "amount": annual_premium,
                    "description": "Paid annually",
                },
                "monthly": {
                    "amount": monthly_premium,
                    "description": "Paid monthly with 3% processing fee",
                },
            },
            coverage_breakdown={
                "liquor_liability": {
                    "included": True,
                    "description": "Required coverage",
                },
                "general_liability": {
                    "included": True,
                    "description": "Standard $1M coverage",
                },
                "property": {
                    "optional": True,
                    "description": "Available as add-on",
                },
                "workers_comp": {
                    "optional": True,
                    "description": "Available as add-on",
                },
            },
        )

    def _get_tier_for_venue(self, venue_id: str) -> str:
        """Get tier from venue data - used for demo without running scoring."""
        venue = self.venues[venue_id]
        
        # Infer tier from venue properties if no scoring run yet
        incidents = venue.get("incident_count", 0)
        compliance = venue.get("compliance_items", 0)
        security = venue.get("security_level", "medium")

        # Simple tier inference for demo
        if incidents <= 1 and compliance <= 0:
            return "A"
        elif incidents <= 2 and compliance <= 1:
            return "B"
        elif incidents <= 4 and compliance <= 2:
            return "C"
        else:
            return "D"


def get_premium_quote(
    venue_id: str,
    venues: dict,
    billing: str = "annual",
    session=None,
    live_state_manager=None,
) -> dict:
    """Helper function to get premium quote as dict, using actual risk score tier.

    Passes session/live_state_manager through so the risk score (and therefore
    the quote tier) reflects live incident + compliance data when available.
    """
    from app.underwriting.scoring import get_risk_score
    risk = get_risk_score(venue_id, venues, session=session, live_state_manager=live_state_manager)
    calculator = PremiumCalculator(venues)
    result = calculator.calculate_quote(venue_id, billing, tier_override=risk["tier"])
    return result.model_dump()