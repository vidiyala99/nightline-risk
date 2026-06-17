"""
Volume-weighted chain-ladder loss development.

Computes link ratios, age-to-ultimate CDFs, and advisory ultimate loss
estimates from an accident-year × development-age triangle. Operates on a
single coverage line; callers run this once per line and aggregate.

Advisory only — never auto-sets reserves. The ultimate informs reserve-adequacy
review; carriers set reserves via services/adjusting.py:adjust_reserve.

Decision-support disclaimer must appear in API responses and UI per the spec.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Sequence

# ── Versioned constant set ────────────────────────────────────────────────
DEVELOPMENT_LOGIC_VERSION = "1.0"

# No fitted tail — non-goal per spec. Bump version if this changes.
TAIL_FACTOR = Decimal("1.00")

# Guard against divide-by-zero on very sparse triangles.
MIN_LINK_DENOMINATOR = Decimal("0.01")

# Below this claim count the triangle is not credible enough for reserve guidance.
MIN_CREDIBLE_CLAIMS = 10

_ONE = Decimal("1")
_ZERO = Decimal("0")


@dataclass(frozen=True)
class TriangleCell:
    """One cell in the incurred-loss development triangle."""
    accident_year: int
    dev_age: int       # development age in years (0 = accident year end)
    incurred: Decimal  # paid(indemnity+expense) - recovery + reserve, as of valuation


@dataclass(frozen=True)
class DevelopmentResult:
    """Chain-ladder output for one coverage line."""
    link_ratios: dict[int, Decimal]             # dev_age k → f_k (age-to-age factor)
    cdfs: dict[int, Decimal]                    # dev_age k → cumulative development factor
    ultimate_by_accident_year: dict[int, Decimal]
    ultimate_total: Decimal
    claim_count: int
    accident_year_count: int
    is_credible: bool
    caveat: str | None
    logic_version: str


def compute_chain_ladder(
    cells: Sequence[TriangleCell],
    *,
    claim_count: int = 0,
) -> DevelopmentResult:
    """
    Volume-weighted chain-ladder on the provided triangle.

    Graceful degradation:
    - 0 cells → zeros, is_credible=False.
    - 1 AY or missing age pairings → f_k=1.0 for missing pairs → ultimate==incurred.
    - claim_count < MIN_CREDIBLE_CLAIMS → is_credible=False with caveat.

    Exact Decimal arithmetic throughout.
    """
    if not cells:
        return DevelopmentResult(
            link_ratios={},
            cdfs={},
            ultimate_by_accident_year={},
            ultimate_total=_ZERO,
            claim_count=0,
            accident_year_count=0,
            is_credible=False,
            caveat="no loss data",
            logic_version=DEVELOPMENT_LOGIC_VERSION,
        )

    # Build sparse triangle: {(AY, dev_age): incurred}
    triangle: dict[tuple[int, int], Decimal] = {
        (c.accident_year, c.dev_age): c.incurred for c in cells
    }

    accident_years = sorted({ay for ay, _ in triangle})
    dev_ages = sorted({da for _, da in triangle})

    # ── Link ratios ───────────────────────────────────────────────────────
    # f_k = Σ_AY cell[AY][k+1] / Σ_AY cell[AY][k]  (volume-weighted)
    # Only AYs that have BOTH ages contribute to the ratio for that age pair.
    link_ratios: dict[int, Decimal] = {}
    consecutive = [(dev_ages[i], dev_ages[i + 1]) for i in range(len(dev_ages) - 1)]

    for age_k, age_k1 in consecutive:
        num = _ZERO
        den = _ZERO
        for ay in accident_years:
            if (ay, age_k) in triangle and (ay, age_k1) in triangle:
                num += triangle[(ay, age_k1)]
                den += triangle[(ay, age_k)]
        link_ratios[age_k] = num / den if den >= MIN_LINK_DENOMINATOR else _ONE

    # ── CDFs ──────────────────────────────────────────────────────────────
    # CDF_k = TAIL_FACTOR × Π_{j≥k} f_j   (built right-to-left)
    cdfs: dict[int, Decimal] = {}
    if dev_ages:
        max_age = dev_ages[-1]
        cdfs[max_age] = TAIL_FACTOR
        for age_k, age_k1 in reversed(consecutive):
            cdfs[age_k] = link_ratios[age_k] * cdfs[age_k1]

    # ── Ultimate per accident year ─────────────────────────────────────────
    # Use the latest observed dev age for each AY; apply its CDF.
    ultimate_by_ay: dict[int, Decimal] = {}
    for ay in accident_years:
        ay_ages = sorted(da for (a, da) in triangle if a == ay)
        if not ay_ages:
            continue
        latest_age = ay_ages[-1]
        latest_incurred = triangle[(ay, latest_age)]
        cdf = cdfs.get(latest_age, _ONE)
        ultimate_by_ay[ay] = latest_incurred * cdf

    ultimate_total = sum(ultimate_by_ay.values(), _ZERO)

    is_credible = claim_count >= MIN_CREDIBLE_CLAIMS
    caveat = (
        None if is_credible
        else (
            f"low volume ({claim_count} claims < {MIN_CREDIBLE_CLAIMS} threshold)"
            " — treat as indicative only"
        )
    )

    return DevelopmentResult(
        link_ratios=link_ratios,
        cdfs=cdfs,
        ultimate_by_accident_year=ultimate_by_ay,
        ultimate_total=ultimate_total,
        claim_count=claim_count,
        accident_year_count=len(accident_years),
        is_credible=is_credible,
        caveat=caveat,
        logic_version=DEVELOPMENT_LOGIC_VERSION,
    )
