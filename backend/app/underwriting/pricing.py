"""
Nightline Risk - Premium Calculator

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

The broker-path quote engine (`build_quote_for_carrier`) lives in this
same file rather than a parallel pricing_v2 module — see the
broker-platform plan's "Architectural decision" note. Single source of
truth for rate tables, single module to grep.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel

from app.money import cast_money_to_float, pct, usd, usd_to_json


# ─── Constants used by both legacy and broker paths ──────────────────────

# NY excess-line premium tax: 3.6% per NY Insurance Law §2118 / NY DFS.
# Per-state constant pending the StateTaxRule table that arrives when the
# brokerage expands beyond NY. Applied to E&S quotes only (admitted carriers
# are exempt). The ELANY stamping fee is a SEPARATE charge and lives in
# app/underwriting/surplus_lines.py — it is not part of the insured quote.
NY_SURPLUS_LINES_TAX: Decimal = Decimal("0.036")

# Default policy fee — flat fee per quote. Per-carrier overrides allowed
# via CARRIER_RATES[carrier_id]["policy_fee"].
DEFAULT_POLICY_FEE: Decimal = Decimal("150")

# Default commission rate. 12% on new business is standard for nightlife
# E&S programs; per-carrier overrides allowed in CARRIER_RATES.
DEFAULT_COMMISSION_RATE: Decimal = Decimal("0.12")


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
        """Market rate = what a comparable venue pays without Nightline
        intelligence (Tier B = 1.0x). Cent-quantized."""
        return usd(base_rate * self.TIER_MULTIPLIERS["B"])

    def _annual_premium(self, base_rate: Decimal, tier: str) -> Decimal:
        """Nightline rate = risk-adjusted with our intelligence. Cent-quantized.
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
        """Signed: positive when Nightline saves the venue money,
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


# ═════════════════════════════════════════════════════════════════════════
# Broker-path quote engine — per-carrier, per-coverage-line, Decimal end-to-end
# ═════════════════════════════════════════════════════════════════════════
#
# The legacy path above (PremiumCalculator) emits a single number rolled up
# across coverage lines, intended for the dashboard's "what would this venue
# pay" indicator. The broker path below is what's used during real
# placement: each carrier produces its own quote with per-line breakdown,
# per-carrier multipliers on top of the shared BASE_RATES, surplus lines
# tax for E&S, and explicit commission accounting.

# Per-carrier rate adjustments. Shape:
#   {carrier_id: {
#       "venue_multipliers": {venue_type: Decimal, "_default": Decimal},
#       "line_multipliers":  {coverage_line_id: Decimal, "_default": Decimal},
#       "policy_fee":        Decimal | None,   # override DEFAULT_POLICY_FEE
#       "commission_rate":   Decimal | None,   # override DEFAULT_COMMISSION_RATE
#   }}
#
# Multipliers stack with TIER_MULTIPLIERS:
#   line_premium = BASE_RATES[venue_type]
#                  * venue_multipliers[venue_type]
#                  * line_multipliers[line_id]
#                  * TIER_MULTIPLIERS[tier]
#                  * loss_adjustment
#
# Numbers reflect typical underwriting flavor — Markel is competitive on
# music venues, Brit is aggressive on clubs but expensive on liquor, etc.
# Real production rate tables would be fine-grained per program year and
# negotiated. Seed data is "plausibly real" not "actually filed".

CARRIER_RATES: dict[str, dict] = {
    "markel-specialty": {
        "venue_multipliers": {
            "music_venue": Decimal("1.00"),
            "music venue and bar": Decimal("1.00"),
            "dive_bar": Decimal("0.95"),
            "rooftop_bar": Decimal("1.05"),
            "_default": Decimal("1.10"),
        },
        "line_multipliers": {
            "gl": Decimal("1.00"),
            "liquor": Decimal("1.10"),
            "epli": Decimal("0.95"),
            "property": Decimal("1.00"),
            "_default": Decimal("1.00"),
        },
        "policy_fee": Decimal("150"),
        "commission_rate": Decimal("0.15"),
    },
    "brit-syndicate": {
        "venue_multipliers": {
            "club": Decimal("1.00"),
            "nightclub and performance space": Decimal("1.05"),
            "latin_club": Decimal("1.10"),
            "outdoor music venue": Decimal("1.15"),
            "_default": Decimal("1.25"),
        },
        "line_multipliers": {
            "gl": Decimal("1.05"),
            "liquor": Decimal("1.20"),       # E&S premium for liquor exposure
            "assault_battery": Decimal("0.90"),  # specialty — they want this risk
            "umbrella": Decimal("1.10"),
            "_default": Decimal("1.10"),
        },
        "policy_fee": Decimal("250"),
        "commission_rate": Decimal("0.12"),
    },
    "atrium-syndicate": {
        "venue_multipliers": {
            "music_venue": Decimal("1.05"),
            "nightclub and performance space": Decimal("1.00"),
            "club": Decimal("1.00"),
            "_default": Decimal("1.20"),
        },
        "line_multipliers": {
            "gl": Decimal("1.00"),
            "liquor": Decimal("1.15"),
            "assault_battery": Decimal("0.85"),  # heavily competes on A&B
            "_default": Decimal("1.05"),
        },
        "policy_fee": Decimal("200"),
        "commission_rate": Decimal("0.13"),
    },
    "burns-wilcox": {
        # Catch-all wholesaler — writes everything, prices like it.
        "venue_multipliers": {"_default": Decimal("1.15")},
        "line_multipliers": {"_default": Decimal("1.10")},
        "policy_fee": Decimal("200"),
        "commission_rate": Decimal("0.10"),  # wholesalers pay less
    },
    "rt-specialty": {
        "venue_multipliers": {
            "music_venue": Decimal("0.95"),         # they want music-venue business
            "music venue and bar": Decimal("0.95"),
            "rooftop_bar": Decimal("1.00"),
            "diy music venue and bar": Decimal("1.05"),
            "_default": Decimal("1.20"),
        },
        "line_multipliers": {
            "gl": Decimal("0.95"),
            "liquor": Decimal("1.05"),
            "epli": Decimal("0.90"),
            "cyber": Decimal("0.85"),
            "_default": Decimal("1.05"),
        },
        "policy_fee": Decimal("175"),
        "commission_rate": Decimal("0.11"),
    },
    "nautilus": {
        # Property-only carrier — line_multiplier for everything except
        # 'property' is set high so the function would never produce a
        # competitive quote for non-property lines.
        "venue_multipliers": {"_default": Decimal("1.00")},
        "line_multipliers": {
            "property": Decimal("0.95"),
            "_default": Decimal("2.50"),
        },
        "policy_fee": Decimal("100"),
        "commission_rate": Decimal("0.15"),
    },
}

# Fallback for carriers not in CARRIER_RATES. Identity multipliers; default
# fee + commission.
_DEFAULT_CARRIER_RATES: dict = {
    "venue_multipliers": {"_default": Decimal("1.00")},
    "line_multipliers":  {"_default": Decimal("1.00")},
    "policy_fee":        DEFAULT_POLICY_FEE,
    "commission_rate":   DEFAULT_COMMISSION_RATE,
}


def carrier_rate_table(carrier_id: str) -> dict:
    """Return the per-carrier rate adjustments dict. Falls back to identity
    multipliers if the carrier_id isn't in CARRIER_RATES."""
    return CARRIER_RATES.get(carrier_id, _DEFAULT_CARRIER_RATES)


