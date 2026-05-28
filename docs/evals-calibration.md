# Calibration: predictions vs reality

Companion to the synthetic-scenario eval harness (`backend/app/evals/scorers.py`).
Where scorers measure agent output against gold-standard expectations on
hand-crafted inputs, **calibration measures historical recommender predictions
against what brokers actually approved and carriers actually paid.**

## Why this exists

The eval harness keeps the agent from regressing on a fixed test set. It
cannot tell you whether the `claim_recommendation` block — the EV math the
broker sees on `/underwriter/[id]` — is actually calibrated to reality. If
the recommender says "90% paid-out probability" but real claims paid 50% of
the time, the eval harness will still report 21/21 = 100% because none of
the scenarios test that loop.

Calibration closes that gap, using data the system is already capturing.

## The three metrics

### 1. Broker agreement

Joins `UnderwritingPacket` → `ReviewDecision` (latest per packet) and
compares `claim_recommendation.should_file` to the broker's `decision`.
`needs_more_info` is excluded — that's a deferral, not a disagreement.

Output:
- `agreement_rate` = (file_approved + nofile_blocked) / total
- Confusion matrix: file_approved / file_blocked / nofile_approved / nofile_blocked

**Signal:** if `agreement_rate < 0.7`, the recommender's verdict is
materially out of step with broker judgment. Investigate which scenarios
cause the disagreements and consider re-baselining.

### 2. Outcome in band

For closed-paid claims, checks whether the actual payout (`final_indemnity`,
or `indemnity_paid_to_date` as a fallback) fell inside the recommender's
`[expected_payout.low_usd, .high_usd]` band.

Output:
- `in_band_rate` = in_band / total_closed_with_prediction
- Above-band count (recommender under-predicted payout)
- Below-band count (recommender over-predicted payout)

**Signal:** a well-calibrated payout distribution lands ≥80% of closed
claims in-band. Below 50% means the band itself is miscalibrated.

Denied claims and open claims are excluded — denied = $0 paid, which the
probability metric handles; open claims have no settled number yet.

### 3. Probability calibration

For every packet with a predicted `probability` AND a closed outcome
(paid OR denied), bucket by probability decile and compute the actual
paid rate per bucket. This is reliability-diagram data.

Output:
- `overall_brier_score` = mean squared error of predicted probability vs
  actual outcome (1.0 for paid, 0.0 for denied). Lower is better; 0 = perfect.
- Per-bucket `paid_rate`, `bucket_midpoint`, `calibration_gap` (signed)

**Signal:** a well-calibrated recommender has `calibration_gap ≈ 0` for every
bucket. Large positive gaps mean predictions are too pessimistic for that
probability range; large negative gaps mean too optimistic.

## How to run

Local (against your dev SQLite):

```powershell
cd backend
python -m scripts.run_calibration
```

Against Railway Postgres (read-only, safe):

```powershell
$env:DATABASE_URL = "<DATABASE_PUBLIC_URL>"
cd backend
python -m scripts.run_calibration
```

Outputs:
- `backend/app/evals/results/calibration.json` — machine-readable
- `backend/app/evals/results/calibration.md` — human-readable

## When this data exists

Calibration data requires:
- **Broker agreement** — at least one `ReviewDecision` with `decision ∈
  {approved, blocked}`. Available now.
- **Outcome in band** — at least one closed-paid `Claim` linked to a
  `ClaimProposal` whose `packet_id` has a `claim_recommendation`. Available
  once demo seeds run far enough through the lifecycle.
- **Probability calibration** — at least one closed claim (paid or denied)
  with a packet that has `claim_recommendation.probability`. Same as above.

On a fresh DB, all three metrics will report zeros / nulls. That's expected
and the report says so.

## Not yet wired

- **CI gate**: the existing `evals` CI job runs `--compare-baseline` on the
  synthetic harness. Calibration is _not_ in CI today because it depends on
  real DB state, which CI doesn't have. Possible future: snapshot calibration
  numbers against prod weekly, alert on drift.
- **Frontend surface**: the `/evals` page reads `public/eval-baseline.json`.
  A `/evals/calibration` tab reading `calibration.json` would surface this
  to brokers (or stay internal). Not built yet.
- **Re-training loop**: calibration measures the gap; it doesn't yet feed
  back into the recommender to close it. Manual: read the report, adjust
  `app/providers/deterministic.py`'s scoring, re-baseline. Automated:
  out of scope without a real ML stack.

## Architecture

- `backend/app/evals/calibration.py` — pure functions taking a `Session`,
  returning dataclasses. No I/O, no side effects.
- `backend/scripts/run_calibration.py` — CLI: opens session, runs all three,
  writes JSON + markdown reports.
- `backend/tests/test_calibration.py` — 14 tests against in-memory SQLite
  seeded with synthetic packets/decisions/claims. Disables FK enforcement
  (SQLite default) so a `Claim` can be created without the full
  Submission → CarrierQuote → Policy chain.
