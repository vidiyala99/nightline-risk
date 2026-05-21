"""
Third Space Risk - Premium Calculator

Calculates premium quotes based on venue type and risk tier.
Supports both annual and monthly billing options.

Internal arithmetic uses `Decimal` (via `app.money`) for exact cent
precision. The legacy `PremiumQuote` Pydantic model returns floats so
existing callers (eval scorers, dashboard, /api/venues/{id}/quote)
keep their wire shape unchanged. The single Decimal→float boundary
cast is `cast_money_to_float` in `app.money`.

The characterization tests in `tests/test_pricing_decimal_refactor.py`
lock the legacy output values to the cent and must pass on every
commit that touches this file.
"""
from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel

from app.money import cast_money_to_float, pct, usd


class PremiumQuote(BaseModel):
    # Float types preserved for backwards compat with the eval scorers
    # and frontend JSON serializers. Internal math is Decimal; values
    # below are post-boundary-cast.
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

    # Base premium rates by venue type — market standard rates (annual).
    # Single source of truth: read by both the legacy quote path and (in
    # Phase 1.7) the new `build_quote_for_carrier` broker-path function.
    BASE_RATES: dict[str, Decimal] = {
        "dive_bar": Decimal("6000"),
        "rooftop_bar": Decimal("8000"),
        "music_venue": Decimal("12000"),
        "music venue and bar": Decimal("12000"),
        "outdoor music venue": Decimal("15000"),
        "nightclub and performance space": Decimal("16000"),
        "outdoor bar and music venue": Decimal("11000"),
        "diy music venue and bar": Decimal("10000"),
        "latin_club": Decimal("11000"),
        "club": Decimal("15000"),
    }

    # Tier multipliers. Tier B = 1.0x (market rate); A = 0.7x discount;
    # C/D progressively penalize the risk-adjusted price.
    TIER_MULTIPLIERS: dict[str, Decimal] = {
        "A": Decimal("0.7"),
        "B": Decimal("1.0"),
        "C": Decimal("1.5"),
        "D": Decimal("2.5"),   # D tier often declined, but option exists
    }

    # Monthly processing fee (3%) applied to monthly_premium math:
    # monthly = (annual / 12) * MONTHLY_FEE
    MONTHLY_FEE: Decimal = Decimal("1.03")

    # Fallback base rate when venue_type is unknown. Decimal-typed so the
    # `.get(...)` fallback chain stays in Decimal land.
    _FALLBACK_BASE_RATE: Decimal = Decimal("6000")

    def __init__(self, venues: dict):
        self.venues = venues

    # ─── Public API (unchanged wire shape) ────────────────────────────

    def calculate_quote(
        self,
        venue_id: str,
        billing: str = "annual",
        tier_override: str | None = None,
    ) -> PremiumQuote:
        """Calculate premium quote for a venue.

        Internal arithmetic uses Decimal for exact cent precision. The
        returned `PremiumQuote` carries floats so existing consumers
        (eval scorers, dashboard, JSON serializers) keep working.
        """
        if venue_id not in self.venues:
            raise ValueError(f"Venue not found: {venue_id}")

        venue = self.venues[venue_id]
        venue_type = venue.get("venue_type", "dive_bar")
        tier = tier_override or self._get_tier_for_venue(venue_id)

        base_rate_d = self._base_rate_for(venue_type)
        market_d = self._market_rate(base_rate_d)
        annual_d = self._annual_premium(base_rate_d, tier)
        monthly_d = self._monthly_premium(annual_d)
        savings_d = self._savings_annual(market_d, annual_d)
        savings_pct_d = self._savings_pct(savings_d, market_d)

        # Cast at the boundary. Every field uses the dedicated cast so
        # the IEEE-754 representation matches the legacy `round(x, 2)`
        # display format. See app/money.py:cast_money_to_float.
        annual_premium = cast_money_to_float(annual_d)
        monthly_premium = cast_money_to_float(monthly_d)
        market_rate_annual = cast_money_to_float(market_d)
        savings_annual = cast_money_to_float(savings_d)
        # savings_pct uses 1dp precision per legacy contract; cast directly
        # to float (no usd() quantization which would force 2dp).
        savings_pct_float = float(savings_pct_d)

        return PremiumQuote(
            venue_id=venue_id,
            venue_type=venue_type,
            tier=tier,
            base_rate=cast_money_to_float(base_rate_d),
            annual_premium=annual_premium,
            monthly_premium=monthly_premium,
            market_rate_annual=market_rate_annual,
            savings_annual=savings_annual,
            savings_pct=savings_pct_float,
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

    # ─── Private Decimal helpers ──────────────────────────────────────
    # Pure functions over Decimal. The legacy `calculate_quote` above is
    # a thin assembler; future broker-path quote builders (Phase 1.7)
    # will reuse these directly. Single source of truth for each
    # arithmetic step.

    def _base_rate_for(self, venue_type: str) -> Decimal:
        """Lookup base rate for a venue type, with two-step fallback to
        match legacy behavior: case-insensitive first, then case-sensitive,
        then a final fallback. Returns Decimal."""
        return self.BASE_RATES.get(
            venue_type.lower(),
            self.BASE_RATES.get(venue_type, self._FALLBACK_BASE_RATE),
        )

    def _market_rate(self, base_rate: Decimal) -> Decimal:
        """Market rate = what a comparable venue pays without Third Space
        intelligence (Tier B = 1.0x). Cent-quantized."""
        return usd(base_rate * self.TIER_MULTIPLIERS["B"])

    def _annual_premium(self, base_rate: Decimal, tier: str) -> Decimal:
        """Third Space rate = risk-adjusted with our intelligence. Cent-quantized.
        Unknown tier falls back to 1.0x (matching legacy `.get(tier, 1.0)`)."""
        multiplier = self.TIER_MULTIPLIERS.get(tier, Decimal("1.0"))
        return usd(base_rate * multiplier)

    def _monthly_premium(self, annual_premium: Decimal) -> Decimal:
        """Monthly = (annual / 12) * 1.03 monthly-fee. Cent-quantized.
        Note: Decimal division is exact when divisor is a power of 10
        and the dividend has a finite decimal expansion; for /12 the
        result may have many digits, which usd()'s quantize handles."""
        return usd((annual_premium / Decimal("12")) * self.MONTHLY_FEE)

    def _savings_annual(self, market: Decimal, annual: Decimal) -> Decimal:
        """Signed: positive when Third Space saves the venue money,
        negative for tiers worse than B. Cent-quantized."""
        return usd(market - annual)

    def _savings_pct(self, savings: Decimal, market: Decimal) -> Decimal:
        """Percentage rounded to 1dp (matches legacy savings_pct contract).
        Returns Decimal('0.0') on market==0 (legacy guard preserved)."""
        return pct(savings, market, places=1)

    # ─── Tier inference (unchanged from legacy) ───────────────────────

    def _get_tier_for_venue(self, venue_id: str) -> str:
        """Get tier from venue data - used for demo without running scoring."""
        venue = self.venues[venue_id]
        incidents = venue.get("incident_count", 0)
        compliance = venue.get("compliance_items", 0)
        # 'security' read for completeness; not currently used in tier inference.
        _ = venue.get("security_level", "medium")

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
