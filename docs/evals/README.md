# Agent Eval Set — Methodology

This directory holds the gold-standard eval set used by `backend/app/evals/` to
score the underwriting agent pipeline against expected outputs.

This document is the **house rules**. Adding scenarios, changing scorers, or
interpreting results follows the contract here.

---

## Purpose

The eval set serves two distinct functions:

1. **Regression catcher.** When agents change (new providers, new prompts,
   refactors), running the eval surfaces behavioral drift that unit tests
   miss.
2. **Roadmap document.** Each failure points at a real gap in agent capability.
   The mix of passes and failures across difficulty levels and exposure
   classes tells us where to invest next.

The eval set is **not** a marketing benchmark or a binary pass/fail gate. A
healthy eval reveals weaknesses; a 100% pass rate means the scenarios are
too easy.

---

## Schema v2 — `gold_standard.json`

Each scenario is a JSON object with the following fields. Required fields are
marked `*`.

| Field | Type | Notes |
|---|---|---|
| `scenario_id`* | string | Stable, human-readable. Format: `SCENARIO-NNN-SLUG`. |
| `schema_version`* | int | Currently `2`. Bumps require migration. |
| `exposure_class`* | enum | See controlled vocabulary below. |
| `difficulty`* | enum | `easy` \| `medium` \| `hard`. |
| `scenario_type`* | enum | `standard` \| `mitigating_factor_bait` \| `subtle_catastrophic`. |
| `provenance`* | object | See "Provenance" below. |
| `description`* | string | Plain-English summary. **Must not contain answer phrases** — see leakage rule. |
| `input_events`* | array | Camera/POS/sensor events. Shape unchanged from v1. |
| `ideal_output`* | object | See "Ideal output" below. |

### Controlled vocabulary — `exposure_class`

```
assault_battery
dram_shop
premises_liability
medical_emergency
property_damage
crowd_management
negligent_security
```

Mirrors the top categories in nightlife liability: A&B exclusion, dram shop,
premises, medical duty of care, property, crowd management, and negligent
security (e.g. *Valentine v. Nayarit*-pattern parking-lot cases). New values
require a `schema_version` bump and migration of all existing scenarios.

### `provenance` (object)

```jsonc
{
  "policy_clauses": ["Section 2.1 Assault and Battery Exclusion"],
  "industry_pattern": "Bouncer/inadequate-response cases",
  "rationale": "Tests whether agent triggers A&B exclusion when ..."
}
```

- `policy_clauses` — at least one clause from `docs/policies/nightlife_liability_2026.md` or a real-world equivalent.
- `industry_pattern` — short reference to a real case archetype or industry-published claim pattern.
- `rationale` — one sentence: what underwriting capability does this scenario probe?

### `ideal_output` (object)

```jsonc
{
  "risk_level": "high",                    // low | medium | high | critical
  "risk_score": 85,                        // 0-100, advisory
  "underwriting_memo": "...",              // narrative for future LLM-judge scorer
  "mandatory_citations": ["EV-CAM-001"],   // event_ids retrieval must surface
  "rubrics_triggered": ["..."],            // named rubrics (advisory v1)
  "expected_review_status": "needs_review",// approved | needs_review | blocked
  "aggravating_factors": ["..."],          // canonical factor names
  "mitigating_factors": ["..."]            // canonical factor names
}
```

Factor names are free-form snake_case but should be consistent across scenarios
(e.g. `delayed_security_response`, `security_present`, `documented_aggression`,
`hydration_distributed`, `capacity_within_limits`). Reuse before inventing.

---

## The 8 Guardrails

These are non-negotiable for any scenario added to the eval.

### 1. Provenance per scenario
Every scenario cites at least one policy clause and one industry pattern. No
"I think this would be high severity" — the rationale must trace to a source.

### 2. Author separation
Write the `ideal_output` *first*, from the policy/case sources. **Never** look
at current agent output and write the gold to match it. That's a self-fulfilling
eval and the cardinal sin of this discipline.

### 3. Diversity quotas
Bucket distribution for the v1 cap of 15 scenarios:

