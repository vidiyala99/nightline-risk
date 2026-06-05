# Fraud / SIU Agent Contract

## Current Runtime Status

`app/agents/fraud_agent.py::assess_fraud` is a **deterministic** scorer (no LLM in
the score path), a sibling to `corroboration_agent`. It runs at v1 from
`claim_routing.maybe_auto_route_incident` (metadata flags; a `high` tier
suppresses auto-routing and emits `fraud.hold`) and re-runs at v2 from
`main._run_corroboration_and_update_packet` (adds evidence flags; emits
`fraud.flagged` the first time an incident reaches high fraud risk). It is
**not** registered in `runtime.REQUIRED_CONTRACTS` (those are the five packet
runtime agents).

Both call sites treat scoring as **advisory and best-effort**: a scorer or query
fault is logged and never blocks incident creation (v1) or the vision pipeline
(v2). The `fraud.flagged` emission is idempotent — it fires only when no prior
`fraud.hold` / `fraud.flagged` audit event exists for the incident.

An optional LLM narrative may rewrite `FraudSignal.summary` via the provider
layer behind the deterministic fallback and the eval baseline gate. Score, tier,
and red_flags are never LLM-derived.

## Red flags

- Evidence contradiction (v2): CONTRADICTED 0.40, PARTIAL 0.15, injury-not-visible
  0.15, timestamp-mismatch 0.15. (Substring anchors are shared constants exported
  from `corroboration_agent` — `INJURY_NOT_VISIBLE_FLAG`,
  `TIMESTAMP_DISCREPANCY_FLAG` — so a reword stays in sync.)
- Reporting delay (v1): >3d 0.15, >7d 0.25; near-bind 0.15; near-expiry 0.10.
- Claim frequency (v1): >=3 0.15, >=5 0.25.
- Severity-evidence: unverified-injury 0.15 (v1); high-severity-no-evidence 0.20 (v2).

## Tiers

`high` >= 0.55 (gates routing), `elevated` >= 0.30, `low` >= 0.10, else `none`.
Thresholds via `FRAUD_TIER_HIGH` / `FRAUD_TIER_ELEVATED` / `FRAUD_TIER_LOW`.
