# Fraud / SIU Agent — Design

**Date:** 2026-06-04
**Status:** Approved design, pre-implementation
**Layer:** Evidence (incident → underwriting packet → claim proposal)

## Goal

Add a claims-fraud screen to the underwriting-packet flow. When a logged
incident shows SIU-style red flags (staged / inflated / exaggerated loss), the
agent produces an explainable `FraudSignal` and — when fraud risk is high —
**suppresses the silent auto-route** into a claim proposal so the incident is
held for human/SIU review instead.

This completes the "evidence integrity → fraud screen" story that
`corroboration_agent` started: corroboration detects that footage contradicts
the written account; the fraud agent scores fraud risk from that plus structural
anomalies and fires named red flags.

## Non-goals

- No carrier-side adjudication, reserving, or SIU case management.
- No application/underwriting-fraud detection (misrepresentation on the broker
  submission). Different data, different stage — out of scope here.
- No new UI in this spec (the signal is persisted and exposed on the packet; the
  broker-surface treatment is a follow-up).
- The LLM never computes the score and never mutates money or routing directly.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Fraud type | Claims fraud, incident-side (evidence stage) |
| Placement | Standalone agent, sibling to `corroboration_agent` |
| Effect | Advisory **+ gate auto-routing** (high → suppress auto-route, hold for review) |
| Red-flag families | Evidence contradiction, reporting-delay, claim-frequency, severity–evidence |
| Execution | Deterministic score + optional LLM narrative (eval-gated, deterministic fallback) |
| Timing | **Approach A** — gate at v1, confirm/re-score at v2 |

## Context: the two-packet timing

The underwriting packet is generated twice:

