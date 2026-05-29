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
    live_state_manager: Any | None = None,  # accepted for API symmetry; live_state's compliance_queue is the operator queue, not the underwriter view, so it's intentionally not consulted here
    delta_tracker: "IncidentDeltaTracker | None" = None,
) -> dict:
    """Compute a venue's risk score.

    When a DB session is provided AND the venue is on-book (not a prospect),
    `incident_count` comes from a LIVE COUNT of `IncidentRecord` rows for the
    venue — so the score matches what the user sees in the scoped Incidents
    list, no decoupling, no drift.

    Without a session (unit tests, headless callers) the engine falls back to
    the curated baseline in the venue dict + the in-memory `IncidentDeltaTracker`.
    Prospects always use the dict-baseline path (no real IncidentRecord rows
    exist for them).

    LiveStateManager.compliance_queue is intentionally NOT consulted here:
    that queue is the *operator's* active floor view (including auto-generated
    items from camera anomalies), which is a different concept from the
    underwriter's curated compliance count. Auto-generated items that should
    affect scoring must explicitly bump `delta_tracker.bump_compliance()`.
    """
    _ = (live_state_manager,)  # accepted but unused; see docstring
    base_venue = venues.get(venue_id, {})
    is_prospect = base_venue.get("source") == "prospect"
    tracker = delta_tracker if delta_tracker is not None else incident_delta_tracker

    overrides: dict = {}

    # Live incident count (book venues only, when a DB session is available).
    # A successful query is authoritative — including a genuine 0, so the
    # safety factor reconciles with the live incident list ("No incidents on
    # file" → safety scored as zero incidents, not the seeded baseline).
    # Only when there was NO live query (no session, prospect, or a DB error →
    # live_count is None) do we fall back to the dict baseline + delta tracker;
    # that keeps session-less unit fixtures working off the venues dict.
    live_count: int | None = None
    if session is not None and not is_prospect:
        try:
            from sqlmodel import select, func  # local import: avoid module-load cycle
            from app.models import IncidentRecord
            raw = session.exec(
                select(func.count(IncidentRecord.id)).where(IncidentRecord.venue_id == venue_id)
            ).one()
            # SQLAlchemy may return a Row, a tuple, or a scalar across versions.
            if isinstance(raw, int):
                live_count = raw
            elif hasattr(raw, "__getitem__"):
                live_count = int(raw[0]) if raw[0] is not None else 0
            else:
                live_count = int(raw) if raw is not None else 0
        except Exception:
            live_count = None  # any DB issue → fall through to baseline path

    if live_count is not None:
        # DB query succeeded — authoritative, including a genuine 0. (Was
        # `and live_count > 0`, which made a real zero fall back to the seeded
        # baseline and contradict the live incident list.)
        overrides["incident_count"] = live_count
    else:
        incident_delta = tracker.incident_delta(venue_id)
        if incident_delta > 0:
            overrides["incident_count"] = base_venue.get("incident_count", 0) + incident_delta

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