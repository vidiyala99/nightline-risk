# Signal Fusion Engine — Compliance as First Adopter

**Date:** 2026-05-29
**Status:** Design approved, pending implementation plan
**Scope:** Sub-project ①+② of the signal-fusion program (see "Program context")

## Problem

A venue's Risk Profile can report **Compliance · HIGH RISK · 40/100** while the
operator's Compliance screen shows **"All Clear."** Root cause: the compliance
factor scores a static seed integer (`venue["compliance_items"]`) while the
operator screen reads the live, in-memory `compliance_queue` — two independent
data stores that never reconcile. An interim fix made the factor read
`len(compliance_queue)`, but that is a single unweighted source: a noisy
camera's auto-generated item counts exactly the same as an underwriter-verified
liquor-license violation.

The product thesis is to fuse **live + existing + historical** signals into
better scores, claims, and reports. Doing that *well* requires encoding **how
much each signal should be trusted** (provenance) and **how much it matters**
(severity, status), not just counting items.

## Goals

- The compliance factor and the operator's compliance view read **one source**,
  so they cannot disagree.
- Each signal contributes by **provenance × severity × status**, so noise
  (auto-generated, low confidence) nudges the score while verified items move it.
- Compliance gains **persistence and history** (it is currently transient
  in-memory state lost on restart).
- The scoring stays **deterministic** (no wall-clock recency) — reproducible and
  trivially eval-testable, matching the existing incident model.
- Establish a reusable **fusion engine** that incidents/operational can adopt
  later (③b–d) without modification.

## Non-goals (YAGNI / later specs)

- Migrating incident/operational/business factors onto the engine (③b–d).
- Recency/time-decay weighting.
- Surfacing provenance in the UI, claims-defense package, or underwriting memo
  (sub-project ④). This spec computes the score from signals; the *numbers*
  render through the existing UI unchanged.

## Program context

This is the foundation of a larger signal-fusion layer, decomposed as:
① Signal model + provenance taxonomy · ② Fusion/weighting engine ·
③ Migrate factors (compliance → incidents → operational → business) ·
④ Provenance in downstream artifacts · ⑤ Calibration/eval harness.

This spec delivers **①+② as a vertical slice through compliance** — the engine
is proven against one real factor before the others migrate. Incidents already
prove the *pattern* (`_incident_weight`); compliance proves the *abstraction*.

## Architecture

Storage is typed per-factor; **generality lives in the engine**, which consumes
a normalized `Signal` interface and never imports a table. Three new units:

### 1. `ComplianceSignal` table (`app/models.py`)

Mirrors `IncidentRecord`. Replaces the transient in-memory `ComplianceItem`
queue as the system of record for compliance.

```python
class ComplianceSignal(SQLModel, table=True):
    id: str                      # PK
    venue_id: str                # indexed
    title: str
    description: str
    provenance: str              # Literal: auto_generated|operator_reported|underwriter_verified|ingested
    severity: str                # Literal: low|medium|high|urgent
    status: str                  # Literal: open|resolved
    created_at: datetime         # default_factory=now_utc (app.time)
    resolved_at: datetime | None = None
    evidence_ref: str | None = None   # storage key for uploaded proof
```

Conventions (per CLAUDE.md):
- `default_factory=now_utc` from `app.time`.
- `status` transitions go through `_transition_compliance_signal(session, row, *, to, actor_id, metadata)` calling `assert_valid_transition(...)`, with `COMPLIANCE_SIGNAL_TRANSITIONS = {"open": {"resolved"}, "resolved": {"open"}}` declared in `app/lifecycles.py`.
- Each transition emits an audit event via `_add_audit_event` with `event_type="compliance_signal.{to_state}"`.

### 2. `Signal` interface (`app/underwriting/fusion.py`)

The normalized shape the engine scores. Factor-agnostic.

```python
@dataclass(frozen=True)
class Signal:
    provenance: str
    severity: str
    status: str
```

Each factor provides an adapter that the engine calls; for compliance:
`compliance_signals_for(venue_id: str, session) -> list[Signal]` (selects
`ComplianceSignal` rows for the venue and maps each to a `Signal`). Incidents
get `incident_signals_for(...)` in a later spec — a thin adapter, since
`IncidentRecord` already carries severity and status.

### 3. Fusion engine (`app/underwriting/fusion.py`, deterministic)

```python
PROVENANCE_WEIGHT = {"underwriter_verified": 1.0, "ingested": 0.9, "operator_reported": 0.6, "auto_generated": 0.3}
SEVERITY_WEIGHT   = {"urgent": 2.5, "high": 1.5, "medium": 1.0, "low": 0.5}
STATUS_WEIGHT     = {"open": 1.0, "resolved": 0.2}

def signal_weight(s: Signal) -> float:
    return PROVENANCE_WEIGHT[s.provenance] * SEVERITY_WEIGHT[s.severity] * STATUS_WEIGHT[s.status]

def fuse(signals: list[Signal], k: float) -> int:   # k = per-factor decay constant
    load = sum(signal_weight(s) for s in signals)
    return max(0, min(100, round(100 * math.exp(-load / k))))
```

