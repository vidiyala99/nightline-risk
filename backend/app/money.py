"""Decimal money helpers.

Money arithmetic in this codebase uses `Decimal`, never `float`. The pricing
refactor in Phase 1 of the broker-platform plan (docs/superpowers/specs/...)
moves all dollar math to Decimal internally; legacy float returns are cast
at the boundary only.

Two precision contexts, intentionally:
  - `usd()` quantizes to cents (0.01). For premiums, commissions, reserves.
  - `pct(...)` quantizes percentages to a configurable place (default 1).
    Mirrors the legacy `savings_pct` field which rounds to one decimal — a
    frontend-visible regression if we silently switch to 2 decimals.

JSON columns store money as STRINGS via `usd_to_json` / `json_to_usd`. JSON's
native number type is a float; round-tripping through it loses Decimal
precision. The helpers force everything through string form so the integrity
boundary is explicit.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_EVEN

USD_QUANT = Decimal("0.01")


def usd(value: Decimal | float | int | str) -> Decimal:
    """Quantize an amount to cents using banker's rounding (ROUND_HALF_EVEN).

    Banker's rounding matches Python's built-in `round()` default behavior,
    so the legacy pricing code's `round(x, 2)` produces values identical
    (modulo IEEE-754 float-rep noise) to `usd()` on the same inputs."""
    return Decimal(str(value)).quantize(USD_QUANT, rounding=ROUND_HALF_EVEN)


def pct(part: Decimal | float | int | str,
        whole: Decimal | float | int | str,
        places: int = 1) -> Decimal:
    """Compute `(part / whole) * 100`, quantized to `places` decimal places.

    Default `places=1` matches the legacy `savings_pct` rounding. Pass
    `places=2` for loss ratios or other percentages that need cent-precision.
    Returns Decimal('0') with the right quantization on whole==0 so callers
    can render without conditional logic."""
    if places < 0:
        raise ValueError(f"places must be >= 0, got {places}")
    quant = Decimal("1") if places == 0 else Decimal("0." + "0" * (places - 1) + "1")
    p = Decimal(str(part))
    w = Decimal(str(whole))
    if w == 0:
        return Decimal("0").quantize(quant, rounding=ROUND_HALF_EVEN)
    return ((p / w) * Decimal("100")).quantize(quant, rounding=ROUND_HALF_EVEN)


def usd_to_json(value: Decimal | float | int | str) -> str:
    """Serialize a Decimal for JSON column storage.

    Always returns a string. Storing money as a JSON float silently downgrades
    precision (Decimal('100.10') -> float 100.1 -> reads back imprecise). The
    string round-trip preserves cents exactly."""
    return str(usd(value))


def json_to_usd(value: str | float | int | Decimal) -> Decimal:
    """Deserialize a money value from a JSON column. Handles legacy float
    entries gracefully — a column written before this helper existed may
    contain raw numbers; we coerce through str() to stop float precision
    leaking into the Decimal pipeline."""
    return usd(value)


def cast_money_to_float(value: Decimal) -> float:
    """Boundary cast used by the legacy `get_premium_quote()` return path.

    The legacy API returns floats; this is the single point where Decimal
    becomes float for backwards compatibility. Goes through quantization
    first so the float displays the expected number of cents."""
    return float(usd(value))