- **v1** — at incident creation (`app/incident_flow.py`, `create_packet_snapshot`),
  immediately followed by `maybe_auto_route_incident` (`app/claim_routing.py`).
  Available: risk signal, incident flags (injury/police/ems), prior-claim count,
  policy dates, evidence-file count. **Not yet available:** vision findings /
  corroboration (evidence isn't analyzed yet).
- **v2** — later, asynchronously, once evidence is analyzed
  (`app/main.py::_run_corroboration_and_update_packet` →
  `regenerate_packet_with_corroboration`), which sets `corroboration_status` /
  `corroboration_flags` on a fresh packet.

So the metadata red flags (reporting-delay, claim-frequency, and the
unverified-injury half of severity–evidence) are knowable at **v1, before the
auto-route gate**. The evidence-dependent flags — evidence contradiction, and
"no evidence on a high-severity claim" (which is only meaningful once the
evidence window has closed) — only exist at **v2, after the gate fired**.
Approach A honors both: screen early on metadata to gate routing, confirm later
with evidence.

## The agent

New module `app/agents/fraud_agent.py`, a pure deterministic function mirroring
`corroboration_agent.corroborate`.

### Signature

```python
def assess_fraud(
    *,
    risk_signal: dict,                 # type, severity, confidence
    incident: dict,                    # injury_observed, police_called, ems_called, occurred_at
    reported_at: datetime,
    policy: Policy | None,             # effective_date / expiry for bind/expiry proximity
    prior_claim_count: int,            # from claim_routing.count_prior_claims
    evidence_file_count: int,
    corroboration_status: str | None = None,   # None at v1
    corroboration_flags: list[str] | None = None,
) -> FraudSignal: ...
```

### Output — `FraudSignal` (frozen dataclass, JSON-serializable)

```python
@dataclass(frozen=True)
class FraudFlag:
    code: str          # e.g. "FRAUD_EVIDENCE_CONTRADICTED"
    label: str         # human-readable
    weight: float      # contribution to score
    detail: str        # why it fired, traceable to a fact

@dataclass(frozen=True)
class FraudSignal:
    score: float                 # 0..1, sum of flag weights capped at 1.0
    tier: str                    # "none" | "low" | "elevated" | "high"
    red_flags: list[FraudFlag]
    summary: str
    assessed_stage: str          # "v1" | "v2"
```

### Scoring rules (additive weights, capped at 1.0)

| Family | Rule | Weight | Stage | Flag code |
|---|---|---|---|---|
| Evidence contradiction | corroboration = CONTRADICTED | +0.40 | v2 | `FRAUD_EVIDENCE_CONTRADICTED` |
| | corroboration = PARTIAL | +0.15 | v2 | `FRAUD_EVIDENCE_PARTIAL` |
| | flag "injury reported but NOT visible" | +0.15 | v2 | `FRAUD_INJURY_NOT_VISIBLE` |
| | flag "timestamp discrepancy" | +0.15 | v2 | `FRAUD_TIMESTAMP_MISMATCH` |
| Reporting delay | logged >3d after occurrence | +0.15 | v1 | `FRAUD_LATE_REPORT` |
| | logged >7d after occurrence | +0.25 (replaces above) | v1 | `FRAUD_LATE_REPORT` |
| | reported <14d after policy bind | +0.15 | v1 | `FRAUD_NEAR_BIND` |
| | reported <14d before policy expiry | +0.10 | v1 | `FRAUD_NEAR_EXPIRY` |
| Claim frequency | prior claims ≥3 | +0.15 | v1 | `FRAUD_FREQUENCY` |
| | prior claims ≥5 | +0.25 (replaces above) | v1 | `FRAUD_FREQUENCY` |
| Severity–evidence | injury reported, no police AND no EMS | +0.15 | v1 | `FRAUD_UNVERIFIED_INJURY` |
| | high severity + zero evidence files (evidence window closed) | +0.20 | v2 | `FRAUD_NO_EVIDENCE` |

Notes:
- "Late report" and "frequency" are graduated: the higher band *replaces* the
  lower (not additive) so a single anomaly can't double-count.
- Evidence-contradiction flags are only evaluated when `corroboration_status`
  is non-None (v2).

### Tiers

| Tier | Score | Gate effect |
|---|---|---|
| `high` | ≥ 0.55 | **Suppress auto-route**, hold for review |
| `elevated` | 0.30 – 0.55 | Advisory flag; routes as normal but visible |
| `low` | 0.10 – 0.30 | Advisory only |
| `none` | < 0.10 | No flag |

Thresholds are env-overridable (mirror `CLAIM_ROUTE_AUTO_CONFIDENCE`) so they can
be tuned without a code change: `FRAUD_TIER_HIGH` (default 0.55),
`FRAUD_TIER_ELEVATED` (0.30).

### Optional LLM narrative

The deterministic scorer always produces `summary`. When a provider key is set,
an optional narrative pass may rewrite `summary` for readability via the existing
provider layer (`app/providers`), behind the same deterministic fallback and
eval-baseline gate as `risk_evaluator` / `underwriter_memo`. Score, tier, and
red_flags are never LLM-derived.

## Integration

### 1. Gate change — `app/claim_routing.py`

`maybe_auto_route_incident` computes the v1 `FraudSignal` (via a new helper that
assembles inputs the same way `recommendation_for_packet` does) before deciding:

- If `tier == "high"`: skip `create_proposal`, persist the signal on the packet,
  emit a `fraud.hold` audit event, and return the recommendation (so callers can
  still inspect it). The incident is held for review rather than routed.
- All other tiers: route exactly as today.

`route_status` is unchanged; the fraud hold is a separate gate layered *before*
proposal creation, so the confidence-based recommendation math stays intact.

### 2. v2 re-score — `app/main.py::_run_corroboration_and_update_packet`

After corroboration is computed, re-run `assess_fraud` with
`corroboration_status` / `corroboration_flags` included. Write the updated
`FraudSignal` onto the v2 packet. If it *newly* trips `high`, emit
`fraud.flagged` so an already-routed proposal surfaces for review. Idempotent:
re-running on the same inputs yields the same signal and does not duplicate audit
events.

### 3. Persistence — `app/models.py` + `app/database.py`

- New column `UnderwritingPacket.fraud_signal: dict = Field(default_factory=dict,
  sa_column=Column(JSON))`, following the `corroboration_status` /
  `corroboration_flags` precedent.
- Add the matching `_COLUMN_MIGRATIONS` allowlist entry in `app/database.py`
  (schema self-healing is an allowlist, not introspection — a new column without
  the line breaks existing-table SELECTs).
- At the read boundary, coerce `corroboration_flags` with `list(...)` /
  the `_as_list` pattern before iterating — `Column(JSON)` list fields return
  **strings** on Postgres (Neon), parsed lists on SQLite. The fraud scorer must
  not iterate a raw string.

### 4. Audit events — `app/packet_core._add_audit_event`

Emit `fraud.hold` (v1 suppression) and `fraud.flagged` (v2 escalation) following
the existing `event_type=f"{entity}.{state}"` shape.

### 5. Contract — `app/agents/fraud_agent.md`

A contract doc with the `## Current Runtime Status` section, consistent with the
other agent contracts. The fraud agent is standalone (like `corroboration_agent`)
and is **not** added to `runtime.REQUIRED_CONTRACTS` (those are the five packet
runtime agents). The contract documents the deterministic scoring rules and the
optional-narrative boundary.

### 6. Eval — `app/evals/`

Add a deterministic baseline fixture (fixed incident scenarios → expected tier +
fired flag codes) wired into the `--compare-baseline` CI gate, same as the other
agents. This is the precondition for any provider-backed narrative wiring.

## Testing plan (TDD)

Write tests first, one behavior at a time:

1. **Per-rule tests** — each red-flag rule fires with the right code/weight given
   a minimal input that trips only it; and does *not* fire otherwise.
2. **Graduated bands** — >7d replaces >3d; ≥5 prior replaces ≥3; no double-count.
3. **Tier boundaries** — scores at 0.09/0.10/0.29/0.30/0.54/0.55 map to the right
   tier (env-default thresholds).
4. **Gate suppression** — a high-fraud v1 incident produces **no** auto proposal
   and emits `fraud.hold`; a clean incident routes as before.
5. **v2 re-score** — adding a CONTRADICTED corroboration escalates the tier and
   emits `fraud.flagged`; re-running is idempotent (no duplicate events).
6. **Persistence round-trip** — `fraud_signal` survives write/read on both SQLite
   and the Postgres JSON-string path (coercion verified).
7. **Deterministic fallback** — with no provider key, scoring and summary are
   fully deterministic; the eval baseline matches.

## Open questions / tuning

- Starting weights and the `high ≥ 0.55` cutoff are a defensible first guess, not
  calibrated against real data. The eval fixture pins current behavior; tuning is
  a follow-up once there are labeled incidents.
- Whether a v2 `high` should *retract* an already-created proposal (vs only flag
  it) is deferred — first pass flags only, to avoid yanking a proposal a broker
  may already be working.
