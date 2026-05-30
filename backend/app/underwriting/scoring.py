"""
Nightline Risk - Underwriting Scoring Engine

Calculates venue risk scores based on:
- Incident history (35%)
- Compliance (25%)
- Operational (25%)
- Business profile (15%)
"""

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from app.time import as_utc, now_utc


# Active incidents weigh full; resolved ones still count (history matters) but
# far less — so closing a case measurably raises the safety score.
_RESOLVED_STATUSES = {"closed", "closed_archived"}


def _incident_weight(*, injury: bool, police: bool, ems: bool, status: str) -> float:
    """Per-incident contribution to the weighted safety load.

    severity = 1.0 + 0.5 each for injury / police / EMS  (range 1.0-2.5)
    status   = 0.4 if resolved else 1.0
    """
    severity = 1.0 + 0.5 * bool(injury) + 0.5 * bool(police) + 0.5 * bool(ems)
    status_factor = 0.4 if status in _RESOLVED_STATUSES else 1.0
    return severity * status_factor


# ─── Recency + exposure shaping of the safety load ──────────────────────────
# Two venues with the same raw incident history should NOT score identically if
# one is years stale or an order of magnitude larger: old incidents decay, and
# a bigger room carries more exposure so a given raw count weighs less. Folding
# both into the *load* keeps the exp(-load/9) curve (and its unit tests)
# untouched, while pulling high-count venues out of the saturated zone — so
# closing a fresh case visibly moves the score again instead of nudging 1→2.
RECENCY_HALF_LIFE_DAYS = 365.0  # a 1-year-old incident contributes half its weight
REF_CAPACITY = 800.0            # reference room size; divisor == 1.0 at this capacity
EXPOSURE_POWER = 0.5            # sqrt dampening — large venues get relief, not erasure
_LN2 = math.log(2)


def _recency_factor(occurred_at: str | None, now: datetime) -> float:
    """Exponential time decay in (0, 1]; 1.0 when the date is missing/unparseable.

    Uses `occurred_at` (when it happened), not `created_at` (row insert). The
    string is naive-UTC on SQLite; `as_utc` re-attaches tzinfo so subtracting it
    from a tz-aware `now` doesn't raise. Unknown/garbage dates degrade to 1.0
    (no decay) rather than dropping the incident.
    """
    if not occurred_at:
        return 1.0
    raw = occurred_at.strip()
    if raw.endswith("Z"):  # fromisoformat predates 'Z' support on older runtimes
        raw = raw[:-1] + "+00:00"
    try:
        when = as_utc(datetime.fromisoformat(raw))
    except (TypeError, ValueError):
        return 1.0
    if when is None:
        return 1.0
    age_days = max(0.0, (now - when).total_seconds() / 86400.0)
    return math.exp(-_LN2 * age_days / RECENCY_HALF_LIFE_DAYS)


def _exposure_divisor(capacity: Any) -> float:
    """Venue-size normalizer >= 1.0; 1.0 when capacity is missing/non-positive.

    sqrt dampening: a 5000-cap venue divides load by ~2.5 (not 6.25), so real
    history still counts — large rooms just aren't punished like a tiny bar with
    the same raw count.
    """
    try:
        cap = float(capacity)
    except (TypeError, ValueError):
        return 1.0
    if cap <= 0:
        return 1.0
    return max(1.0, (cap / REF_CAPACITY) ** EXPOSURE_POWER)


def _effective_incident_load(rows, *, capacity: Any, now: datetime) -> float:
    """Weighted, recency-decayed, exposure-normalized incident load.

    `rows` are (injury, police, ems, status, occurred_at) tuples from the live
    IncidentRecord query. Severity/status come from `_incident_weight` (so its
    direct unit tests stay valid); recency and exposure layer on top.
    """
    raw = sum(
        _incident_weight(injury=r[0], police=r[1], ems=r[2], status=r[3])
        * _recency_factor(r[4], now)
        for r in rows
    )
    return raw / _exposure_divisor(capacity)


@dataclass
class RiskScoreBreakdown:
    venue_id: str
    total_score: int
    tier: str  # A, B, C, D
    factors: dict  # Breakdown by factor
    updated_at: str


