# Phase 4 — Renewals + Experience Rating (design)

**Date:** 2026-05-24
**Status:** Design approved; implementation plan pending.
**Predecessor:** [`2026-05-21-broker-platform-phases-1-3.md`](2026-05-21-broker-platform-phases-1-3.md) §8 lists Phase 4 (Renewals).
**ADR:** [0004-broker-platform-and-claim-vocabulary-split](../../adr/0004-broker-platform-and-claim-vocabulary-split.md)

---

## 0. What this is

A renewal is the broker re-placing coverage for a venue whose policy is expiring. The naïve version is CRUD ("clone the expiring submission"). This phase instead builds the **experience-rating feedback loop**: the prior term's *actual claims* re-price the renewal, so well-run venues earn cheaper coverage and loss-heavy venues pay more. That loop is the "proprietary underwriting" thesis — pricing on realized losses, not a blanket market rate.

A renewal does **not** directly create a Policy. It creates a renewal **Submission** that flows through the existing Phase 1–3 submit → quote → bind pipeline; the experience rating makes the *quotes* reflect the venue's track record. A new Policy exists only once a quote binds.

---

## 1. Two independent pricing factors

The renewal price combines two distinct signals already half-present in `pricing.py`:

| Factor | Direction | Source | Drives |
|---|---|---|---|
| **Risk score → tier** | Forward-looking (predicted risk) | `get_risk_score` (incidents, compliance, live signals) | `TIER_MULTIPLIERS` (A=0.7 … D=2.5) — *exists today* |
| **Loss experience → loss_adjustment** | Backward-looking (realized losses) | Prior policy's `Claim` rows | `loss_adjustment` band (0.90 … 1.60) — *new in Phase 4* |

They are correlated but not identical: a venue can look risky yet have no claims, or look clean yet have one catastrophic lawsuit. Pricing on both is more accurate than either alone.

---

## 2. Experience-rating model (loss-ratio banding)

```
incurred       = Σ over the policy's claims of (total_incurred
                 if set else current_reserve + indemnity_paid
                 + expense_paid − recoveries)
earned_premium = policy.annual_premium
loss_ratio     = incurred / earned_premium      # 0 when earned_premium == 0 → adjustment 1.00

loss_ratio  < 0.40  → loss_adjustment 0.90   (clean book, earn a credit)
0.40 ≤ lr  < 0.70  → 1.00   (expected range)
0.70 ≤ lr  < 1.00  → 1.25   (deteriorating)
lr ≥ 1.00          → 1.60   (lost money on them)
```

Money is `Decimal` throughout (`app.money`). Guard: `earned_premium == 0` → `loss_ratio = 0` → adjustment `1.00` (never divide by zero).

---

## 3. Architecture — Approach A (override seam)

The banding lives as a **pure function** in `pricing.py`; the quote engine gets an **optional override** so the new-business path is byte-for-byte unchanged.

