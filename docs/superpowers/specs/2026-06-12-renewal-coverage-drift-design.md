# Renewal Coverage Drift — Design

**Date:** 2026-06-12
**Status:** Shipped (v1) 2026-06-12
**Layer:** Broker platform (renewals) + intelligence findings.
The application of the coverage/E&O machinery to the broker's #1 felt pain.

## Why this exists

A broker-lens audit (see the master-policy re-point spec + prior broker research)
found that the single highest-leverage gap is **renewal coverage drift**: a renewal
that silently drops a line, adds an exclusion, lowers a limit, or raises an
attachment point vs. the expiring policy. This is the **#1 broker-E&O fact
pattern** — "failure to procure" is ~24% of all P&C agent E&O claims, and the
canonical case is a renewal whose form/attachment-point changed and the broker
didn't catch it (e.g. the May 2026 Georgia Court of Appeals decision reviving a
broker-E&O suit over a fatal shooting + coverage gap).

The audit ranked this **above** PDF master-policy ingestion because:
- The data is **already structured and already captured** by the bind flow the
  broker completes — no upload, no parsing, no chore.
- It **reuses** the findings + acknowledge + E&O-advice-trail machinery shipped in
  the coverage-exclusion-review work.

## The key data fact

`CarrierQuote.coverage_terms` and `Policy.terms_snapshot["coverage_terms"]` both
carry, per line: `{per_occurrence, aggregate, deductible, exclusions: [...]}`
(money as strings). A renewal links to its expiring policy via
`Submission.prior_policy_id`, and its proposed terms live on its selected/quoted
`CarrierQuote`. So the whole feature is a **dict diff of two `coverage_terms`** —
no policy-document ingestion required.

## Components

- **`app/coverage/renewal_diff.py`** *(pure, no I/O)* — the diff brain.
  `terms_from_coverage_terms(carrier_id, lines, coverage_terms) -> PolicyTerms`
  (money coerced to `Decimal`, exclusions to a `frozenset`); `diff_renewal_terms(expiring, renewal) -> RenewalDiff`.
  `RenewalDiff` reports `dropped_lines`, `added_lines`, `limit_changes`
  (per-field, each tagged `adverse`), `added_exclusions` / `removed_exclusions`,
  `carrier_changed`, plus `has_adverse` and human-readable `adverse_findings`.
  **Adverse = a coverage reduction for the insured:** lower per-occurrence/aggregate
  (or dropped), higher/introduced deductible, a newly-added exclusion, a dropped
  line. Higher limits / removed exclusions are favorable, not flagged.
- **`app/coverage/renewal_review.py`** *(failure-isolated consumer)* —
  `review_renewal(session, submission) -> (expiring_policy, RenewalDiff) | None`.
  Picks the renewal's proposed terms from its **selected** quote (else any quoted),
  reads both `coverage_terms` Neon-safely (`_as_dict`), diffs. Returns None when
  there's nothing to compare (not a renewal, expiring gone, no quote yet).
- **`app/intelligence/findings/renewal_term_drift.py`** *(broker finding)* — for
  each in-flight renewal (`status ∈ {open, in_market, quoting}`), emits a finding
  when the diff has an adverse change or a carrier swap. **high** when a line is
  dropped or an exclusion added; **medium** for limit-only / carrier-only drift.
  Subject = the **expiring policy** (so the acknowledge→E&O-trail wiring works),
  `href` → the renewal submission (where the broker acts). `why` cites each change.
- **Registration** — added to `PERSONA_KINDS["broker"]`, `REGISTRY`, and the
  intelligence eval (`_broker_renewal_term_drift` gold scenario).
- **E&O trail** — advice kind `renewal_drift` added to `coverage_advice.VALID_KINDS`;
  FE `FINDING_KIND_TO_ADVICE_KIND` maps `renewal_term_drift → renewal_drift`, so the
  existing "Acknowledge (E&O)" button on the Exposure panel records the advice trail
  for renewal drift exactly as it does for exclusion findings.

## Surfacing

Rides the existing broker Exposure panel (`ExposurePanel.tsx`,
`GET /api/intelligence/exposure`) and the copilot `get_exposure` tool — no new
endpoint or screen. The acknowledge button is already wired.

## Tests (TDD)

- `test_renewal_diff.py` — 11 cases over the pure diff (dropped/added line, lowered
  limit, raised deductible, favorable change, added/removed exclusion, carrier
  change, identical terms, human-readable output).
- `test_renewal_term_drift_finding.py` — 6 cases end-to-end through a seeded session
  (dropped line → high, added exclusion → high, carrier-only → medium, identical →
  no finding, no-quote-yet → none, non-renewal → none).
- Intelligence eval gold scenario + the FE `findingToAdvicePayload` mapping case.

## Non-goals / follow-ups

- **No premium-drift / price comparison** — this is coverage *language/terms*, not
  rating (renewals already surface loss-ratio + experience adjustment elsewhere).
- **No renewal-side dedicated comparison screen** — v1 surfaces via the findings
  panel; a side-by-side term table on the renewal submission page is a possible
  follow-up.
- **Exclusion vocabulary** is whatever the carrier put in `coverage_terms.exclusions`
  (free strings today). A normalized exclusion taxonomy would sharpen matching.
