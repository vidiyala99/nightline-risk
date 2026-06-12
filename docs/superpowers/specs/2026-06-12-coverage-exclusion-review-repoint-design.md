# Coverage & Exclusion Review (Master-Policy Re-point) — Design

**Date:** 2026-06-12
**Status:** Proposed design, pre-implementation — for review
**Layer:** Broker platform (servicing + claims advocacy) + intelligence findings.
Re-points the existing master-policy ingestion engine at a job a broker actually feels.

## Why this exists (the problem with the engine today)

The master-policy ingestion (`app/api/v1/policy_docs.py` → `app/policy_document.py` →
`SourceRecord` clauses → `app/rag.py::SemanticKnowledgeBase`) is a genuinely useful capability —
**ground AI output in the venue's actual contract clause, not boilerplate** — pointed at a non-job:

- **The headline was false.** The card promised ingested clauses feed "underwriting memos." They
  never did: the carrier memo/recommender (`services/underwriting_desk.py`, `underwriting_memo.py`,
  `underwriting/recommender.py`) consume only numeric inputs. (Fixed honestly in the 2026-06-12
  "make Master Policy card honest" commit — copy now describes the real consumers.)
- **The broker was the wrong uploader.** In a brokered placement the **carrier drafts and issues the
  policy form**. Asking the broker to hand-paste it as markdown, as a "Step 1" gate, is clerical work
  on a document the carrier already produced.
- **It served the lowest-value consumers** (incident retrieval + compliance citation chips), not the
  broker's felt pain.

Broker research (failure-to-procure is **~24% of all P&C agent E&O claims** — the single leading
cause; claim-time "does the exclusion bite?" is where reading the actual wording is non-negotiable)
says the high-value job for contract-grounding is **coverage determination + E&O cover**, and we
already shipped the seed of it: `app/intelligence/findings/coverage_gap_eo.py` (a missing required
coverage line = direct broker E&O exposure, clause-cited).

**This spec re-points the engine at that job.** The deliverable a broker feels: *"Nightline reads the
policy and catches the coverage gap / exclusion before it becomes my E&O lawsuit — and cites the
clause."*

## Goal

A broker-facing **Coverage & Exclusion Review** for an in-force (or renewing) policy that surfaces,
each anchored to the governing clause:

1. **Coverage gaps vs. expected** — extend `coverage_gap_eo.py` beyond "missing required line" to
   exclusion / sublimit awareness, ranked by the venue's actual loss exposure.
2. **Claim-time exclusion-bite check** — when an incident/claim is opened, flag whether the loss
   intersects a policy exclusion *before* the carrier denies, quoting the exclusion language.
3. **A timestamped, clause-cited advice record** — the documentation that defuses a "failure to
   inform" E&O claim.

All three reuse the existing ingestion + retrieval engine; none requires the underwriting memo.

## Non-goals

- **No automated coverage determination.** AI output is **decision support with cited clauses for a
  human to verify**, never "this exclusion does/doesn't apply." (An automated coverage opinion is
  itself an E&O surface — research flag.) House rule already in force: suggestion → human-confirm →
  audit, never autonomous on coverage/money.
- **No carrier-PDF ingestion in v1.** PageIndex (`_pageindex_build`) stays the deferred quality tier
  behind its existing env gate; v1 runs on the current markdown ingestion, key-free. Real PDF pages
  arrive with PageIndex — and only then does the citation chip render `· p.X` again (the honest
  dual-mode already in place: page when present, clause `§4.2` when not).
- **No change to the uploader story in v1 code, but reframe the surface.** v1 reuses the existing
  ingestion endpoint; the card stops being a broker "Step 1 chore" and becomes "we read the carrier's
  policy" (the input-source shift to the carrier's bound-policy doc is Phase 4, below).
- **No new pricing / recommender math.** This is coverage *language* analysis, not rating.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Primary job | **Coverage gap + exclusion review (E&O cover)**, not underwriting memo | Where contract-grounding maps to a felt broker pain (failure-to-procure E&O, claim denials) |
| Build on | **`intelligence/findings/coverage_gap_eo.py`** + the findings framework | The pain is already named there; findings already render on broker surfaces with `Citation` |
| Retrieval | Reuse **`SemanticKnowledgeBase.retrieve`** over ingested `policy_exclusion` clauses | Engine exists; only the *consumer* is new |
| Execution | **Deterministic** mapping (loss-category → exclusion-keyword query); retrieval is TF-IDF, no LLM key | Key-free, reproducible, CI-safe (matches loss-run + fraud precedent) |
| Output discipline | **Advisory finding + cited clause**, human-confirmed, audited | E&O liability of AI coverage opinions |
| Input (v1) | **Existing markdown ingestion**, pages null → clause-anchored | Carrier-PDF deferred to PageIndex |