- `pricing.py`:
  - `loss_adjustment_from_loss_ratio(loss_ratio: Decimal) -> Decimal` — pure banding (§2).
  - `build_quote_for_carrier(..., loss_adjustment: Decimal | None = None)` — when `None`, falls back to the existing `_loss_adjustment_from_risk(risk_score)` (today's behavior). When provided, uses the override.
- **Test safety:** the 62 `test_phase_1.py` characterization cases call `build_quote_for_carrier` without the new param, so they hit the unchanged fallback path and stay green. This is the explicit reason for the override rather than computing claims inside pricing (which would couple the stateless pricing module to the DB).

Rejected alternatives: passing raw claims into pricing (couples pricing to the Claim model + session); post-multiplying premium in the service (breaks the per-line `loss_adjustment` breakdown that `FullQuote` / `CarrierQuote.inputs_snapshot` already model and that Phase 7 reproduction depends on).

---

## 4. Components

### 4.1 `backend/app/services/renewals.py`

- `@dataclass LossExperience` — `incurred: Decimal`, `earned_premium: Decimal`, `loss_ratio: Decimal`, `claim_count: int`.
- `compute_loss_experience(session, policy_id) -> LossExperience` — aggregates the policy's `Claim` rows per §2. Read-only.
- `create_renewal(session, policy_id, *, effective_date, actor_id) -> Submission` — atomic single function:
  1. Load prior `Policy`; require status `active` (else `RenewalsError`).
  2. New `Submission` in `open` status: carry forward `coverage_lines` + `requested_limits` from the prior policy's `terms_snapshot`; set `prior_policy_id`; new `effective_date`.
  3. Emit `_add_audit_event` (`event_type="submission.renewal_created"`).
  4. Return the Submission. Does **not** auto-submit and does **not** touch the prior policy's status (see 4.2). Does not commit — caller owns the transaction.
- `RenewalsError(Exception)` — typed service error.

### 4.2 Prior-policy transition

The prior policy moves `active → expired` (or `non_renewed`) through the **existing** transition helper, as a **separate explicit broker action**, not bundled into `create_renewal`. Rationale: a renewal and its prior policy legitimately overlap in time (new term bound before old expires), so "renewal created but prior still active" must be representable. Both `expired` and `non_renewed` already exist in `POLICY_TRANSITIONS`.

### 4.3 Quote-path wiring (`backend/app/api/v1/placement.py` ~line 343)

Where `build_quote_for_carrier` is called: if `sub.prior_policy_id` is set →
`compute_loss_experience(session, sub.prior_policy_id)` → `loss_adjustment_from_loss_ratio(...)` → pass as the `loss_adjustment` override. New business (`prior_policy_id is None`) → no override → unchanged.

### 4.4 API — `backend/app/api/v1/renewals.py`

- `GET /api/renewals/due?within_days=60` (broker) — active policies with `expiration_date` within the window, each with a loss-experience summary (`loss_ratio`, `claim_count`, projected `loss_adjustment`). Sorted by soonest expiry.
- `POST /api/policies/{id}/renew` (broker) — body `{effective_date}`; calls `create_renewal`; returns the new Submission **plus a YoY context block**: prior premium + prior terms vs. carried-forward terms + the computed `loss_adjustment` and `loss_ratio`.
- Error mapping per convention: `RenewalsError → 400`, `InvalidTransitionError → 422`, structured `{error, message}`.
- Router mounted in `main.py` with `prefix="/api"` alongside the other v1 routers.

### 4.5 Frontend

- `/renewals` (`frontend/src/app/renewals/page.tsx`) — broker surface. "Renewals due" table: policy, venue, expiry date, prior loss ratio, projected adjustment, and a **Renew** button → `POST /api/policies/{id}/renew`, then routes to the created submission. Broker-gated (mirrors `/claims` gating).
- **YoY context strip** on the renewal submission view: prior-term premium/terms vs. renewal terms + the experience adjustment, so the operator-facing story ("you earned a credit" / "losses drove this up") is legible.
- `frontend/src/lib/renewals.ts` — typed API client (`renewalsApi.due`, `renewalsApi.renew`) following the `claims.ts` / `policies.ts` pattern.

---

## 5. Data flow

```
Broker opens /renewals
  → GET /api/renewals/due?within_days=60
      → for each expiring active policy: compute_loss_experience()
  ← table with loss ratios + projected adjustments

Broker clicks Renew on policy P
  → POST /api/policies/P/renew {effective_date}
      → create_renewal(): new Submission S (open, prior_policy_id=P, terms carried forward)
  ← Submission S + YoY context

Broker drives S through the EXISTING pipeline (submit → request quotes):
  → quote preview / generation at placement.py
      → S.prior_policy_id set → compute_loss_experience(P)
        → loss_adjustment_from_loss_ratio() → override into build_quote_for_carrier()
  ← carrier quotes priced WITH experience rating

Broker binds a quote (existing bind_quote) → new Policy for next term
Broker separately transitions prior policy P: active → expired / non_renewed
```

---

## 6. Error handling

- Renew a non-`active` policy → `RenewalsError` → 400.
- Unknown policy id → 404.
- Illegal prior-policy transition → `InvalidTransitionError` → 422.
- `earned_premium == 0` → adjustment 1.00 (no crash, no surcharge).
- Money parsing/typing stays in `Decimal`; JSON money as strings per project convention.

---

## 7. Testing

- `backend/tests/test_renewals_service.py`:
  - `compute_loss_experience` — incurred aggregation across claims (open reserves + paid − recoveries; `total_incurred` short-circuit), zero-claims case, zero-earned-premium guard.
  - `loss_adjustment_from_loss_ratio` — each band boundary (0.39/0.40, 0.69/0.70, 0.99/1.00).
  - `create_renewal` — carry-forward of coverage_lines + requested_limits, `prior_policy_id` set, `open` status, audit event emitted, non-`active` policy rejected.
- `backend/tests/test_renewals_api.py` — `GET /due` windowing + summary shape; `POST /renew` happy path + YoY block + 400/422 mapping; broker gating.
- **Regression guard:** `test_phase_1.py` (62 pricing cases) must stay green — they exercise the `loss_adjustment=None` fallback path. Add one test asserting `build_quote_for_carrier` with an explicit override multiplies the per-line premium as expected.
- Frontend: a Playwright journey (renewals-due → renew → land on submission with YoY strip) is in scope for the full-stack slice.

---

## 8. Out of scope (later)

- The Phase 6 `LossRun` table — Phase 4 computes loss experience directly from `Claim` rows; the `LossRun` abstraction can wrap this later without changing the banding seam.
- Automatic/scheduled renewal generation — this phase is manual (broker-initiated) + a due-list.
- Multi-state surplus-lines-tax rules (still NY-only constant).
- **YoY context strip on the submission-detail view (§4.5) — deferred.** As shipped, the YoY context (prior premium, loss ratio, experience adjustment) is shown on the `/renewals` page immediately after the renew action, which delivers the "legible story" at the moment of decision. Surfacing the same context later on `submissions/[sid]` is a nice-to-have; deferred to a follow-up rather than built in this slice.
