"""Join an in-flight renewal to its expiring policy and diff the coverage terms.

The renewal's proposed terms come from its selected (or quoted) CarrierQuote; the
expiring terms from the prior policy's frozen `terms_snapshot`. Both already
carry per-line limits / deductibles / exclusions, so this needs no document
upload — just two dict reads + the pure `diff_renewal_terms`.

Failure-isolated: ANY error → None (a renewal-diff hiccup must never blank the
broker's findings panel).
"""
from __future__ import annotations

import json
from typing import Optional

from sqlmodel import Session, select

from app.coverage.renewal_diff import (
    RenewalDiff,
    diff_renewal_terms,
    terms_from_coverage_terms,
)
from app.defense_package import _as_list
from app.models import CarrierQuote, Policy, Submission


def _as_dict(value) -> dict:
    """Coerce a Column(JSON) dict value to a dict (Neon may read it back as a
    JSON string). Mirrors the standing JSON-string guard."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _renewal_quote(session: Session, sub: Submission) -> Optional[CarrierQuote]:
    """The renewal's proposed terms: the broker's selected quote if any, else
    any quoted/bound one. None when nothing has been quoted yet (nothing to diff)."""
    quotes = list(session.exec(
        select(CarrierQuote).where(CarrierQuote.submission_id == sub.id)
    ))
    quoted = [q for q in quotes if q.status in ("quoted", "bound")]
    if not quoted:
        return None
    for q in quoted:
        if q.is_selected:
            return q
    return quoted[0]


def review_renewal(
    session: Session, sub: Submission
) -> Optional[tuple[Policy, RenewalDiff]]:
    """Returns (expiring_policy, diff) or None when there's nothing to compare
    (not a renewal, expiring policy gone, or no quote yet)."""
    try:
        prior_id = sub.prior_policy_id
        if not prior_id:
            return None
        expiring = session.get(Policy, prior_id)
        if expiring is None:
            return None
        quote = _renewal_quote(session, sub)
        if quote is None:
            return None
        exp_terms = terms_from_coverage_terms(
            expiring.carrier_id,
            _as_list(expiring.coverage_lines),
            _as_dict(expiring.terms_snapshot).get("coverage_terms"),
        )
        ren_terms = terms_from_coverage_terms(
            quote.carrier_id,
            _as_list(sub.coverage_lines),
            _as_dict(quote.coverage_terms),
        )
        return (expiring, diff_renewal_terms(exp_terms, ren_terms))
    except Exception:  # noqa: BLE001 — advisory only, never blank the panel
        return None
