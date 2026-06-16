# Actuarial Experience-Rating + Loss-Development Layer

**Status:** Blueprint (approved to build — "product + portfolio"). Sequenced *after* the AgentRun ledger track (`app/agents/ledger.py`).
**Date:** 2026-06-16
**Motivation:** Promote loss data we already capture into two *real but minimal* actuarial primitives, riding the reproducibility spine (`AgentRun` + `AIProvenance`). Benchmarked against Tesora ("Frontier AI for Actuaries": loss modeling, on-leveling, rating factors, ILFs, reproducible audit trail). We do **not** clone Tesora; we add the two highest-leverage, codebase-native primitives.

## Where we are today (the gap)

- **Pricing** (`app/underwriting/pricing.py`): deterministic `venue_type → base rate` table × tier × per-carrier multipliers + surplus-lines tax/fee/commission accounting. No loss-cost, no frequency×severity, no expense/permissible loss ratio.
- **Scoring** (`app/underwriting/scoring.py`, `fusion.py`): hand-weighted additive heuristic; only quasi-actuarial moves are exponential recency decay + sqrt capacity normalization. **No constant fitted to loss data.**
- **Reserving** (`models.Claim.current_reserve`, `ReserveChange`, `ClaimPayment`; `services/adjusting.py:reserve_hint`): reserves carrier-relayed/manual; one naive avg-cost-per-claim hint. No development method.
- **Experience use:** loss runs ingested (`extraction/loss_run_parser.py`, `services/loss_run.py`) but used quantitatively in exactly ONE place — `services/renewals.py:compute_loss_experience` → single untrended, uncredibility-weighted one-year loss ratio → `pricing.loss_adjustment_from_loss_ratio` (4-band step).
- **Calibration** (`evals/calibration.py`): backtests the AI *claim-filing recommender* (Brier, in-band payout), NOT a risk/pricing model.
- **Classical primitives** (triangles, tail factors, credibility, trend, ELR, ultimate projection, percentile reserves, capital, reinsurance): ALL absent.

## Scope

**In:** (A) trended credibility-weighted experience-rating modifier; (B) volume-weighted chain-ladder loss-development view (advisory ultimate per coverage line); reproducibility wiring; one read API.
**Non-goals (named):** on-leveling / rate-change indices, ILFs, fitted tail factors, stochastic/percentile reserves (Mack/bootstrap/BF), Bühlmann-Straub credibility, auto-setting reserves, frequency/severity split, large-loss capping.

## (A) Experience mod — math

Constants (versioned; bump `EXPERIENCE_LOGIC_VERSION` on any change):
- `ANNUAL_TREND_RATE = 0.05`, `FULL_CREDIBILITY_CLAIMS = 82` (frequency credibility, book-realistic — **the dominant assumption, surfaced for actuarial challenge**), `EXPECTED_LOSS_RATIO = 0.65`, `MOD_FLOOR = 0.75`, `MOD_CAP = 1.75`.

Per policy lineage, multi-year `(year, incurred, earned_premium, claim_count)`:
1. Trend: `trended_i = incurred_i * (1+TREND)**years_back_i` (integer `Decimal` power → exact).
2. `experience_LR = Σ trended / Σ earned` (0 if earned==0).
3. `Z = min(1, sqrt(N / FULL_CREDIBILITY_CLAIMS))` via `Decimal.sqrt()`.
4. `credible_LR = Z*experience_LR + (1-Z)*ELR`; `mod = clamp(credible_LR/ELR, FLOOR, CAP)`.

No history → `Z=0` → `mod=1.00` exactly. Quantize mod to `0.01` before it enters pricing.

**62-cell safety:** the mod flows **only** through `build_quote_for_carrier`'s existing `loss_adjustment` kwarg, on the **renewal path**. New-business (`loss_adjustment=None`) and `PremiumCalculator.calculate_quote` (the 62 cells) are structurally untouched.

## (B) Chain-ladder — math

