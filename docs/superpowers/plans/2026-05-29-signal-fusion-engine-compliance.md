# Signal Fusion Engine (Compliance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compliance risk factor's static seed count with a deterministic provenance/severity/status-weighted fusion over a new persisted `ComplianceSignal` table, so the factor and the operator's compliance queue read one source and auto-generated camera items nudge — not tank — the score.

**Architecture:** A pure `fuse()` engine consumes a factor-agnostic `Signal` interface (generality lives in the engine). A typed `ComplianceSignal` table (mirrors `IncidentRecord`) is the system of record; the operator queue and the score both read it. `get_risk_score` uses `fuse()` when a DB session is present, falling back to the existing step function otherwise.

**Tech Stack:** Python, SQLModel/SQLAlchemy (SQLite dev / Postgres prod), FastAPI, pytest.

**Spec:** `docs/superpowers/specs/2026-05-29-signal-fusion-engine-compliance-design.md`

---

## File Structure

- **Create** `backend/app/underwriting/fusion.py` — `Signal` dataclass, weight tables, `signal_weight`, `fuse`, `COMPLIANCE_K`. Pure, no DB.
- **Modify** `backend/app/models.py` — add `ComplianceSignal` table.
- **Modify** `backend/app/lifecycles.py` — add `ComplianceSignalStatus` + `COMPLIANCE_SIGNAL_TRANSITIONS`.
- **Create** `backend/app/services/compliance_signals.py` — adapter (`compliance_signals_for`), queue read (`open_signals_for`), transition helper (`transition_compliance_signal`), anomaly writer (`record_auto_signal`).
- **Modify** `backend/app/underwriting/scoring.py` — compliance factor reads `fuse()` when a session is available.
- **Modify** `backend/app/main.py` — `/live` queue + `_find_compliance_item` read `ComplianceSignal`.
- **Modify** `backend/app/api/v1/compliance.py` — upload/resolve routes transition the signal.
- **Modify** `backend/app/api/v1/operations.py` — pass `session` into `process_events`.
- **Modify** `backend/app/live_state.py` — camera-anomaly path persists a signal (when a session is provided).
- **Modify** `backend/app/seed_data.py` (+ a backfill in `create_db_and_tables` or a seed script) — seed `ComplianceSignal` rows from `compliance_items`.
- **Tests:** `backend/tests/test_fusion.py`, `test_compliance_signal_lifecycle.py`, `test_compliance_signal_scoring.py`, `test_compliance_signal_integration.py`, `test_compliance_calibration.py`; update `test_risk_score_live_delta.py`.

---

## Task 1: Fusion engine (pure)

