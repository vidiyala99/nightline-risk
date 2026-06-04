"""New York excess & surplus lines (E&S) rates and rules.

The arithmetic is trivial; the value is encoding the *verified* NY figures and
the diligent-search rule in one place. Sources (verified 2026-06-04):
  - Premium tax 3.6%  — NY Insurance Law §2118 / NY DFS.
  - ELANY stamping 0.15% — policies incepting on/after 2023-01-01.
  - 3 declinations from authorized insurers — §2118; Export List (Reg 41,
    11 NYCRR §27.3(g)) exempts listed coverages.

The tax constant is shared with the quote engine (single source of truth);
the stamping fee lives ONLY here because it is the broker's regulatory
remittance, not part of the insured-facing quote.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import usd
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX

NY_STAMPING_FEE: Decimal = Decimal("0.0015")
REQUIRED_DECLINATIONS: int = 3


@dataclass(frozen=True)
class StateRates:
    tax: Decimal
    stamping: Decimal


# Extension seam: promote to a StateTaxRule table when the brokerage leaves NY.
STATE_RATES: dict[str, StateRates] = {
    "NY": StateRates(tax=NY_SURPLUS_LINES_TAX, stamping=NY_STAMPING_FEE),
}


@dataclass(frozen=True)
class SurplusLinesCharges:
    tax: Decimal
    stamping_fee: Decimal
    total_charges: Decimal


def compute_sl_charges(taxable_premium: Decimal, *, state: str = "NY") -> SurplusLinesCharges:
    """Compute SL tax + stamping fee on the taxable base (= subtotal + policy_fee).

    Not annual_premium — that already includes the tax."""
    rates = STATE_RATES.get(state)
    if rates is None:
        raise ValueError(f"No surplus-lines rates configured for state {state!r}")
    tax = usd(taxable_premium * rates.tax)
    stamping = usd(taxable_premium * rates.stamping)
    return SurplusLinesCharges(tax=tax, stamping_fee=stamping, total_charges=tax + stamping)


def diligent_search_complete(declination_count: int, *, export_list_exempt: bool) -> bool:
    """NY §2118: 3 declinations from authorized insurers, unless the coverage is
    on the Export List."""
    return export_list_exempt or declination_count >= REQUIRED_DECLINATIONS
