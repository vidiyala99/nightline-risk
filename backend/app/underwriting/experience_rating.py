"""
Credibility-weighted experience rating modifier.

Constants are versioned — bump EXPERIENCE_LOGIC_VERSION whenever any value
changes so AgentRun.contract_version records which math produced a given mod.

Decision-support only. The mod informs broker re-pricing judgment on renewals;
it is not a state-filed loss-cost modification. Every number is traceable to
its loss inputs + a versioned method via the AgentRun reproducibility spine.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Sequence

# ── Versioned constant set ────────────────────────────────────────────────
# Bump this string whenever any constant below changes. The version propagates
# into AgentRun.contract_version so the same loss data + same version always
# produces the same mod (reproducibility invariant).
EXPERIENCE_LOGIC_VERSION = "1.0"

ANNUAL_TREND_RATE = Decimal("0.05")
FULL_CREDIBILITY_CLAIMS = Decimal("82")  # frequency credibility threshold
EXPECTED_LOSS_RATIO = Decimal("0.65")    # book ELR (a priori)
MOD_FLOOR = Decimal("0.75")
MOD_CAP = Decimal("1.75")

_ONE = Decimal("1")
_ZERO = Decimal("0")
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class ExperienceYear:
    """One policy year of loss experience feeding the mod calculation."""
    years_back: int           # 0 = most recent, 1 = prior year, etc.
    incurred: Decimal         # total incurred losses (paid + reserve)
    earned_premium: Decimal   # earned premium for that year
    claim_count: int


@dataclass(frozen=True)
class ExperienceMod:
    mod: Decimal              # quantized to 0.01; enters pricing via loss_adjustment kwarg
    credibility_z: Decimal    # 0–1; surfaced in YoY renewal payload
    experience_lr: Decimal    # trended aggregate loss ratio (unweighted)
    claim_count: int
    logic_version: str


def compute_experience_mod(years: Sequence[ExperienceYear]) -> ExperienceMod:
    """
    Trended, credibility-weighted experience rating modifier.

    No history → Z=0 → mod=1.00 exactly (new-business neutral).
    Zero earned premium → experience_lr=0 → mod=1.00 (same neutral path).
    All arithmetic uses exact Decimal — no float intermediaries.
    """
    if not years:
        return ExperienceMod(
            mod=_ONE,
            credibility_z=_ZERO,
            experience_lr=_ZERO,
            claim_count=0,
            logic_version=EXPERIENCE_LOGIC_VERSION,
        )

    total_trended = _ZERO
    total_earned = _ZERO
    total_claims = 0

    for y in years:
        # Integer exponent on Decimal is exact — no float involved.
        trend_factor = (_ONE + ANNUAL_TREND_RATE) ** y.years_back
        total_trended += y.incurred * trend_factor
        total_earned += y.earned_premium
        total_claims += y.claim_count

    # Without earned premium we can't compute a meaningful loss ratio, so
    # credibility collapses to zero and the mod stays neutral — same path as
    # no history at all. Prevents claim counts from artificially driving Z up
    # and pulling the mod below 1.00 on anomalous zero-premium data.
    if not total_earned:
        return ExperienceMod(
            mod=_ONE,
            credibility_z=_ZERO,
            experience_lr=_ZERO,
            claim_count=total_claims,
            logic_version=EXPERIENCE_LOGIC_VERSION,
        )

    experience_lr = total_trended / total_earned

    # Z = min(1, sqrt(N / FULL_CREDIBILITY_CLAIMS)) via Decimal.sqrt() (exact).
    n = Decimal(str(total_claims))
    z_raw = (n / FULL_CREDIBILITY_CLAIMS).sqrt()
    z = min(_ONE, z_raw)

    credible_lr = z * experience_lr + (_ONE - z) * EXPECTED_LOSS_RATIO
    raw_mod = credible_lr / EXPECTED_LOSS_RATIO

    clamped = max(MOD_FLOOR, min(MOD_CAP, raw_mod))
    mod = clamped.quantize(_CENT, rounding=ROUND_HALF_UP)

    return ExperienceMod(
        mod=mod,
        credibility_z=z,
        experience_lr=experience_lr,
        claim_count=total_claims,
        logic_version=EXPERIENCE_LOGIC_VERSION,
    )