**Files:**
- Create: `backend/app/underwriting/fusion.py`
- Test: `backend/tests/test_fusion.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fusion.py
import math
from app.underwriting.fusion import Signal, signal_weight, fuse, COMPLIANCE_K


def s(provenance="underwriter_verified", severity="medium", status="open"):
    return Signal(provenance=provenance, severity=severity, status=status)


def test_signal_weight_is_product_of_three_tables():
    assert signal_weight(s()) == 1.0  # 1.0 * 1.0 * 1.0
    assert signal_weight(s("auto_generated", "urgent", "open")) == 0.75  # 0.3 * 2.5 * 1.0
    assert signal_weight(s("underwriter_verified", "medium", "resolved")) == 0.2  # * 0.2


def test_fuse_empty_is_clean_100():
    assert fuse([], COMPLIANCE_K) == 100


def test_fuse_anchor_one_verified_open_is_about_70():
    assert fuse([s()], COMPLIANCE_K) == 70


def test_fuse_anchor_one_auto_urgent_nudges_not_tanks():
    score = fuse([s("auto_generated", "urgent", "open")], COMPLIANCE_K)
    assert score == 77  # round(100 * exp(-0.75/2.8))


def test_fuse_anchor_two_verified_open_is_about_49():
    assert fuse([s(), s()], COMPLIANCE_K) == 49


def test_fuse_is_clamped_and_deterministic():
    many = [s("underwriter_verified", "urgent", "open")] * 50
    assert fuse(many, COMPLIANCE_K) == 0
    assert fuse(many, COMPLIANCE_K) == fuse(many, COMPLIANCE_K)


def test_unknown_enum_raises():
    import pytest
    with pytest.raises(KeyError):
        signal_weight(s(provenance="rumor"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fusion.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.underwriting.fusion'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/underwriting/fusion.py
"""Deterministic signal-fusion engine.

A `Signal` is a factor-agnostic (provenance, severity, status) triple. The
engine folds a list of signals into a 0-100 factor score by summing each
signal's weight (provenance x severity x status) into a "load" and mapping it
through an exponential-decay curve, mirroring `_incident_weight` in scoring.py.

Generality lives here: any factor that can express its data as `Signal`s scores
through `fuse()`. No wall-clock time is consulted — same inputs, same score.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

PROVENANCE_WEIGHT = {
    "underwriter_verified": 1.0,
    "ingested": 0.9,
    "operator_reported": 0.6,
    "auto_generated": 0.3,
}
SEVERITY_WEIGHT = {"urgent": 2.5, "high": 1.5, "medium": 1.0, "low": 0.5}
STATUS_WEIGHT = {"open": 1.0, "resolved": 0.2}

# Per-factor decay constant. Compliance: 1 verified-open item -> ~70.
COMPLIANCE_K = 2.8


@dataclass(frozen=True)
class Signal:
    provenance: str
    severity: str
    status: str


def signal_weight(s: Signal) -> float:
    """How much a single signal contributes to the load. Unknown enum values
    raise KeyError (fail loud) — they should be impossible past the Literal
    columns on write."""
    return (
        PROVENANCE_WEIGHT[s.provenance]
        * SEVERITY_WEIGHT[s.severity]
        * STATUS_WEIGHT[s.status]
    )


def fuse(signals: list[Signal], k: float) -> int:
    """Fold signals into a 0-100 score. Higher score = lower risk."""
    load = sum(signal_weight(s) for s in signals)
    return max(0, min(100, round(100 * math.exp(-load / k))))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fusion.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/fusion.py backend/tests/test_fusion.py
git commit -m "feat(fusion): deterministic provenance/severity/status weighting engine"
```

---

## Task 2: `ComplianceSignal` table + lifecycle types

**Files:**
- Modify: `backend/app/lifecycles.py` (after the PolicyRequest block, before `# ─── Errors ───`)
- Modify: `backend/app/models.py` (after `IncidentEvaluation`)
- Test: `backend/tests/test_compliance_signal_lifecycle.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_compliance_signal_lifecycle.py
import pytest
from app.lifecycles import (
    COMPLIANCE_SIGNAL_TRANSITIONS,
    assert_valid_transition,
    InvalidTransitionError,
)
from app.models import ComplianceSignal


def test_transition_matrix_allows_resolve_and_reopen():
    assert "resolved" in COMPLIANCE_SIGNAL_TRANSITIONS["open"]
    assert "open" in COMPLIANCE_SIGNAL_TRANSITIONS["resolved"]


def test_invalid_transition_raises():
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(
            COMPLIANCE_SIGNAL_TRANSITIONS, "resolved", "archived",
            entity_name="compliance_signal",
        )


def test_model_defaults_status_open_and_timestamps():
    row = ComplianceSignal(
        id="cs-1", venue_id="nowadays", title="t", description="d",
        provenance="underwriter_verified", severity="medium",
    )
    assert row.status == "open"
    assert row.resolved_at is None
    assert row.created_at is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_compliance_signal_lifecycle.py -v`
Expected: FAIL — `ImportError: cannot import name 'COMPLIANCE_SIGNAL_TRANSITIONS'`

- [ ] **Step 3a: Add lifecycle types to `lifecycles.py`**

Insert before the `# ─── Errors ───` section:

```python
# ─── ComplianceSignal lifecycle ──────────────────────────────────────────

ComplianceSignalStatus = Literal[
    "open",      # outstanding compliance item
    "resolved",  # cleared (evidence uploaded or broker waiver)
]

COMPLIANCE_SIGNAL_TRANSITIONS: dict[str, set[str]] = {
    "open":     {"resolved"},
    "resolved": {"open"},  # reopen if a waiver/evidence is retracted
}

COMPLIANCE_SIGNAL_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in COMPLIANCE_SIGNAL_TRANSITIONS.items() if not nexts
)
```

- [ ] **Step 3b: Add the table to `models.py`**

Add `from typing import Optional` is already imported. Insert after `IncidentEvaluation` (line ~57):