| Exposure class | Count |
|---|---|
| Assault & Battery | 3 |
| Dram shop / Liquor liability | 3 |
| Premises liability | 2 |
| Medical emergency | 2 |
| Property damage | 1 |
| Crowd management | 2 |
| Negligent security | 2 |

Cross-cutting tags (distributed, not bucketed):
- `mitigating_factor_bait`: at least 3 scenarios — these probe over-classification
- `subtle_catastrophic`: at least 2 scenarios — these probe under-classification

### 4. Difficulty tagging
Every scenario is `easy`, `medium`, or `hard`. Distribution should not skew
heavily to one level. Hard cases involve mitigating factors, conflicting
signals, or off-premises continuations.

### 5. No data leakage
The `description` field must not contain phrases that directly imply the
answer. Bad: *"After-hours dram shop violation."* Good: *"Multiple sales of
high-ABV spirits occur after the 4:00 AM legal cutoff."*

The agent must reason from the events, not lift the answer from the
description.

### 6. Goodhart guard
When an eval fails, do **one** of three things — never silently tune the
agent until it passes:
1. **Agent gap** — record in the findings ledger; agent is genuinely wrong.
2. **Gold error** — fix the gold; document why it was miscalibrated.
3. **Known limit** — record that the deterministic stub can't handle this
   case but a future LLM should; mark and move on.

Every change to either side requires a written justification in the commit
message.

### 7. Volume cap
v1 caps at 15 scenarios. Going past requires a `schema_version` bump and
explicit decision — not creep.

### 8. Versioned, immutable artifacts
- Scenarios are versioned in git.
- Eval results are gitignored (`backend/app/evals/results/.gitignore`).
- Schema migrations bump `schema_version` and migrate all existing rows.
- Don't mutate scenarios in place — write a new ID.

---

## Scorer reference

All scorers are deterministic in v1. Each returns:

```python
ScorerResult(name, passed, score: float, detail: str)
```

| Scorer | What it measures | Pass criterion |
|---|---|---|
| `structural` | Packet has all required fields, valid types, severity in ladder, confidence in [0,1] | All present, valid |
| `severity_match` | Agent severity matches gold `risk_level` | Strict equality. Score graded by ladder distance |
| `citation_coverage` | `ideal.mandatory_citations ⊆` retrieval+memo+risk citations (deliberately excludes claims_timeline copy) | All cited |
| `review_status_match` | Agent `risk_signal.review_status` matches gold `expected_review_status` | Strict equality |
| `factor_recognition` | Fraction of expected aggravating + mitigating factors that surface in agent output | Score = 1.0 |

**Why exclude claims_timeline from citation_coverage?** The timeline agent
mechanically copies every stream event for the venue. Including its source IDs
would make `citation_coverage` trivially pass. We test whether *retrieval*
picks the right evidence, not whether the pipeline plumbed events through.

**Why is `factor_recognition` deterministic?** It does keyword matching against
`risk_signal.explanation`, citation excerpts, and the memo summary. It will
miss paraphrases the deterministic stub doesn't produce — and that's fine for
v1. When LLMs are wired in, the same scorer will become more discerning.

### Deferred — `memo_quality` (LLM-as-judge)

A future scorer will use an LLM judge with an analytic rubric (factuality,
completeness, defensibility, citation grounding) to score the memo against
`ideal_output.underwriting_memo`. Calibration plan:

1. Generate ~30 (scenario, memo) pairs across difficulties.
2. Hand-grade each on the rubric.
3. Run the LLM judge with a few-shot prompt.
4. Compute Cohen's kappa between human and judge.
5. Promote to live scoring only if kappa ≥ 0.8.

This lives in the future-work section, not v1.

---

## How to run

```bash
cd backend
python -m app.evals.runner
```

Writes a dated markdown report to `backend/app/evals/results/<timestamp>.md`.
Exits non-zero if any scenario fails any scorer (CI-friendly).

To run a single scenario or score a specific provider, see `runner.py`.

### Interpreting the report