`COMPLIANCE_K = 2.8` reproduces the existing anchors. The weight tables are the
single, reviewable place trust/severity policy lives. Unknown enum values raise
(fail loud), consistent with `get_risk_score("nonexistent")` raising `ValueError`.

**Calibration anchors** (compliance, `k=2.8`):

| Signals | load | score | meaning |
|---|---|---|---|
| none | 0 | 100 | clean |
| 1 verified open (med) | 1.0 | ~70 | one real item (matches old `1 item → 70`) |
| 1 auto-generated open (urgent) | 0.75 | ~76 | camera noise nudges, can't tank |
| 2 verified open (med) | 2.0 | ~49 | ~old `2 items → 40` |
| 1 verified resolved (med) | 0.2 | ~93 | resolving raised the score |

## Data flow

1. **Live queue = view over open signals.** `OperatorComplianceScreen` and
   `/live`'s `compliance_queue` read `ComplianceSignal WHERE venue_id=? AND
   status='open'`. The operator view and the score read the same rows.
2. **Camera-anomaly path** (`live_state.process_events`): on an anomaly above
   threshold, insert a `ComplianceSignal` (`provenance=auto_generated`, severity
   from the anomaly, `status=open`) instead of appending an in-memory item. The
   event path is invoked by API endpoints that hold a DB session, which threads
   through; the `MAX_AUTO_GENERATED_COMPLIANCE_ITEMS` cap is enforced by counting
   open `auto_generated` rows for the venue.
3. **Resolve path** (`resolve_compliance_item` / compliance upload route):
   `_transition_compliance_signal(to="resolved", evidence_ref=…)` + audit event;
   the score rises because resolved weight is 0.2.
4. **Scoring path** (`get_risk_score`): when a session exists and the venue is
   not a prospect, the compliance factor is `fuse(compliance_signals_for(...),
   k=COMPLIANCE_K)`. This **supersedes the interim `len(compliance_queue)`
   override** added previously.
5. **Fallback (no regressions):** no session (unit fixtures, headless callers) →
   fall back to the existing `_score_compliance(compliance_items)` step
   function, exactly as incidents fall back to `incident_count`. The step
   function is retained solely as the session-less baseline.

## Migration & seed

- `seed_data` `compliance_items: N` (and any `seed_compliance` lists) seed **N
  `ComplianceSignal` rows**, `provenance=underwriter_verified` for curated demo
  items. **Nowadays** (`compliance_items: 2`) → 2 verified rows → factor ~49 and
  the operator queue shows 2 items: consistent end to end.
- `compliance_items` remains in the seed dicts only as the session-less fallback.
- Seeding is idempotent (per demo-data conventions); the new table is created via
  the existing schema-init path. An idempotent backfill seeds signals for venues
  that have `compliance_items > 0` but no rows yet.

## Error handling

- Any DB error while reading signals is caught in `get_risk_score`, which falls
  back to the baseline path — the same pattern as the incident `live_rows = None`
  fallback.
- Unknown provenance/severity/status enum values raise `KeyError` at scoring
  time (fail loud) — guarded by the lifecycle `Literal`s on write.
- Invalid status transitions raise `InvalidTransitionError` → mapped to 422 by
  the compliance router (existing `_map_service_error` pattern).

## Testing & eval

- **Unit (`fusion.py`):** `signal_weight` across provenance×severity×status;
  `fuse` against every calibration anchor above (deterministic exact values).
- **Lifecycle:** open→resolved valid; invalid transitions rejected; audit event
  emitted with the expected `event_type`.
- **Integration (HTTP):** create signals → `/risk-score` compliance reflects
  them; resolve via the API → score rises monotonically; `/live` queue equals
  the open signals; a camera-anomaly event creates an `auto_generated` signal and
  the score nudges (~76) rather than tanks (40).
- **Calibration / non-gameability** (eval-harness proof): a scenario table
  asserting, e.g., that 5 `auto_generated` low items cannot drag the score below
  what 2 `underwriter_verified` items reach, and that resolving items only ever
  raises the score.
- **Regression:** the session-less fallback keeps the existing suite green; the
  two interim compliance tests in `test_risk_score_live_delta.py`
  (`*_reads_empty_live_queue_as_clean`, `*_tracks_live_queue_length_not_seed`)
  are rewritten against the signal model.

## Acceptance criteria

1. With a session, the compliance factor is computed by `fuse()` over a venue's
   `ComplianceSignal` rows; the operator `compliance_queue` is the open subset of
   those same rows.
2. Resolving a compliance item raises the venue's compliance factor.
3. An auto-generated camera item lowers the factor modestly (≈76 for a single
   urgent one), never to the verified-item floor.
4. Session-less callers are unchanged (existing suite green).
5. Seed data is consistent: Nowadays shows the same item count in the score
   rationale and the operator queue.