```python
class ComplianceSignal(SQLModel, table=True):
    """Persisted compliance item — the system of record the operator queue and
    the compliance risk factor both read. Replaces the transient in-memory
    ComplianceItem queue. Mirrors IncidentRecord."""
    id: str = Field(primary_key=True)
    venue_id: str = Field(index=True, foreign_key="venue.id")
    title: str
    description: str
    provenance: str  # auto_generated|operator_reported|underwriter_verified|ingested
    severity: str    # low|medium|high|urgent
    status: str = Field(default="open")  # open|resolved
    created_at: datetime = Field(default_factory=now_utc)
    resolved_at: Optional[datetime] = Field(default=None)
    evidence_ref: Optional[str] = Field(default=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_compliance_signal_lifecycle.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/lifecycles.py backend/app/models.py backend/tests/test_compliance_signal_lifecycle.py
git commit -m "feat(compliance): ComplianceSignal table + lifecycle transitions"
```

---

## Task 3: Signal adapter + wire scoring (with fallback)

**Files:**
- Create: `backend/app/services/compliance_signals.py`
- Modify: `backend/app/underwriting/scoring.py` (the compliance block we added previously, ~lines 371-393)
- Test: `backend/tests/test_compliance_signal_scoring.py`
- Modify: `backend/tests/test_risk_score_live_delta.py` (rewrite the two interim tests)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_compliance_signal_scoring.py
from sqlmodel import Session, SQLModel, create_engine
from app.models import ComplianceSignal, Venue
from app.seed_data import VENUES
from app.underwriting.scoring import get_risk_score, incident_delta_tracker


def _session():
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    s.add(Venue(id="nowadays", name="Nowadays"))
    s.commit()
    return s


def _add(session, n, provenance="underwriter_verified", severity="medium", status="open"):
    for i in range(n):
        session.add(ComplianceSignal(
            id=f"cs-{provenance}-{severity}-{status}-{i}", venue_id="nowadays",
            title="t", description="d", provenance=provenance, severity=severity, status=status,
        ))
    session.commit()


def test_compliance_factor_zero_signals_is_clean():
    incident_delta_tracker.reset()
    session = _session()
    result = get_risk_score("nowadays", VENUES, session=session)
    assert result["factors"]["compliance"]["score"] == 100


def test_compliance_factor_two_verified_open_is_about_49():
    incident_delta_tracker.reset()
    session = _session()
    _add(session, 2)
    result = get_risk_score("nowadays", VENUES, session=session)
    assert result["factors"]["compliance"]["score"] == 49


def test_compliance_factor_auto_generated_nudges():
    incident_delta_tracker.reset()
    session = _session()
    _add(session, 1, provenance="auto_generated", severity="urgent")
    result = get_risk_score("nowadays", VENUES, session=session)
    assert result["factors"]["compliance"]["score"] == 77


def test_compliance_factor_falls_back_to_step_without_session():
    # Nowadays seed compliance_items=2 -> step function -> 40
    incident_delta_tracker.reset()
    result = get_risk_score("nowadays", VENUES)
    assert result["factors"]["compliance"]["score"] == 40
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_compliance_signal_scoring.py -v`
Expected: FAIL — `test_compliance_factor_zero_signals_is_clean` asserts 100 but the current scoring (session present, no live_state_manager) falls through to seed `compliance_items=2` → 40.

- [ ] **Step 3a: Create the adapter service**

```python
# backend/app/services/compliance_signals.py
"""Read/write helpers for ComplianceSignal — the single source of truth for the
operator compliance queue AND the compliance risk factor."""
from __future__ import annotations

from sqlmodel import Session, select

from app.lifecycles import COMPLIANCE_SIGNAL_TRANSITIONS, assert_valid_transition
from app.models import ComplianceSignal
from app.packet_core import _add_audit_event
from app.time import now_utc
from app.underwriting.fusion import Signal


def open_signals_for(venue_id: str, session: Session) -> list[ComplianceSignal]:
    """All open compliance rows for a venue (drives the operator queue)."""
    return list(session.exec(
        select(ComplianceSignal)
        .where(ComplianceSignal.venue_id == venue_id)
        .where(ComplianceSignal.status == "open")
        .order_by(ComplianceSignal.created_at)
    ).all())


def compliance_signals_for(venue_id: str, session: Session) -> list[Signal]:
    """All compliance rows (any status) for a venue, mapped to engine Signals.
    Resolved rows are included so they contribute their reduced (0.2) weight."""
    rows = session.exec(
        select(ComplianceSignal).where(ComplianceSignal.venue_id == venue_id)
    ).all()
    return [Signal(provenance=r.provenance, severity=r.severity, status=r.status) for r in rows]