@dataclass(frozen=True)
class LineQuote:
    """A single coverage line within a carrier's quote.

    base_premium      = BASE_RATES[venue_type] * carrier venue_multiplier
    tier_multiplier   = TIER_MULTIPLIERS[tier]
    loss_adjustment   = uplift from historical loss data (1.0 in Phase 1 —
                        hook for Phase 6 LossRun integration)
    premium           = base_premium * tier_multiplier
                        * carrier line_multiplier * loss_adjustment
    """
    line: str
    base_premium: Decimal
    tier_multiplier: Decimal
    line_multiplier: Decimal
    loss_adjustment: Decimal
    premium: Decimal
    per_occurrence_limit: Decimal
    aggregate_limit: Optional[Decimal]
    deductible: Decimal
    sublimits: dict = field(default_factory=dict)


@dataclass(frozen=True)
class FullQuote:
    """A complete carrier quote: per-line breakdown + fees + tax + commission.

    The shape mirrors what `CarrierQuote.premium_breakdown` stores (JSON,
    money as strings). `to_breakdown_dict()` produces the JSON-ready shape;
    `to_json_dict()` returns string-serialized money for direct storage."""
    carrier_id: str
    venue_id: str
    tier: str
    market_type: str
    lines: list[LineQuote]
    subtotal: Decimal           # sum of line premiums
    policy_fee: Decimal
    surplus_lines_tax: Decimal  # 0 for admitted carriers
    total_premium: Decimal      # subtotal + policy_fee + surplus_lines_tax
    commission_rate: Decimal
    commission_amount: Decimal  # commission_rate * (subtotal + policy_fee)

    def to_json_dict(self) -> dict:
        """Convert to the dict shape CarrierQuote.premium_breakdown expects
        (money as STRINGS for safe JSON storage)."""
        return {
            "carrier_id": self.carrier_id,
            "venue_id": self.venue_id,
            "tier": self.tier,
            "market_type": self.market_type,
            "lines": {
                lq.line: {
                    "base": usd_to_json(lq.base_premium),
                    "tier_multiplier": str(lq.tier_multiplier),
                    "line_multiplier": str(lq.line_multiplier),
                    "loss_adjustment": str(lq.loss_adjustment),
                    "premium": usd_to_json(lq.premium),
                    "per_occurrence_limit": usd_to_json(lq.per_occurrence_limit),
                    "aggregate_limit": (
                        usd_to_json(lq.aggregate_limit) if lq.aggregate_limit is not None else None
                    ),
                    "deductible": usd_to_json(lq.deductible),
                }
                for lq in self.lines
            },
            "fees": {
                "policy_fee": usd_to_json(self.policy_fee),
                "surplus_lines_tax": usd_to_json(self.surplus_lines_tax),
            },
            "subtotal": usd_to_json(self.subtotal),
            "total": usd_to_json(self.total_premium),
            "commission_rate": str(self.commission_rate),
            "commission_amount": usd_to_json(self.commission_amount),
        }