class RiskScoringEngine:
    """Calculate risk scores for venues."""

    # Weights for each factor
    WEIGHTS = {
        "incident_history": 0.35,
        "compliance": 0.25,
        "operational": 0.25,
        "business_profile": 0.15,
    }

    # Tier boundaries
    TIER_THRESHOLDS = {
        "A": (80, 100),
        "B": (60, 79),
        "C": (40, 59),
        "D": (0, 39),
    }

    def __init__(self, venues: dict):
        self.venues = venues

    def calculate_score(self, venue_id: str) -> RiskScoreBreakdown:
        """Calculate total risk score for a venue."""
        if venue_id not in self.venues:
            raise ValueError(f"Venue not found: {venue_id}")

        venue = self.venues[venue_id]

        # Calculate individual factor scores (0-100)
        incident_score = self._score_incident_history(venue)
        compliance_score = self._score_compliance(venue)
        operational_score, operational_adjustments = self._score_operational_detail(venue)
        business_score = self._score_business_profile(venue)

        # Weighted total
        total_score = int(
            incident_score * self.WEIGHTS["incident_history"]
            + compliance_score * self.WEIGHTS["compliance"]
            + operational_score * self.WEIGHTS["operational"]
            + business_score * self.WEIGHTS["business_profile"]
        )

        # Ensure bounds
        total_score = max(0, min(100, total_score))

        # Determine tier
        tier = self._get_tier(total_score)

        return RiskScoreBreakdown(
            venue_id=venue_id,
            total_score=total_score,
            tier=tier,
            factors={
                "incident_history": {"score": incident_score, "weight": self.WEIGHTS["incident_history"]},
                "compliance": {"score": compliance_score, "weight": self.WEIGHTS["compliance"]},
                "operational": self._operational_factor(operational_score, operational_adjustments),
                "business_profile": {"score": business_score, "weight": self.WEIGHTS["business_profile"]},
            },
            updated_at=datetime.now().isoformat(),
        )

    def _score_incident_history(self, venue: dict) -> int:
        """Score based on weighted incident load using an exponential decay curve.

        Uses `incident_load` (sum of per-incident weights from `_incident_weight`)
        when available.  Falls back to raw `incident_count` so that session-less
        callers (unit fixtures, delta-tracker path) remain fully functional.

        Curve: score = round(100 × exp(−load / 9))
          load=0   → 100  (clean record)
          load=1   → 89   (one minor open incident)
          load=2.5 → 76   (one max-severity open incident)
          load=25  → 6    (heavy history)
        Closing an incident reduces its weight from 1.0× to 0.4×, visibly
        raising the score — keeping the UI promise honest.
        """
        load = venue.get("incident_load")
        if load is None:
            load = venue.get("incident_count", 0)
        return max(0, min(100, round(100 * math.exp(-load / 9.0))))

    def _score_compliance(self, venue: dict) -> int:
        """
        Score based on compliance status (0-100, higher is better).

        Factors:
        - Outstanding compliance items = lower score
        - More items = significantly lower score
        """
        precomputed = venue.get("compliance_score")
        if precomputed is not None:
            return int(precomputed)
        compliance_items = venue.get("compliance_items", 0)

        if compliance_items == 0:
            return 100
        elif compliance_items == 1:
            return 70
        elif compliance_items == 2:
            return 40
        elif compliance_items == 3:
            return 20
        else:  # 4+
            return 0

    # Bounded penalty weights for ingested operational metrics. Each maps a
    # normalized rate/ratio to a max point deduction off the security base.
    # Tuned so a venue maxing out every signal can fully erode the factor.
    OPERATIONAL_PENALTIES = {
        "over_pour_rate": 40,      # share of pours flagged as over-pours
        "id_rejection_rate": 30,   # share of IDs rejected/flagged at the door
        "staffing_ratio": 30,      # penalize the shortfall below 1.0 (understaffed)
        "occupancy_ratio": 50,     # penalize the excess above 1.0 (over capacity)
    }

    def _score_operational(self, venue: dict) -> int:
        score, _ = self._score_operational_detail(venue)
        return score

    def _score_operational_detail(self, venue: dict) -> tuple[int, dict | None]:
        """Operational factor score plus the per-signal adjustment breakdown.

        Base is the static security level (high=100, medium=70, low=40).
        When `operational_data` (written by the ingestion rollup) is present,
        each signal applies a bounded, explained penalty so the score visibly
        moves when data is ingested. No `operational_data` → base unchanged,
        and no `adjustments` surfaced (backward compatible).
        """
        security = venue.get("security_level", "medium")
        base = {"high": 100, "medium": 70, "low": 40}.get(security, 70)

        op = venue.get("operational_data")
        if not op:
            return base, None

        adjustments: dict[str, int] = {}

        def _apply(label: str, rate: float, weight: int) -> None:
            penalty = round(max(0.0, rate) * weight)
            if penalty:
                adjustments[label] = -penalty

        if (v := op.get("over_pour_rate")) is not None:
            _apply("over_pour", float(v), self.OPERATIONAL_PENALTIES["over_pour_rate"])
        if (v := op.get("id_rejection_rate")) is not None:
            _apply("id_rejection", float(v), self.OPERATIONAL_PENALTIES["id_rejection_rate"])
        if (v := op.get("staffing_ratio")) is not None:
            _apply("staffing_shortfall", 1.0 - float(v), self.OPERATIONAL_PENALTIES["staffing_ratio"])
        if (v := op.get("occupancy_ratio")) is not None:
            _apply("over_capacity", float(v) - 1.0, self.OPERATIONAL_PENALTIES["occupancy_ratio"])

        score = max(0, min(100, base + sum(adjustments.values())))
        return score, {"base": base, **adjustments}

    def _operational_factor(self, score: int, adjustments: dict | None) -> dict:
        factor = {"score": score, "weight": self.WEIGHTS["operational"]}
        if adjustments:
            factor["adjustments"] = adjustments
        return factor

    def _score_business_profile(self, venue: dict) -> int:
        """
        Score based on business profile (0-100, higher is better).
        
        Factors:
        - Years in operation (more = better)
        - Prior carrier (has history = better)
        - Venue type risk
        """
        years = venue.get("years_in_operation", 1)

        # Years scoring: 10+ years = 100, 1 year = 50
        if years >= 10:
            year_score = 100
        elif years >= 7:
            year_score = 85
        elif years >= 5:
            year_score = 70
        elif years >= 3:
            year_score = 60
        elif years >= 2:
            year_score = 55
        else:
            year_score = 50

        # Prior carrier bonus
        prior = venue.get("prior_carrier")
        if prior and prior != "None":
            carrier_bonus = 15
        else:
            carrier_bonus = 0

        # Venue type risk
        vtype = venue.get("venue_type", "dive_bar")
        type_risk = {
            "dive_bar": 10,
            "rooftop_bar": 5,
            "music_venue": -5,
            "latin_club": -5,
            "club": -10,
        }
        type_score = type_risk.get(vtype, 0)

        return max(0, min(100, year_score + carrier_bonus + type_score))

    def _get_tier(self, score: int) -> str:
        """Map score to tier."""
        for tier, (min_s, max_s) in self.TIER_THRESHOLDS.items():
            if min_s <= score <= max_s:
                return tier
        return "D"


