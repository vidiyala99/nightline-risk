# Carrier AI Underwriting Memo — Design

Date: 2026-06-03
Status: approved (brainstorm)
Track: 9 (carrier persona) — the differentiator on the v2 decision dossier.

## Context

The carrier underwriter desk (`/underwriting`, Phase 1.5 v2) lets the carrier decide a
submission: **Quote** (at an editable total that rescales lines), **Decline**, or
**Request-info**. The dossier already shows an **engine-suggested premium**
(`build_quote_for_carrier`) plus venue risk (tier + score). What it does NOT do is
exercise *underwriting judgment* — the thing a real underwriter writes in a file
note: a risk read, a recommended posture, subjectivities to attach, and whether the
indicated rate is adequate.

This feature adds that judgment layer as an **advisory, eval-gated** AI memo. It is the
Track-9 "AI underwriting memo (the differentiator)."

## Vocabulary — avoid the naming collision

There is already an `UnderwritingMemo` (schema) produced by `underwriter_memo_agent`
(`agents/runtime.py`): it summarizes a **logged incident's** claim-defensibility for the
evidence packet (summary + open_questions + citations). That is the **evidence layer**.

This new artifact is the **carrier submission-underwriting decision** memo. To prevent
collision it is named **`UnderwritingRecommendation`** throughout. They are different
layers, different inputs, different surfaces.

## Goal / non-goals

**Goal:** On the carrier quote-decision dossier, surface an advisory
`UnderwritingRecommendation` that gives the underwriter (1) a risk **summary**, (2) a
recommended **posture** (`quote` / `quote_with_conditions` / `decline`), (3)
**subjectivities** (conditions to attach), and (4) a **rate-adequacy** read on the
engine's indicated premium — with a rationale grounded in real inputs. Eval-gated and
deterministic-first so the quality is reproducible with no API keys.

**Non-goals:**
- The memo does **NOT** mint its own premium number. `build_quote_for_carrier` (the
  rater) owns pricing; the memo reasons *about* its adequacy, never replaces it.
- The memo **never auto-acts**. It is advisory; the carrier always confirms or
  overrides. No autonomy (consistent with the suggestion→confirm→audit rule).
- Not persisted as its own table (v1). It is computed at dossier-load and *snapshotted
  into the audit event* when the carrier acts (for calibration).

## Architecture

```
GET /api/underwriting/quotes/{qid}  (carrier-only dossier)
        │  (additive, failure-isolated → null on any error; never 500s the dossier)
        ▼
app/services/underwriting_memo.py :: recommend_underwriting(session, quote_id)
        │  gathers inputs ─────────────────────────────────────────────┐
        │   • submission/quote: venue_id, coverage_lines, requested_limits
        │   • venue risk: get_risk_score → tier + total_score
        │   • loss history: loss_run.venue_loss_run → claims/incurred/by-line
        │   • appetite: check_appetite (in/out + reasons)
        │   • indicated premium: build_quote_for_carrier breakdown
        ▼
provider seam: draft_underwriting_recommendation(...)  (MemoProvider-style)
        • Deterministic default (rules over the inputs) — reproducible, keyless
        • LLM provider = upgrade via existing get_default_provider seam
        • Any failure → deterministic fallback (capture fallback_reason)
        ▼
UnderwritingRecommendation  →  rendered as an advisory card on /underwriting/[qid]
                                (web) + UnderwriteDecisionScreen (mobile)
        ▼
On carrier action (underwrite_quote: quote|decline):
        snapshot {posture, rate_adequacy} + followed|overrode into the audit event
        (decision_source="carrier_desk") → feeds calibration stats.
```

## Schema — `UnderwritingRecommendation`

A dataclass / Pydantic model returned by the service (not a DB table in v1):

```python
posture: Literal["quote", "quote_with_conditions", "decline"]
summary: str                       # risk narrative, references real numbers
rationale: str                     # why this posture
subjectivities: list[str]          # conditions to attach (empty unless quote_with_conditions/decline)
rate_adequacy: Literal["adequate", "lean_debit", "lean_credit"]
rate_adequacy_note: str            # one line, grounded in loss cost vs indicated premium
confidence: float                  # 0..1
grounding: dict                    # the inputs it reasoned over: {tier, score, loss_summary, indicated_premium, appetite} — for faithfulness + transparency
provider: str
model: str | None
mode: Literal["deterministic", "llm"]
fallback_reason: str | None
```

## Deterministic recommender (the default; the pitch number runs on this)

Pure rules over the gathered inputs (lives in `app/providers/deterministic.py` or a
focused `underwriting_recommender.py`):

- **Posture:**
  - `decline` if out-of-appetite, OR adverse loss history (loss frequency/incurred over
    a threshold for the requested line), OR critical tier with adverse signals.
  - `quote_with_conditions` if elevated (high tier, prior loss on the line, or hard
    exposure signals) — attach subjectivities.
  - `quote` if clean (low/moderate tier, no adverse loss history, in appetite).