def transition_compliance_signal(
    session: Session, row: ComplianceSignal, *, to: str, actor_id: str,
    evidence_ref: str | None = None, metadata: dict | None = None,
) -> ComplianceSignal:
    """Move a signal between states, validating + emitting an audit event."""
    assert_valid_transition(
        COMPLIANCE_SIGNAL_TRANSITIONS, row.status, to, entity_name="compliance_signal",
    )
    row.status = to
    row.resolved_at = now_utc() if to == "resolved" else None
    if evidence_ref is not None:
        row.evidence_ref = evidence_ref
    session.add(row)
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="compliance_signal", entity_id=row.id,
        event_type=f"compliance_signal.{to}",
        event_metadata={"venue_id": row.venue_id, **(metadata or {})},
    )
    return row
```

- [ ] **Step 3b: Wire scoring in `scoring.py`**

Replace the compliance block added previously (the `live_compliance` block, currently ~lines 371-393) with:

```python
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
```

Then teach the engine to honor a precomputed factor score. In `RiskScoringEngine._score_compliance` (scoring.py ~line 124), add at the top:

```python
    def _score_compliance(self, venue: dict) -> int:
        precomputed = venue.get("compliance_score")
        if precomputed is not None:
            return int(precomputed)
        compliance_items = venue.get("compliance_items", 0)
        # ... existing step function unchanged ...
```

(The `overrides` dict already merges into the venue dict via `effective_venues`, so `compliance_score` reaches `_score_compliance`.)

- [ ] **Step 3c: Rewrite the two interim tests in `test_risk_score_live_delta.py`**

Replace `test_compliance_factor_reads_empty_live_queue_as_clean` and
`test_compliance_factor_tracks_live_queue_length_not_seed` (the `len(queue)`
versions) with a single delegation note, since coverage now lives in
`test_compliance_signal_scoring.py`:

```python
# Compliance factor sourcing moved from the live in-memory queue to persisted
# ComplianceSignal rows + the fusion engine. See test_compliance_signal_scoring.py.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_compliance_signal_scoring.py tests/test_risk_score_live_delta.py -v`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/compliance_signals.py backend/app/underwriting/scoring.py backend/tests/test_compliance_signal_scoring.py backend/tests/test_risk_score_live_delta.py
git commit -m "feat(compliance): score factor from ComplianceSignal rows via fusion engine"
```

---

## Task 4: Operator queue + resolve + camera anomaly read/write signals

**Files:**
- Modify: `backend/app/main.py` (`/live` builder ~line 773; `_find_compliance_item`)
- Modify: `backend/app/api/v1/compliance.py` (upload + broker-resolve routes)
- Modify: `backend/app/api/v1/operations.py` (line 53 — pass session)
- Modify: `backend/app/live_state.py` (`process_events` signature + anomaly path)
- Test: `backend/tests/test_compliance_signal_integration.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_compliance_signal_integration.py
from fastapi.testclient import TestClient
from app.main import app
from app.models import ComplianceSignal
from app.database import get_session


def _seed_signal(item_id="cs-it-1", venue="nowadays", status="open"):
    gen = get_session()
    session = next(gen)
    session.add(ComplianceSignal(
        id=item_id, venue_id=venue, title="License renewal",
        description="Upload renewed liquor license.",
        provenance="underwriter_verified", severity="medium", status=status,
    ))
    session.commit()
    try:
        next(gen)
    except StopIteration:
        pass


def test_live_queue_lists_open_signals():
    _seed_signal("cs-it-open")
    with TestClient(app) as client:
        live = client.get("/api/venues/nowadays/live").json()
        ids = [c["id"] for c in live["compliance_queue"]]
        assert "cs-it-open" in ids


def test_resolving_signal_raises_compliance_factor():
    _seed_signal("cs-it-resolveme")
    with TestClient(app) as client:
        before = client.get("/api/venues/nowadays/risk-score").json()["factors"]["compliance"]["score"]
        r = client.patch(
            "/api/venues/nowadays/compliance/cs-it-resolveme/resolve",
            json={"reason": "verified"},
            headers={"Authorization": "Bearer " + _broker_token(client)},
        )
        assert r.status_code == 200
        after = client.get("/api/venues/nowadays/risk-score").json()["factors"]["compliance"]["score"]
        assert after > before