class IncidentDeltaTracker:
    """Tracks incidents logged *after* the curated underwriter baseline.

    VENUES[vid]["incident_count"] represents an underwriter's curated 12-month
    claim history (per the design comment in seed_data.py). When the operator
    or a demo simulator writes a NEW incident via the API, that's a delta on
    top of the baseline — and that delta is what should move the risk score
    in real time.

    Restart resets the tracker; the curated VENUES baseline is preserved.
    This is intentional: the next quote cycle should fold the delta into the
    baseline manually, not silently extend the curated history forever.
    """

    def __init__(self) -> None:
        self._deltas: dict[str, int] = {}
        self._compliance_deltas: dict[str, int] = {}

    def bump_incident(self, venue_id: str, by: int = 1) -> int:
        self._deltas[venue_id] = self._deltas.get(venue_id, 0) + by
        return self._deltas[venue_id]

    def bump_compliance(self, venue_id: str, by: int = 1) -> int:
        self._compliance_deltas[venue_id] = self._compliance_deltas.get(venue_id, 0) + by
        return self._compliance_deltas[venue_id]

    def incident_delta(self, venue_id: str) -> int:
        return self._deltas.get(venue_id, 0)

    def compliance_delta(self, venue_id: str) -> int:
        return self._compliance_deltas.get(venue_id, 0)

    def snapshot(self, venue_id: str) -> dict[str, int]:
        return {
            "incident_delta": self.incident_delta(venue_id),
            "compliance_delta": self.compliance_delta(venue_id),
        }

    def reset(self, venue_id: str | None = None) -> None:
        if venue_id is None:
            self._deltas.clear()
            self._compliance_deltas.clear()
        else:
            self._deltas.pop(venue_id, None)
            self._compliance_deltas.pop(venue_id, None)


# Module-level singleton — used by main.py call sites and by the incident_flow
# hook that bumps the counter when a new incident is persisted.
incident_delta_tracker = IncidentDeltaTracker()