- **Subjectivities** keyed to the risk drivers (mirrors the action-plan taxonomy so the
  desk and the memo agree on the claim family):
  - prior liquor loss → "subject to current liquor-liability / server-training certs"
  - prior A&B / altercation → "subject to security-staffing plan + incident-log review"
  - large capacity / outdoor → "subject to satisfactory loss-control inspection"
  - stale/absent SOV → "subject to updated statement of values"
- **Rate-adequacy:** compare the engine's indicated premium against a rough expected
  loss cost derived from the loss run (incurred ÷ exposure proxy). Thin → `lean_debit`;
  generous → `lean_credit`; in band → `adequate`. Deterministic, explainable.
- **Summary / rationale:** templated narrative that *names the actual numbers* (tier,
  N prior losses, $ incurred, indicated premium) so it reads credibly and is faithful
  by construction. (Builds on the 2026-05-28 deterministic-memo-credibility work.)

## Provider seam

Add `draft_underwriting_recommendation(...)` alongside the existing `MemoProvider`
pattern. `get_default_provider()` selects deterministic when no key; an LLM provider is
a drop-in upgrade. The service wraps the call in the same try/deterministic-fallback
guard `_run_underwriter_memo_agent` uses today — a transient LLM failure never blocks
the dossier; `fallback_reason` is surfaced.

## Eval (the differentiator) — 3 scorers, deterministic stack, CI-gated

New labeled **underwriting scenarios** (fixtures): ~8–12 submissions spanning appetite
in/out × clean/adverse loss × tier bands, each labeled with the **expected posture** and
**expected rate-adequacy direction**. Scorers (in `app/evals/`):

1. **`posture_match`** — `recommendation.posture == scenario.expected_posture`.
2. **`recommendation_faithfulness`** — every quantitative claim in summary/rationale
   (loss figures, tier, indicated premium) must trace to the scenario inputs / `grounding`
   (no hallucinated numbers). Deterministic mode is faithful by construction; this guards
   LLM mode + catches template drift.
3. **`rate_adequacy_match`** — `recommendation.rate_adequacy == scenario.expected_direction`.

Wire into `evals/runner.py` + `baseline.py`; `--compare-baseline` exits 1 on any drop
(same CI gate as the existing scorers). Refresh the `/evals` scoreboard + public baseline.
Target: a real, reproducible deterministic-stack score (the pitch number); higher with a key.

## API

Extend the existing carrier-only dossier `GET /api/underwriting/quotes/{qid}` with an
additive `underwriting_recommendation` key (the serialized model, or `null` when the
recommender returns None). No new route. Failure-isolated exactly like `reserve_hint`
on the adjuster detail.

## UI (web + mobile parity)

- **Web** `/underwriting/[qid]`: an advisory card near the decision form — posture chip
  (color + label), rationale, a subjectivities checklist, and a rate-adequacy badge
  (adequate / lean-debit / lean-credit). Clearly labeled **"AI recommendation · advisory"**.
  It does **not** auto-fill the Quote/Decline form; the carrier acts deliberately.
- **Mobile** `UnderwriteDecisionScreen`: same advisory card (reuses existing primitives).
- Follows the lock/disabled + a11y conventions; tiers use the one heat ramp (no lime
  accent as text — `accentInk` for any accent text), per project invariants.

## Audit + calibration

On `underwrite_quote` (quote / decline), include in the audit event metadata: the
recommendation snapshot (`posture`, `rate_adequacy`) and whether the carrier **followed**
or **overrode** it. This reuses the `decision_source="carrier_desk"` stamping already in
place and feeds the existing override-calibration stats (extended to cover underwriting
recommendations) — agents accelerate, evals + override-tracking keep them honest.

## Testing

- Service: deterministic recommender posture/subjectivity/rate-adequacy logic across the
  input combos; failure-isolation (bad/missing inputs → None, never raises).
- API: dossier returns the recommendation; degrades to `null` on recommender error.
- Evals: the 3 scorers + the new scenario fixtures; baseline compare.
- Audit: quote/decline stamps the recommendation snapshot + followed/overrode flag.
- Money stays `Decimal`; JSON columns coerced at the read boundary (Neon class).

## Phasing (for the plan)

- **Phase A — backend + eval (the differentiator + the pitch number):** schema,
  deterministic recommender, `underwriting_memo` service, dossier API field, the 3
  eval scorers + scenarios + baseline/CI, audit snapshot. Shippable and demoable on its
  own (the eval score is the pitch).
- **Phase B — UI:** web advisory card + mobile parity + calibration-stat surfacing.

## Risks / landmines (pre-noted)

- **Naming collision** with the incident `UnderwritingMemo` — use
  `UnderwritingRecommendation` everywhere; do not reuse the incident memo schema.
- **Don't overclaim pricing** — the memo never emits a premium number; rate-adequacy is
  a direction + note only.
- **Neon JSON-string** coercion at the read boundary for any JSON inputs (loss-run /
  breakdown payloads).
- **Failure isolation** — the recommender must never 500 the dossier (mirror
  `reserve_hint`).
- **Eval honesty** — label scenarios from underwriting first principles, not by
  reverse-engineering the deterministic rules (otherwise the scorer just tests itself).
```
