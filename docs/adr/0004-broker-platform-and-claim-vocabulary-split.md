# ADR-0004 — Broker Platform (Phases 1–3) and the Claim vs. ClaimProposal Vocabulary Split

**Status:** Accepted · shipped 2026-05-21
**Date:** 2026-05-21
**Author:** A. Vidiyala
**Builds on:** ADR-0003 (Claim Proposals — operator proposes, broker decides)
**Plan reference:** `plans/sleepy-prancing-clover.md` (Year 1–2 broker-platform build plan, 7 phases)

---

## Context

Through Q1–Q2 2026 the product was an underwriting-evidence pipeline: incidents → AI agents → packets → operator-proposed claim recommendations (ADR-0003). That layer remains correct as the *evidence* surface, but it didn't model the actual broker workflow:

- Brokers don't just "decide" on incident recommendations. They run a **placement loop**: open a submission for a venue, send it to carriers, collect quotes, bind a policy.
- A bound policy has a **lifecycle** — endorsements, certificates of insurance, cancellation refunds, renewals.
- Real losses that get reported to carriers are **carrier-side claims** with reserves and payments — a different entity from the operator's internal proposal.

We needed a second, broker-facing data layer alongside the existing evidence layer. The plan (`sleepy-prancing-clover.md`) lays out seven phases. Phases 1–3 shipped 2026-05-19 → 2026-05-21:

| Phase | Domain | Shipped |
|---|---|---|
| 1 | Placement (submissions → carrier quotes) | Schema + service + 13 endpoints + 3 frontend routes |
| 2 | Policy lifecycle (bind, endorse, COI, cancel) | Schema + service + 10 endpoints + 3 frontend routes |
| 3 | Claims integration (carrier-side claims) | Schema + service + 10 endpoints (frontend shipped since — see Update below) |

---

## Decision

### 1. Adopt a second data layer for the broker-platform domain

New entities live alongside (not inside) the evidence layer:

| Entity | Purpose | Lifecycle source of truth |
|---|---|---|
| `Carrier` | Market participants with appetite + multipliers | Static seed |
| `CoverageLine` | GL, liquor, assault & battery, etc. with defaults | Static seed |
| `Submission` | A venue's request for coverage routed to carriers | `app.lifecycles.SubmissionStatus` |
| `CarrierQuote` | A carrier's response on a submission | `app.lifecycles.QuoteStatus` |
| `Policy` | A bound contract — frozen snapshot of premium + terms | `app.lifecycles.PolicyStatus` |
| `Endorsement` | Mid-term policy change with validated `terms_diff` | n/a (immutable rows) |
| `CertificateOfInsurance` | Doc venues send to landlords/event clients | `active | superseded | cancelled` |
| `Claim` (carrier-side) | A reported loss with reserve + payment history | `app.lifecycles.ClaimStatus` |
| `ClaimPayment` | Per-payment ledger (indemnity / expense / recovery) | n/a (immutable rows) |
| `ReserveChange` | Audit row for every reserve adjustment | n/a (immutable rows) |

Each lifecycle is encoded as a `Literal[...]` + a `TRANSITIONS: dict[str, set[str]]` matrix in `app/lifecycles.py`. Service-layer mutations go through `assert_valid_transition(...)` — no string-typo state changes survive a transition through these tables.

### 2. Split `Claim` from `ClaimProposal`

`ClaimProposal` (ADR-0003) and `Claim` (this ADR) are now distinct entities with different invariants:

| | ClaimProposal | Claim (carrier-side) |
|---|---|---|
| **What it is** | The operator's internal *recommendation* that an incident should be filed as a claim | The carrier's actual claim record, what the carrier "knows about" |
| **Who creates it** | Operator (via web/mobile), broker reviews | Broker, after FNOL is sent to the carrier |
| **States** | `pending_broker_review → approved → filed_with_carrier → paid | denied` | `notified → acknowledged → reserved → settling → closed_paid | closed_denied | closed_dropped`, all closed states can transition to `reopened` |
| **Money** | A *predicted* EV from the AI rubric | Actual reserves + payments recorded from carrier communications |
| **Anchor** | An `UnderwritingPacket` (incident-level snapshot) | A `Policy` (contract-level binding) + optionally a `defense_package_id` pointing at a frozen packet |

Linkage: `Claim.proposal_id` is optional and points back to the originating `ClaimProposal` when a proposal eventually becomes a real FNOL. Most carrier-side claims will *not* have a proposal — operators don't propose every loss.

### 3. URL contract update

The legacy `GET /api/claims` and `GET /api/claims/{packet_id}` endpoints returned `ClaimProposal` rows. The names were mis-named pre-Phase-3 — calling the internal recommendation "claims" worked when there was only one concept, but with carrier-side claims arriving, the namespace had to be freed.

| Old | New | Returns |
|---|---|---|
| `GET /api/claims` | `GET /api/claim-proposals` | `ClaimProposal[]` |
| `GET /api/claims/{packet_id}` | `GET /api/claim-proposals/by-packet/{packet_id}` | `ClaimProposal` |
| — (new) | `GET /api/claims/{cid}` | `Claim` (carrier-side) |

Updated callers: `backend/tests/test_claim_routes.py`, `frontend/src/app/claims/page.tsx`, `mobile/src/screens/ClaimsListScreen.tsx`.

### 4. Cross-cutting conventions

All broker-platform code follows the conventions established by the plan:

- **Money is `Decimal`.** Never `float` for currency. `app.money` provides `usd(x)`, `usd_to_json(x)`, `json_to_usd(s)`. JSON columns store money as strings; SQL columns use `Numeric(12, 2)`.
- **Timestamps are UTC.** New tables use `app.time.now_utc` as the `default_factory`. Pre-existing legacy tables using `datetime.utcnow` are out of scope until the entire schema migrates.
- **State transitions emit audit events.** Every transition function calls `app.packet_core._add_audit_event` with `event_type=f"{entity}.{to_state}"` so the audit log is the canonical history.
- **Snapshot hashes anchor archival truth.** `Policy.snapshot_hash` and `Claim.snapshot_hash` are SHA-256 of canonical JSON of contract / financial state. Policy hash is re-computed only on bind, endorsement, and policy-number assignment — *not* on status changes — so archived defense packages keep their referent. Claim hash re-computes on every money/status mutation because claims don't get frozen until close (and reopen mutates again).
- **Atomic operations.** `bind_quote` is the canonical example: six effects (validate, transition quote, withdraw siblings, transition submission, insert policy, emit audit) wrapped in a savepoint — either all six commit or all six unwind.

---

## Consequences

### Positive

- **Brokers have a working surface.** `/submissions`, `/policies` are demoable end-to-end (see `backend/scripts/seed_demo_placements.py`).
- **The pitch corroborates from code.** The "incident-to-defense-package" story now ends at a real `Policy` row with a `snapshot_hash`, not a hand-waved "imagine a contract here."
- **Vocabulary clarity.** `ClaimProposal` ≠ `Claim` is now enforced at the URL, schema, and service-method-name level. Future readers won't conflate.
- **Lifecycle invariants enforced once.** `assert_valid_transition` centralizes the "can X → Y?" check; service code can't drift.

### Negative

- **More surface to maintain.** 16 new database tables across phases 1–3, ~30 new endpoints. Adds operational complexity to a previously incident-centric system.
- **Two claim concepts.** A future reader still has to learn the `ClaimProposal` vs. `Claim` distinction. The naming, linkage, and ADR documentation address this; some confusion is unavoidable until the v2 neutral-drafter design (ADR-0002 long-term target) collapses some of the proposal surface.
- **Frontend lag (resolved 2026-05-30).** Phase 3 backend originally shipped without a carrier-claims UI; that gap is now closed. The frontend slice landed on both platforms — web `/claims` + `/claims/[cid]` (with FNOL / reserve / payment authoring under `/policies/[pid]/claims/new`), and mobile `CarrierClaimsListScreen` + `CarrierClaimDetailScreen`. (One residual: the mobile list still aggregates per-policy instead of calling the cross-policy `GET /api/claims` the web UI uses.)

### Neutral / migration

- The `claim-proposals` URL rename is a breaking change for any external integration. None exist today — the only consumers were the project's own frontend, mobile app, and tests, all updated in the same commit (`fb52247`).
- Existing `database.db` instances (including Railway prod) need no migration for the rename itself, but new tables (`Claim`, `ClaimPayment`, `ReserveChange`) will be created by SQLModel's `create_all` on next boot. Postgres-on-Railway uses additive `ALTER TABLE` for column-level migrations and creates new tables idempotently — no manual step required.

---

## Update — 2026-05-30

The Phase 3 "frontend deferred" note above is **superseded**. The carrier-side-claims UI shipped on both platforms:

- **Web:** `/claims` (cross-policy portfolio via `GET /api/claims`), `/claims/[cid]` (lifecycle + reserve + payment ledger), and FNOL/reserve/payment authoring from the policy detail (`/policies/[pid]/claims/new`).
- **Mobile:** `CarrierClaimsListScreen` + `CarrierClaimDetailScreen` (file FNOL / record reserve / record payment).

Residual gap: the mobile list still does N per-policy fetches instead of the single cross-policy `GET /api/claims` the web UI migrated to — tracked as a follow-up, not a deferral.

---

## Alternatives considered

1. **Keep `Claim` and `ClaimProposal` under the same name, disambiguate by URL prefix only.** Rejected — the conflict isn't just URL-level; the entities have different lifecycles, different money invariants, different anchors. Sharing a name guarantees recurring confusion in code, tests, and conversation.

2. **Build the broker platform inside the existing `claims` module.** Rejected — the existing module (`app/claim_proposals.py`) is the operator-side recommendation flow with its own established patterns. Mixing the carrier-side reserve/payment ledger into it would have produced a 1000-line module with two incompatible mental models.

3. **Defer Phase 3 (claims integration) until renewals.** Rejected — the defense-package story (incident → carrier loss → packet anchors the defense) needed `Claim.defense_package_id` to be real to corroborate. Without Phase 3 the demo can show a policy but not what happens when something goes wrong.

---

## References

- Build plan: `plans/sleepy-prancing-clover.md` (sections "Schema Layer", "Service Layer", "API Layer", "Phased Rollout Strategy")
- Phase 1–3 commits: `2da18fe` (schema P1) → `e4898b2` (tests P3) — 13 commits across 2026-05-19 to 2026-05-21
- Lifecycle matrices: `backend/app/lifecycles.py`
- Service modules: `backend/app/services/{submissions,policies,claims}.py`
- API routers: `backend/app/api/v1/{placement,policies,claims}.py`
- Spec doc: `docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md`