Constants: `DEVELOPMENT_LOGIC_VERSION`, `TAIL_FACTOR = 1.00` (no fitted tail — non-goal), `MIN_LINK_DENOMINATOR = 0.01`, `MIN_CREDIBLE_CLAIMS ≈ 10`.

- Grain: accident year (`Claim.date_of_loss`) × development age (years). One triangle per `coverage_line`.
- Cell = incurred-at-age, reconstructed from stored data: `Σ paid(indemnity+expense ≤ as_of) − Σ recovery(≤ as_of) + reserve_as_of` where `reserve_as_of` = latest `ReserveChange.to_amount` with `received_at ≤ as_of`. (Mirrors `loss_run._incurred` but evaluated at past valuation dates. All typed `Numeric`/`date` columns → **no JSON-string coercion needed.**)
- Volume-weighted link `f_k = Σ_AY cell[AY][k+1] / Σ_AY cell[AY][k]` over AYs with both cells; `1.0` if no denominator.
- `CDF_k = TAIL_FACTOR * Π_{j≥k} f_j`; `ultimate[AY] = latest_incurred * CDF`; `ultimate_by_line = Σ_AY`.
- **Graceful degradation:** 1 claim/1 AY → all `f_k=1.0` → ultimate==incurred. Always return `claim_count`, `accident_year_count`, `is_credible`, `caveat`. Omit zero-claim lines.

## Design calls

- **Compute-on-read; persist nothing new** → no table, no `_COLUMN_MIGRATIONS`, no FK-flush, no JSON coercion. Inputs are already the actuarial source of truth.
- **Pure DB-free math modules** (`app/underwriting/experience_rating.py`, `loss_development.py`) + thin service adapters (`services/renewals.py`, new `services/loss_development_data.py`).
- **Reproducibility:** adapters wrap computation in `record_agent_run(agent_kind="actuarial", contract_version=<LOGIC_VERSION>, inputs=<hashed>)` and embed `make_provenance(provider="deterministic")` on the payload. `Z` reused as the run's `confidence`. Same loss data + version → same number + same `input_hash`; changing a constant REQUIRES bumping the version string.

## Integration

- (A) → renewal re-pricing at the 3 call sites of `loss_adjustment_from_loss_ratio` (`api/v1/placement.py:~459`, `api/v1/renewals.py:~76`, `~125`); surface `credibility_z`/`claim_count` in YoY payloads. Keep the old fn (deprecated docstring) one release.
- (B) → `recommender._rate_adequacy` gains optional `ultimate` (uses developed ultimate ÷ indicated when present; identical when `None`); `adjusting.reserve_hint` gains advisory adequacy keys when `is_credible` — **never auto-sets `current_reserve`.**
- Read API: `GET /api/venues/{venue_id}/actuarial` → `{experience_mod, development_triangle, ultimate_by_line}`, scope-gated via `accessible_venue_ids`, money/factors as strings, zero-claim venue → neutral 200 (`mod=1.00`, empty triangle).

## Build sequence (TDD, each shippable to main)

1. `experience_rating.py` (pure math) — DB-free tests.
2. `loss_development.py` (chain-ladder, pure) — DB-free tests.
3. DB adapters + `AgentRun` reproducibility wiring — clean-DB fixture, assert input-hash stability.
4. Wire (A) into renewal re-pricing — **62-cell guard**; assert new-business unchanged.
5. Wire (B) into recommender + advisory `reserve_hint` — back-compat defaults `None`; never writes reserves.
6. `GET /api/venues/{id}/actuarial` read view — scope-gated, money-as-string.

## Disclaimer (must appear in module docstrings, API response, UI)

Decision-**support**, not filed rates and not booked reserves. The mod informs broker re-pricing judgment (not a state-filed loss-cost mod); the ultimate informs reserve-adequacy review (carriers set reserves via `adjusting.adjust_reserve`). Every number is traceable to its loss inputs + a versioned method — that reproducible audit trail, not sophistication, is the differentiation.
