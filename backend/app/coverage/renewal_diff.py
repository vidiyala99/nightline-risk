"""Renewal-term diff (pure, no I/O).

Compares the expiring policy's coverage terms against the renewal's proposed
terms and names what changed — and crucially whether each change is **adverse to
the insured**. A dropped line, a newly carved-out exclusion, a lowered limit, or
a raised deductible is the canonical broker-E&O fact pattern: the silent renewal
change the broker didn't catch, then got sued over. The data is already
structured on both sides (`coverage_terms` carries per-line limits / deductibles
/ exclusions), so this needs no policy-document upload — just a dict diff.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional


def _money(v) -> Optional[Decimal]:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


@dataclass(frozen=True)
class LineTerms:
    per_occurrence: Optional[Decimal]
    aggregate: Optional[Decimal]
    deductible: Optional[Decimal]
    exclusions: frozenset[str]


@dataclass(frozen=True)
class PolicyTerms:
    carrier_id: str
    lines: dict[str, LineTerms]


@dataclass(frozen=True)
class TermChange:
    line: str
    field: str                 # per_occurrence | aggregate | deductible
    old: Optional[Decimal]
    new: Optional[Decimal]
    adverse: bool              # worse for the insured


@dataclass
class RenewalDiff:
    dropped_lines: list[str]
    added_lines: list[str]
    limit_changes: list[TermChange]
    added_exclusions: list[tuple[str, str]]    # (line, exclusion) — adverse
    removed_exclusions: list[tuple[str, str]]  # (line, exclusion) — favorable
    carrier_changed: bool

    @property
    def has_adverse(self) -> bool:
        """A genuine coverage *reduction*. Carrier change alone is a risk flag,
        surfaced separately — not counted here as a definite reduction."""
        return bool(self.dropped_lines) or bool(self.added_exclusions) or any(
            c.adverse for c in self.limit_changes
        )

    @property
    def adverse_findings(self) -> list[str]:
        out: list[str] = []
        for line in self.dropped_lines:
            out.append(f"{line} coverage is dropped at renewal")
        for line, ex in self.added_exclusions:
            out.append(f"{ex} exclusion added to {line} at renewal")
        for c in self.limit_changes:
            if c.adverse:
                out.append(f"{c.line} {c.field} {c.old} → {c.new}")
        if self.carrier_changed:
            out.append("carrier changed at renewal (policy form may differ)")
        return out


def terms_from_coverage_terms(
    carrier_id: str, coverage_lines, coverage_terms: dict
) -> PolicyTerms:
    """Normalize a `coverage_terms` dict (per-line limits/deductible/exclusions,
    money as strings) + the line list into a `PolicyTerms`. Caller coerces a
    JSON-string `coverage_terms` to a dict at the read boundary (Neon)."""
    terms = coverage_terms or {}
    lines: dict[str, LineTerms] = {}
    for line in coverage_lines or []:
        d = terms.get(line) or {}
        lines[line] = LineTerms(
            per_occurrence=_money(d.get("per_occurrence")),
            aggregate=_money(d.get("aggregate")),
            deductible=_money(d.get("deductible")),
            exclusions=frozenset(d.get("exclusions") or []),
        )
    return PolicyTerms(carrier_id=carrier_id, lines=lines)


def _limit_adverse(old: Optional[Decimal], new: Optional[Decimal]) -> bool:
    """A per-occurrence / aggregate limit: lower (or dropped) is worse."""
    if old is None:
        return False              # unknown prior → can't claim a reduction
    if new is None:
        return True               # limit removed
    return new < old


def _deductible_adverse(old: Optional[Decimal], new: Optional[Decimal]) -> bool:
    """A deductible: higher (or newly introduced) is worse."""
    old_v = old or Decimal("0")
    new_v = new or Decimal("0")
    return new_v > old_v


def diff_renewal_terms(expiring: PolicyTerms, renewal: PolicyTerms) -> RenewalDiff:
    exp_lines = set(expiring.lines)
    ren_lines = set(renewal.lines)
    dropped = sorted(exp_lines - ren_lines)
    added = sorted(ren_lines - exp_lines)

    limit_changes: list[TermChange] = []
    added_excl: list[tuple[str, str]] = []
    removed_excl: list[tuple[str, str]] = []

    for line in sorted(exp_lines & ren_lines):
        e = expiring.lines[line]
        r = renewal.lines[line]
        for field in ("per_occurrence", "aggregate", "deductible"):
            ev = getattr(e, field)
            rv = getattr(r, field)
            if ev == rv:
                continue
            adverse = (
                _deductible_adverse(ev, rv) if field == "deductible"
                else _limit_adverse(ev, rv)
            )
            limit_changes.append(TermChange(line=line, field=field, old=ev, new=rv, adverse=adverse))
        for ex in sorted(r.exclusions - e.exclusions):
            added_excl.append((line, ex))
        for ex in sorted(e.exclusions - r.exclusions):
            removed_excl.append((line, ex))

    return RenewalDiff(
        dropped_lines=dropped,
        added_lines=added,
        limit_changes=limit_changes,
        added_exclusions=added_excl,
        removed_exclusions=removed_excl,
        carrier_changed=expiring.carrier_id != renewal.carrier_id,
    )
