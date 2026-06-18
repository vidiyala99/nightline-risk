# Task: --refresh flag + prior liquor loss for defense demo

## Summary
Extended `backend/scripts/seed_defense_demo.py` with a `--refresh` capability
and a seeded prior closed liquor loss, both TDD-driven. All tests green; no
collateral breakage in the adjusting suites.

## A. `--refresh`
`seed(session, *, refresh: bool = False)`; `__main__` parses `"--refresh" in sys.argv`.
When `refresh=True`, `_delete_demo_artifacts(session)` + `_delete_prior_loss(session)`
run before the existing skip-if-exists check, then commit, so the recreated claim
picks up the capped (today-or-earlier) loss_date and an aligned packet timeline.
Without `--refresh`, the original skip-if-exists behavior is preserved (and the
skip path now also ensures the prior loss exists so the band is non-zero).

### Rows `_delete_demo_artifacts` removes (children before parents, for PG FKs)
For `incident_id == "inc-defense-demo"`:
1. `Claim` (holds `defense_package_id` with ON DELETE RESTRICT → must go first)
2. `CitationRecord` rows (by `packet_id`) — written by `create_packet_snapshot`
3. `UnderwritingPacket` row(s) (by `incident_id`)
4. `SourceRecord` rows (the `source_id`s referenced by those citations)
5. `AuditEvent` rows for `entity_type="underwriting_packet"`, `entity_id=packet.id`
   (`packet.generated`, and any validation/rubric-gate events)
6. `EvidenceAnalysis` rows (by `incident_id`) — children of EvidenceFile
7. `EvidenceFile` rows (by `incident_id`)
8. `IncidentRecord(INCIDENT_ID)`

`RubricVersion("demo-rubric-v1")` is intentionally NOT deleted — it is shared/
idempotent (`_ensure_rubric_version` reuses it). `_delete_prior_loss` removes the
prior `Claim(incident_id="inc-defense-demo-prior")` plus its `ClaimPayment` and
`ReserveChange` children.

## B. Prior closed liquor loss
`_seed_prior_loss(session, policy, coverage)` — idempotent on
`incident_id="inc-defense-demo-prior"`, distinct `carrier_claim_number="BW-2026-PRIOR"`.
Built via the authentic service chain:
- `file_fnol` with a PAST `date_of_loss` (= `min(eff+2d, today-1d)`, clamped ≥ eff,
  always inside term and never future)
- `record_carrier_reserve` → $7,500.00
- `record_payment` indemnity → $6,500.00 (auto-advances reserved → settling)
- `close_claim(disposition="paid", final_indemnity=$6,500.00)` → `closed_paid`

Result: `venue_loss_run(session, "nowadays")` liquor `by_coverage_line` entry has
`incurred = 6500.00` (paid 6500 − recoveries 0 + reserve 0 at close). No `proposal_id`,
so `close_claim`'s proposal-settlement branch is skipped.

## Tests — `backend/tests/test_seed_defense_demo.py`
1. `test_seed_caps_date_of_loss_to_today` — demo claim exists, `date_of_loss <= today`.
2. `test_refresh_recreates_single_claim_with_capped_date` — set stale future date,
   `seed(refresh=True)`, assert exactly ONE demo claim with `date_of_loss <= today`.
3. `test_prior_loss_makes_liquor_band_nonzero` — `Decimal(incurred) > 0` on liquor line.

Reds were confirmed first (test 2 → `TypeError: unexpected kwarg 'refresh'`;
test 3 → `Decimal('0.00') > 0` failed). After implementation, green.

### Commands + output
```
python -m pytest tests/test_seed_defense_demo.py -v   → 3 passed
python -m pytest tests/test_seed_defense_demo.py tests/test_adjusting.py tests/test_adjusting_api.py -q
  → 22 passed
```

## Concerns
- `ClaimPayment.recorded_by` / `ReserveChange.recorded_by` are FKs to `userrecord.id`;
  the prior loss uses `"seed_demo"`, which is not a real user. SQLite doesn't enforce
  FKs by default (matches existing `test_adjusting_api` using `filed_by="u-brk"`).
  Against prod Postgres with FK enforcement this could fail if `seed_demo` isn't a user
  row — worth confirming a `seed_demo` UserRecord exists before running `--refresh` on
  Railway. The original script's `file_fnol(filed_by="seed_demo")` already had this
  same dependency, so behavior is unchanged.
- The original `datetime.utcnow()` at the EvidenceAnalysis insert remains (pre-existing,
  out of scope); my new reserve `received_at` uses `now_utc()` per convention.