```

> Note: `_broker_token(client)` — reuse the existing auth-token test helper from `tests/conftest.py` (search `def _broker_token` / broker login fixture; if absent, log in via `/api/auth/login` with the seeded broker and read the token). Match the pattern already used in `test_claim_routes.py`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_compliance_signal_integration.py -v`
Expected: FAIL — `/live` builds the queue from the in-memory `state.compliance_queue`, so the seeded `ComplianceSignal` row is absent.

- [ ] **Step 3a: `/live` queue reads open signals (`main.py` ~line 773)**

Where the `/live` response builds `compliance_queue` from `state.compliance_queue`, replace the source with open signals mapped to the `ComplianceItem` response shape (keep the API contract identical):

```python
    from app.services.compliance_signals import open_signals_for
    from app.schemas import ComplianceItem
    open_rows = open_signals_for(venue_id, session)
    compliance_queue = [
        ComplianceItem(id=r.id, title=r.title, description=r.description, severity=r.severity)
        for r in open_rows
    ]
    # ... use `compliance_queue` in the response instead of state.compliance_queue ...
```

Update `_find_compliance_item` (main.py) to look up a row:

```python
def _find_compliance_item(venue_id, venue, item_id, session=None):
    """Resolve a compliance item to its ComplianceSignal row."""
    from app.services.compliance_signals import open_signals_for
    if session is None:
        return None
    for r in open_signals_for(venue_id, session):
        if r.id == item_id:
            return r
    return None
```

(Adjust the two `_find_compliance_item(...)` call sites in `compliance.py` to pass `session`.)

- [ ] **Step 3b: Resolve routes transition the signal (`compliance.py`)**

In `resolve_compliance_item_as_broker`, replace the `live_state_manager.resolve_compliance_item` call with:

```python
    from app.services.compliance_signals import transition_compliance_signal
    row = session.get(ComplianceSignal, item_id)
    if row is None or row.venue_id != venue_id:
        raise error_response("compliance_item_not_found",
            f"Compliance item {item_id!r} not found for venue {venue_id!r}.", status_code=404)
    transition_compliance_signal(
        session, row, to="resolved", actor_id=user["sub"],
        metadata={"reason": (body or {}).get("reason")},
    )
    session.commit()
    return {"status": "resolved", "item_id": item_id}
```

In the upload route, after persisting evidence, replace `live_state_manager.resolve_compliance_item(...)` with the same transition (actor_id=`uploaded_by`, `evidence_ref=file_ref`). Import `ComplianceSignal` at top of `compliance.py`.

- [ ] **Step 3c: Camera anomaly persists a signal (`operations.py` + `live_state.py`)**

`operations.py:53` — pass the session:

```python
    live_state_manager.process_events(venue_id, events, venue_data, session=session)
```

`live_state.py` — change the signature and the anomaly branch:

```python
    def process_events(self, venue_id, events, venue_data, session=None):
        ...
            elif event.event_type == "camera_metadata":
                anomaly_score = event.payload.get("anomaly_score", 0.0)
                if anomaly_score > CAMERA_ANOMALY_THRESHOLD and session is not None:
                    from app.models import ComplianceSignal
                    from sqlmodel import select
                    open_auto = session.exec(
                        select(ComplianceSignal)
                        .where(ComplianceSignal.venue_id == venue_id)
                        .where(ComplianceSignal.status == "open")
                        .where(ComplianceSignal.provenance == "auto_generated")
                    ).all()
                    if len(open_auto) < MAX_AUTO_GENERATED_COMPLIANCE_ITEMS:
                        session.add(ComplianceSignal(
                            id=f"INCIDENT_{event.event_id[:6].upper()}",
                            venue_id=venue_id,
                            title=f"ANOMALY_DETECTED_{event.payload.get('camera_id', 'UKN').upper()}",
                            description="Upload verified security footage to preserve claims defensibility.",
                            provenance="auto_generated", severity="urgent", status="open",
                        ))
                        session.commit()
```