## Architecture & components

The engine (ingestion + retrieval) is unchanged. New work is a **mapping layer** (loss exposure →
relevant exclusions) and **two consumers** (a finding + a claim-time check), plus an advice-record
artifact.

- **`app/coverage/exposure_map.py`** *(new, pure)* — the deterministic brain. Maps a venue's dominant
  loss/incident categories (from existing incident + loss-run signals) and coverage lines to the
  exclusion-keyword queries used for retrieval. E.g. a venue whose top incident type is `altercation`
  → query `"assault battery altercation exclusion"`; liquor line → `"dram shop liquor over-service
  exclusion"`. No I/O — testable in isolation (mirrors `extraction/synonyms.py`).
- **`app/coverage/exclusion_review.py`** *(new)* — `review_policy_exclusions(session, policy, *,
  exposure) -> list[ClauseFinding]`. For an in-force policy, loads the venue's ingested
  `policy_exclusion` clauses via `knowledge_sources.load_ingested_policy_sources`, runs
  `SemanticKnowledgeBase.retrieve` for each exposure query, returns clause matches with score +
  `Citation` (doc_id/node_id/clause_id; page null until PageIndex). Failure-isolated → `[]`.
- **`app/intelligence/findings/coverage_exclusion_review.py`** *(new finding)* — sibling of
  `coverage_gap_eo.py`. Emits a `broker` finding per in-force policy that has exclusions intersecting
  the venue's top exposure, severity by exposure rank, `why=[Citation(... clause excerpt ...)]`,
  `recommended_action` → the review page, `prediction` (`falsifiable_by="claim_outcome"`).
- **`app/coverage/exclusion_bite.py`** *(new)* — `check_loss_against_exclusions(session, *, venue_id,
  loss_summary, loss_category) -> list[Citation]`. The claim-time consumer: given an opened
  incident/claim, retrieve exclusion clauses that intersect the loss type. Advisory only.
- **`app/models.py`** — `CoverageAdviceRecord` (the E&O documentation artifact; below).
- **`app/services/coverage_advice.py`** *(new)* — orchestrator + typed `CoverageAdviceError`; persists
  the advice record, stamps provenance, emits an audit event (`coverage_advice.recorded`).
- **`app/api/v1/coverage.py`** *(extend existing)* — endpoints below; `require_broker`;
  `CoverageAdviceError → 400`, `InvalidTransitionError → 422`.
- **`app/evals/coverage_review_scorers.py`** *(new)* — deterministic key-free scorers: does the
  exposure→exclusion mapping retrieve the *right* clause for a labeled venue/loss fixture
  (precision@1 on a gold set), and does it abstain (return `[]`) when no exclusion is relevant
  (no false coverage alarms).

## Data model

Money `Decimal`/`Numeric(12,2)`, JSON money as strings; timestamps `Field(default_factory=now_utc,
sa_type=DateTimeUTC)`; JSON list columns coerced at read boundary (`_as_list`); new column needs a
`_COLUMN_MIGRATIONS` line in `database.py`.

```
CoverageAdviceRecord
  id: str (PK, "covadvice-<sha>")        # hash(venue_id|policy_id|clause_node_ids|kind)
  venue_id: str (FK)
  policy_id: str (FK)
  kind: Literal["gap","exclusion_review","exclusion_bite"]
  loss_category: str | None              # set for exclusion_bite (the triggering loss type)
  cited_node_ids: list[str] (JSON)       # clause anchors — sorted before hashing
  summary: str                           # human-readable advice text (decision support)
  status: Literal["surfaced","acknowledged","actioned","dismissed"]
  actor_id: str | None                   # who acknowledged/actioned
  created_at, updated_at: DateTimeUTC
```

Lifecycle (typed `TRANSITIONS` in `lifecycles.py`, every mutation via
`_transition_coverage_advice(...)` → `assert_valid_transition` + `_add_audit_event`):
`surfaced → {acknowledged, dismissed}`; `acknowledged → {actioned, dismissed}`. Terminal: `actioned`,
`dismissed`. The acknowledge/action transition **is** the E&O documentation moment — timestamped,
clause-cited, attributed.

## API

- `GET  /api/venues/{id}/coverage-review` — broker: the full review for the venue's in-force
  policy (gaps from `coverage_gap_eo` + exclusion findings from `exclusion_review`), each with cited
  clauses. Read-only, advisory.
- `POST /api/coverage-advice` — record/acknowledge an advice item (creates `CoverageAdviceRecord` in
  `surfaced`, or transitions an existing one). Broker-gated, audited.