def _lookup_multiplier(table: dict, key: str) -> Decimal:
    """Read a per-carrier multiplier with `_default` fallback. Used for both
    venue_multipliers and line_multipliers — same pattern, distinct tables."""
    if key in table:
        return table[key]
    return table.get("_default", Decimal("1.0"))


def _carrier_multipliers_for(
    rates: dict, venue_type: str, line_id: str
) -> tuple[Decimal, Decimal]:
    """Look up the (venue_multiplier, line_multiplier) pair for a given
    carrier rate table. Pulls from `_default` when the specific key isn't
    listed. Returns Decimals so the multiplication chain stays in Decimal."""
    vm = _lookup_multiplier(rates.get("venue_multipliers", {}), venue_type)
    lm = _lookup_multiplier(rates.get("line_multipliers", {}), line_id)
    return (vm, lm)


def _loss_adjustment_from_risk(risk_score: Optional[dict]) -> Decimal:
    """Compute a frequency/severity uplift from the risk score.

    Phase 1 model: identity (1.0) unless the score is low enough to signal
    aggregate trouble beyond what the tier already captures. The hook is
    here so Phase 6 (Loss Runs) can replace this with claim-history math
    without touching call sites.

    Returns 1.00 by default. For scores < 40 (already Tier D), adds another
    10% to express that the tier multiplier on its own under-prices the
    risk."""
    if risk_score is None:
        return Decimal("1.00")
    score = risk_score.get("total_score")
    if isinstance(score, (int, float)) and score < 40:
        return Decimal("1.10")
    return Decimal("1.00")


def loss_adjustment_from_loss_ratio(loss_ratio: Decimal) -> Decimal:
    """Map a prior-term loss ratio (incurred / earned premium) to the
    renewal loss_adjustment multiplier. Bands per the Phase 4 spec:
      <0.40 -> 0.90 (credit), 0.40-0.70 -> 1.00, 0.70-1.00 -> 1.25, >=1.00 -> 1.60.
    Pure: no DB, no I/O - the renewals service computes the ratio and calls this."""
    if loss_ratio < Decimal("0.40"):
        return Decimal("0.90")
    if loss_ratio < Decimal("0.70"):
        return Decimal("1.00")
    if loss_ratio < Decimal("1.00"):
        return Decimal("1.25")
    return Decimal("1.60")


