"""COI auto-fill: group a broker's prior certificates by a normalized holder name
and surface the most-recent details to pre-fill a new certificate.

Why: a broker re-issues COIs to the same recurring landlords / event clients
constantly. Re-typing the holder address, operations text, and additional-insured
scope each time is the daily servicing grind — and an inexact name re-type
("ACME, LLC" vs "Acme LLC") mints a duplicate instead of superseding the prior
active COI (issue_certificate supersedes on an EXACT certificate_holder match).
Pre-filling from the canonical prior spelling removes the typing AND the
duplicate-minting in one move.

`summarize_holders` is pure (operates on already-loaded rows) so it's unit-tested
without a DB; the endpoint just loads the rows and calls it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Optional


def normalize_holder(name: str) -> str:
    """Case/punctuation/whitespace-insensitive key for matching the same holder
    across slightly different spellings."""
    s = (name or "").lower()
    s = re.sub(r"[.,]", " ", s)        # drop the punctuation that varies most
    s = re.sub(r"\s+", " ", s).strip()
    return s


@dataclass
class HolderSuggestion:
    certificate_holder: str            # canonical (most-recently-issued) spelling
    certificate_holder_address: str
    additional_insured: bool
    additional_insured_scope: Optional[str]
    description_of_operations: str
    times_used: int
    last_issued_at: str                # ISO-8601


def summarize_holders(certs: Iterable) -> list[HolderSuggestion]:
    """Group certificate rows by normalized holder; the most-recently-issued cert
    in each group supplies the canonical spelling + prefill fields. Sorted by
    most-used, then most-recent."""
    groups: dict[str, list] = {}
    for c in certs:
        groups.setdefault(normalize_holder(c.certificate_holder), []).append(c)

    suggestions: list[HolderSuggestion] = []
    for rows in groups.values():
        latest = max(rows, key=lambda c: c.issued_at)
        suggestions.append(HolderSuggestion(
            certificate_holder=latest.certificate_holder,
            certificate_holder_address=latest.certificate_holder_address,
            additional_insured=latest.additional_insured,
            additional_insured_scope=latest.additional_insured_scope,
            description_of_operations=latest.description_of_operations,
            times_used=len(rows),
            last_issued_at=latest.issued_at.isoformat(),
        ))

    suggestions.sort(key=lambda s: (s.times_used, s.last_issued_at), reverse=True)
    return suggestions