- `GET  /api/claims/{cid}/exclusion-check` *(or surfaced inline on the incident/claim view)* —
  the claim-time exclusion-bite result for an opened loss. Advisory; renders "review exclusion §X
  before this is denied," never "denied/covered."

FE surfaces (reuse existing patterns):
- **Coverage & Exclusion Review card** on `risk-profile/[venueId]` (replaces the re-pointed Master
  Policy card's *purpose*; the ingestion control stays as the input). Renders findings with the
  existing citation-chip component (clause `§4.2`, no fabricated page).
- **Exclusion-bite banner** on the incident/claim detail view when a loss intersects an exclusion.

## Phasing (each slice ships independently, suite stays green)

- **Phase 1 — Exposure map + exclusion-review finding.** `exposure_map.py` +
  `exclusion_review.py` + the new finding, rendered read-only on the risk-profile. Pure deterministic
  + retrieval; no new model yet (findings are ephemeral). Highest-value, lowest-risk: turns ingested
  exclusions into a broker-readable, clause-cited "what this policy won't cover, given how this venue
  actually loses money" review. *This is the demo-able core.*
- **Phase 2 — Advice record + lifecycle.** `CoverageAdviceRecord` + `coverage_advice.py` +
  acknowledge/action transitions + audit. The E&O documentation artifact. Adds the "I advised, on this
  clause, at this time" defensibility record.
- **Phase 3 — Claim-time exclusion-bite check.** `exclusion_bite.py` + the incident/claim banner.
  Wires the review into the moment it matters most (a loss is opened).
- **Phase 4 — Carrier-policy input + renewal drift.** Shift the input source from broker-uploaded
  markdown to the **carrier's bound-policy document** (wire `_pageindex_build` behind its env gate for
  real PDF pages); add renewal coverage-drift detection (diff expiring vs. renewing coverage
  lines/clauses → flag attachment-point/sublimit/exclusion drift as E&O exposure — the canonical
  $250K-gap case). Larger; depends on real-PDF ingestion.

## Testing (TDD, key-free, per stage)

- **`exposure_map`** (Phase 1): labeled venue profile → expected exclusion-query; abstains for a venue
  with no dominant loss category.
- **`exclusion_review`** (Phase 1): venue with an A&B exclusion + altercation-heavy incident history →
  finding surfaces, cites the exclusion clause (node_id set, page None); venue with no relevant
  exclusion → `[]` (no false alarm); retrieval raising → degrades to `[]` (failure isolation).
- **`coverage_review_scorers`** (Phase 1): precision@1 on the gold fixture set + abstention rate.
- **Advice record** (Phase 2): create → `surfaced`; valid/invalid transitions (`assert_valid_transition`);
  audit event emitted; idempotent id; money-free so no Decimal concerns.
- **`exclusion_bite`** (Phase 3): opened loss of type X retrieves intersecting exclusion; non-matching
  loss returns `[]`; never emits a covered/denied verdict (assert advisory-only shape).
- **Postgres-path guard:** `SourceRecord.source_metadata` (JSON column carrying `node_id`/`clause_id`)
  reads back as a **string** on Neon — add a coercion test so the new consumers don't `.get()` a str.

## Risks / open questions

1. **Retrieval relevance on a small per-venue clause set.** TF-IDF over a handful of exclusion clauses
   may match weakly. Mitigation: `limit` + a score floor; below floor → abstain (`[]`), never
   fabricate relevance. The scorer's abstention metric guards this.
2. **AI coverage-opinion liability.** Strictly decision-support framing in copy and API shape; the
   finding says "review §X," not "not covered." Legal-tone review before any demo.
3. **Persona reality (retail vs. wholesale E&S broker).** Affects how much manuscript-wording drift
   exists; the E&O/gap pain holds either way, but Phase 4 renewal-drift value scales with it.
4. **Input-source shift (Phase 4).** Moving off broker-uploaded markdown to the carrier's issued PDF
   is the credible-input fix but depends on PageIndex (currently stubbed) — the real build cost.
5. **`SemanticKnowledgeBase` rebuild cost.** Index is re-fit per `retrieve`. Fine per-policy; watch if
   a queue view calls it per-row (batch the index then).

## Pitch lens (secondary — this product doubles as a portfolio artifact)

"AI that grounds every coverage opinion in the actual policy clause and flags renewal coverage drift
as broker E&O exposure" signals domain fluency (knows failure-to-procure is the #1 E&O claim; knows
the carrier owns the wording) — a stronger, safer insurance-audience demo than the old card, and it
pairs with the surplus-lines-tax-correctness story (domain + correctness rigor).