def build_quote_for_carrier(
    *,
    venue: dict,
    coverage_lines: list[str],
    carrier_id: str,
    market_type: str,
    risk_score: dict,
    loss_run: Optional[object] = None,     # placeholder; LossRun arrives Phase 6
    requested_limits: dict,
    loss_adjustment: Optional[Decimal] = None,
) -> FullQuote:
    """Build a quote that *this carrier* would actually produce.

    Each carrier has its own appetite + multiplier on top of the shared
    BASE_RATES — Markel is 1.00x for music venues, Brit is 1.25x. The
    quote is per-line; subtotal sums them. Surplus lines tax (3.6% in
    NY) applies to E&S carriers only.

    Inputs:
      venue           dict like seed_data.VENUES[id] — needs "venue_type"
                      and "id" keys.
      coverage_lines  ordered list of CoverageLine.id values to quote.
      carrier_id      Carrier.id — looked up in CARRIER_RATES.
      market_type     "admitted" | "e&s" — controls surplus_lines_tax.
      risk_score      output of get_risk_score(); used for tier + loss_adj.
      loss_run        Phase 6 hook; currently ignored.
      requested_limits Per-line {"per_occurrence": str, "aggregate": str,
                       "deductible": str} from the Submission. Defaults to
                       CoverageLine defaults if absent.
    """
    venue_id = venue.get("id", "")
    venue_type = venue.get("venue_type", "")
    tier = risk_score.get("tier", "B")

    base_rate = PremiumCalculator.BASE_RATES.get(
        venue_type.lower(),
        PremiumCalculator.BASE_RATES.get(venue_type, PremiumCalculator._FALLBACK_BASE_RATE),
    )
    tier_mult = PremiumCalculator.TIER_MULTIPLIERS.get(tier, Decimal("1.0"))
    # Renewal path passes an experience-based override; new business passes
    # None and falls back to the risk-score heuristic (unchanged behavior -
    # this is what keeps the pricing characterization tests green).
    loss_adj = (
        loss_adjustment
        if loss_adjustment is not None
        else _loss_adjustment_from_risk(risk_score)
    )
    rates = carrier_rate_table(carrier_id)

    line_quotes: list[LineQuote] = []
    for line_id in coverage_lines:
        venue_mult, line_mult = _carrier_multipliers_for(rates, venue_type, line_id)
        carrier_base = usd(base_rate * venue_mult)
        line_premium = usd(carrier_base * tier_mult * line_mult * loss_adj)

        line_limits = (requested_limits or {}).get(line_id, {})
        per_occ = Decimal(line_limits.get("per_occurrence", "1000000"))
        # Default aggregate to $2M when the key is MISSING (standard
        # liability terms). An explicit None means "no aggregate concept"
        # (e.g., property, which is replacement-value per occurrence).
        if "aggregate" in line_limits:
            agg_raw = line_limits["aggregate"]
            agg = Decimal(agg_raw) if agg_raw is not None else None
        else:
            agg = Decimal("2000000")
        ded = Decimal(line_limits.get("deductible", "2500"))

        line_quotes.append(LineQuote(
            line=line_id,
            base_premium=carrier_base,
            tier_multiplier=tier_mult,
            line_multiplier=line_mult,
            loss_adjustment=loss_adj,
            premium=line_premium,
            per_occurrence_limit=per_occ,
            aggregate_limit=agg,
            deductible=ded,
        ))

    subtotal = usd(sum((lq.premium for lq in line_quotes), Decimal("0.00")))
    policy_fee = rates.get("policy_fee", DEFAULT_POLICY_FEE)
    pre_tax_total = subtotal + policy_fee

    # Surplus lines tax: E&S only. Applied to subtotal + policy_fee (NY
    # rule — taxes the gross premium incl. policy fees but excl. itself).
    if market_type == "e&s":
        surplus_tax = usd(pre_tax_total * NY_SURPLUS_LINES_TAX)
    else:
        surplus_tax = Decimal("0.00")

    total = usd(pre_tax_total + surplus_tax)

    # Commission paid on pre-tax premium (the standard convention; taxes
    # pass through to the state, not commissionable).
    commission_rate = rates.get("commission_rate", DEFAULT_COMMISSION_RATE)
    commission_amount = usd(pre_tax_total * commission_rate)

    return FullQuote(
        carrier_id=carrier_id,
        venue_id=venue_id,
        tier=tier,
        market_type=market_type,
        lines=line_quotes,
        subtotal=subtotal,
        policy_fee=policy_fee,
        surplus_lines_tax=surplus_tax,
        total_premium=total,
        commission_rate=commission_rate,
        commission_amount=commission_amount,
    )