- **Aggregate pass rate** — read alongside difficulty distribution. 100% on
  all-easy scenarios is uninformative.
- **Per-scorer averages** — which scorer is dragging the rate down? That's
  the next investment.
- **Per-scenario detail** — the `detail` line on a failure tells you *what*
  the agent did wrong (e.g., `agent=high, gold=critical, off by 1
  (under-classified)`).

---

## Findings ledger

When an eval failure surfaces, record the decision here. This is the Goodhart
guard in practice — it forces every change through a justification.

| Date | Scenario | Failure | Classification | Decision |
|---|---|---|---|---|
| 2026-05-09 | SCENARIO-002-AFTER-HOURS-LIQUOR | severity_match: agent=high, gold=critical | Agent gap | Stub heuristic maxes liquor_liability at "high"; gold correctly assigns "critical" for license-suspension exposure. Awaits LLM uplift on `RiskEvaluatorAgent`. |
| 2026-05-09 | SCENARIO-003-PROACTIVE-MITIGATION | severity_match: agent=high, gold=low | Agent gap | Stub matches "crowd" keyword and over-classifies; cannot reason about mitigating factors. Motivates the `factor_recognition` scorer added in Phase 1. Awaits LLM uplift. |
| 2026-05-09 | SCENARIO-003-PROACTIVE-MITIGATION | review_status_match: agent=needs_review, gold=approved | Agent gap | Downstream effect of severity over-classification — stub flags any non-low severity as `needs_review`. Resolves automatically once severity is corrected. |
| 2026-05-10 | ALL (001/002/003) | factor_recognition: 0–50% recognized | Known limit | Cross-scenario finding from Phase 1 run: deterministic stub never references factors by name in `risk_signal.explanation` or memo summary — it emits one of four canned severity-bucket templates. Aggravating/mitigating factors as a *named category* require LLM reasoning. This scorer is expected to fail across the board on the stub and become the headline metric for stub→LLM migration. |
| 2026-05-10 | SCENARIO-009-UNDERAGE-SERVICE | severity_match: agent=high, gold=critical | Agent gap | Same root cause as SCENARIO-002 — stub heuristic maxes liquor_liability at "high"; gold treats license-suspension + criminal exposure as critical. Resolves automatically when the stub→LLM migration on `RiskEvaluatorAgent` lands. |
| 2026-05-10 | SCENARIO-011-PARKING-LOT-VALENTINE | severity_match: agent=high, gold=critical | Agent gap | New root cause: the deterministic stub has no `negligent_security` incident type — keyword "assault" routes to `altercation_event` with base medium, escalated to high by injury+police flags. The advertised-duty + off-premises + Valentine-pattern reasoning that drives critical severity is impossible in heuristic form. This is the strongest single argument for an LLM-backed `RiskEvaluatorAgent`: the model needs to reason about premises duty, advertised security, and foreseeability — not just keyword-classify. |

---

## Future work

1. **LLM-as-judge memo scorer** with kappa calibration (see deferred section
   above).
2. **Live-mode evals** (`EVAL_LLM=1` against Gemini/Anthropic) — runner already
   threads provider config; just needs a flag and per-provider scoreboard.
3. **Cross-venue scenarios** — currently all use a placeholder `eval-venue`;
   real venue context (capacity, prior incidents, security level) should
   influence severity in some cases.
4. **Pytest integration** — `pytest -m evals` for CI; v1 keeps it as a
   standalone CLI to avoid pytest fixture overhead.

---

## Sources consulted (when authoring v1)

- `docs/policies/nightlife_liability_2026.md` (in-repo synthetic policy)
- Industry references: Liberty Insurance liquor liability guides, Agency
  Height nightclub coverage breakdowns, hospitality insurance market reports
- Real case patterns: bouncer-injury verdicts (~$1.2M), *Valentine v. Nayarit*
  CA Supreme Court (~$7M, negligent security parking-lot)
- Eval methodology: Galileo agent evaluation framework, Anthropic
  rubric-based eval guidance, Autorubric paper (analytic rubrics, kappa
  metrics), LangChain LLM-as-judge calibration