(The other `process_events` caller, `main.py:653`, passes no session — anomalies there are skipped, which is correct: that path has no DB context.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_compliance_signal_integration.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/app/api/v1/compliance.py backend/app/api/v1/operations.py backend/app/live_state.py backend/tests/test_compliance_signal_integration.py
git commit -m "feat(compliance): operator queue, resolve, and camera anomalies use ComplianceSignal"
```

---

## Task 5: Seed `ComplianceSignal` rows from `compliance_items`

**Files:**
- Modify: `backend/app/database.py` (`create_db_and_tables`, after column ALTERs)
- Test: `backend/tests/test_compliance_signal_integration.py` (add)

- [ ] **Step 1: Write the failing test**

```python
def test_nowadays_seeds_two_verified_signals_consistent_with_score():
    from app.main import app
    with TestClient(app) as client:
        live = client.get("/api/venues/nowadays/live").json()
        # seed compliance_items=2 -> 2 verified open rows
        seeded = [c for c in live["compliance_queue"] if c["id"].startswith("seed-cmp-nowadays")]
        assert len(seeded) == 2
        score = client.get("/api/venues/nowadays/risk-score").json()["factors"]["compliance"]["score"]
        assert score == 49  # 2 verified open -> ~49, matches the queue
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_compliance_signal_integration.py::test_nowadays_seeds_two_verified_signals_consistent_with_score -v`
Expected: FAIL — no seeded signals exist.

- [ ] **Step 3: Idempotent backfill in `create_db_and_tables`**

```python
# backend/app/database.py — at the end of create_db_and_tables(), after ALTERs
def _backfill_compliance_signals():
    from sqlmodel import Session, select
    from app.models import ComplianceSignal
    from app.seed_data import VENUES
    with Session(engine) as session:
        for venue_id, data in VENUES.items():
            n = int(data.get("compliance_items", 0) or 0)
            if n == 0:
                continue
            existing = session.exec(
                select(ComplianceSignal).where(ComplianceSignal.venue_id == venue_id)
            ).first()
            if existing is not None:
                continue  # idempotent: never double-seed
            for i in range(n):
                session.add(ComplianceSignal(
                    id=f"seed-cmp-{venue_id}-{i}", venue_id=venue_id,
                    title="Outstanding compliance item",
                    description="Curated underwriter compliance item.",
                    provenance="underwriter_verified", severity="medium", status="open",
                ))
        session.commit()
```

Call `_backfill_compliance_signals()` at the end of `create_db_and_tables()`.

> The test expects ids prefixed `seed-cmp-nowadays`; matches `seed-cmp-{venue_id}-{i}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_compliance_signal_integration.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/database.py backend/tests/test_compliance_signal_integration.py
git commit -m "feat(compliance): idempotent seed of ComplianceSignal rows from compliance_items"
```

---

## Task 6: Calibration / non-gameability eval

**Files:**
- Test: `backend/tests/test_compliance_calibration.py`

- [ ] **Step 1: Write the test**

```python
# backend/tests/test_compliance_calibration.py
from app.underwriting.fusion import Signal, fuse, COMPLIANCE_K


def sig(p, sev="medium", st="open"):
    return Signal(provenance=p, severity=sev, status=st)


def test_low_trust_spam_cannot_beat_two_verified_items():
    verified_two = fuse([sig("underwriter_verified"), sig("underwriter_verified")], COMPLIANCE_K)
    auto_five = fuse([sig("auto_generated", "low")] * 5, COMPLIANCE_K)
    # Five low-trust auto items must NOT drag the score below two verified items.
    assert auto_five > verified_two


def test_resolving_only_ever_raises_score():
    open_two = fuse([sig("underwriter_verified"), sig("underwriter_verified")], COMPLIANCE_K)
    one_resolved = fuse([sig("underwriter_verified"), sig("underwriter_verified", st="resolved")], COMPLIANCE_K)
    assert one_resolved > open_two


def test_severity_monotonic():
    assert (
        fuse([sig("operator_reported", "urgent")], COMPLIANCE_K)
        < fuse([sig("operator_reported", "low")], COMPLIANCE_K)
    )
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd backend && python -m pytest tests/test_compliance_calibration.py -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_compliance_calibration.py
git commit -m "test(compliance): calibration + non-gameability eval for the fusion engine"
```

---

## Final verification

- [ ] **Full suite green**

Run: `cd backend && python -m pytest -q`
Expected: all pass (was 793 + new tests).

- [ ] **Manual smoke (optional)**

Start the API; `GET /api/venues/nowadays/risk-score` → compliance factor ~49; `GET /api/venues/nowadays/live` → 2 items in `compliance_queue`; resolve one via the broker route → re-GET risk-score → compliance factor rose.