def get_risk_score(
    venue_id: str,
    venues: dict,
    session: Any | None = None,
    live_state_manager: Any | None = None,  # legacy parameter; no longer used for compliance (kept for call-site compatibility)
    delta_tracker: "IncidentDeltaTracker | None" = None,
    now: "datetime | None" = None,
) -> dict:
    """Compute a venue's risk score.

    When a DB session is provided AND the venue is on-book (not a prospect),
    the safety factor is driven by a LIVE load over the venue's `IncidentRecord`
    rows: each incident is weighted by severity and status (`_incident_weight`),
    then decayed by age (`_recency_factor`) and normalized by venue exposure
    (`_exposure_divisor`) — see `_effective_incident_load`. `incident_count` is
    still set to the raw live row count for display, so the score matches what
    the user sees in the scoped Incidents list, no decoupling, no drift.

    Without a session (unit tests, headless callers) the engine falls back to
    the curated baseline in the venue dict + the in-memory `IncidentDeltaTracker`.
    Prospects always use the dict-baseline path (no real IncidentRecord rows
    exist for them).

    The compliance factor follows the same pattern: with a session, it is fused
    over the venue's persisted `ComplianceSignal` rows (via
    `compliance_signals_for` + `fuse`), so the factor and the operator's
    Compliance queue read the same data and cannot disagree. Resolving a signal
    immediately raises the factor. Without a session the engine falls back to
    the curated `compliance_items` baseline + the in-memory
    `IncidentDeltaTracker` (delta tracking still works for session-less
    fixtures and headless callers).
    """
    base_venue = venues.get(venue_id, {})
    is_prospect = base_venue.get("source") == "prospect"
    tracker = delta_tracker if delta_tracker is not None else incident_delta_tracker
    # Recency decay is relative to "now". Default to wall-clock UTC; tests pin it
    # so the time-dependent safety factor stays deterministic.
    if now is None:
        now = now_utc()

    overrides: dict = {}

    # Live incident load (book venues, when a DB session is available). We read
    # the rows (not just COUNT) to weight each incident by severity (injury/
    # police/EMS) and status (open vs resolved). A successful query is
    # authoritative — including zero rows -> load 0 -> clean score. Only a missing
    # query (no session, prospect, or DB error -> live_rows is None) falls back
    # to the dict baseline + delta tracker, keeping session-less fixtures working.
    live_rows = None
    if session is not None and not is_prospect:
        try:
            from sqlmodel import select  # local import: avoid module-load cycle
            from app.models import IncidentRecord
            live_rows = session.exec(
                select(
                    IncidentRecord.injury_observed,
                    IncidentRecord.police_called,
                    IncidentRecord.ems_called,
                    IncidentRecord.status,
                    IncidentRecord.occurred_at,
                ).where(IncidentRecord.venue_id == venue_id)
            ).all()
        except Exception:
            live_rows = None  # any DB issue -> fall through to baseline path

    if live_rows is not None:
        # `incident_count` stays the raw row count (display + Incidents-list
        # reconciliation contract); the *load* is recency- and exposure-shaped.
        overrides["incident_count"] = len(live_rows)
        overrides["incident_load"] = _effective_incident_load(
            live_rows, capacity=base_venue.get("capacity"), now=now
        )
    else:
        incident_delta = tracker.incident_delta(venue_id)
        if incident_delta > 0:
            overrides["incident_count"] = base_venue.get("incident_count", 0) + incident_delta

    # Live compliance load (mirrors the incident path above). When a session is
    # available the compliance factor is fused over the venue's ComplianceSignal
    # rows — the SAME rows the operator's Compliance queue shows — so factor and
    # queue can't disagree, and resolving an item raises the score. Falls back to
    # the curated `compliance_items` baseline + delta tracker for session-less
    # callers (unit fixtures, headless).
    live_compliance_score = None
    if session is not None and not is_prospect:
        try:
            from app.services.compliance_signals import compliance_signals_for  # local: avoid cycle
            from app.underwriting.fusion import fuse, COMPLIANCE_K
            live_compliance_score = fuse(
                compliance_signals_for(venue_id, session), COMPLIANCE_K
            )
        except Exception:
            live_compliance_score = None

    if live_compliance_score is not None:
        overrides["compliance_score"] = live_compliance_score
    else:
        compliance_delta = tracker.compliance_delta(venue_id)
        if compliance_delta > 0:
            overrides["compliance_items"] = base_venue.get("compliance_items", 0) + compliance_delta

    effective_venues = {**venues, venue_id: {**base_venue, **overrides}} if overrides else venues

    engine = RiskScoringEngine(effective_venues)
    result = engine.calculate_score(venue_id)
    return {
        "venue_id": result.venue_id,
        "total_score": result.total_score,
        "tier": result.tier,
        "factors": result.factors,
        "updated_at": result.updated_at,
        "delta": tracker.snapshot(venue_id),
        # Prospects carry deterministic-random baseline attributes (see
        # prospects.py). Surface the source so the UI can flag the score as
        # estimated rather than rendering it identically to a book venue's.
        "source": base_venue.get("source", "book"),
    }