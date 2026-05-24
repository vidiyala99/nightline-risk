# Broker Platform — Phases 1–3 (Placement, Policy Lifecycle, Claims)

**Date:** 2026-05-21
**Status:** Shipped backend across all three phases; Phase 3 frontend shipped 2026-05-23 (see §5.5).
**ADR:** [0004-broker-platform-and-claim-vocabulary-split](../../adr/0004-broker-platform-and-claim-vocabulary-split.md)
**Build plan:** `plans/sleepy-prancing-clover.md` (the Year 1–2 plan; this doc covers what actually shipped through Phase 3)

---

## 0. What this doc is

A reference for the broker-facing data and service layer that runs alongside the evidence layer (incidents → packets → claim proposals — see `2026-05-07-architecture-v2.md`). Read this when:

- You need to add an endpoint or service method in the placement/policy/claims domain.
- You're wondering why `Claim` and `ClaimProposal` are different entities (see ADR 0004).
- You're seeding demo data and want to know which carriers match which venue types.
- You're trying to figure out what a `snapshot_hash` is anchoring and when it re-computes.

This is a snapshot of the design **as shipped**, not the long-term plan. Phases 4–7 live in `sleepy-prancing-clover.md`.

---

## 1. Layer separation

```
                ┌──────────────────────────────────────────────┐
                │ Evidence layer (ADR-0002, ADR-0003)          │
                │   IncidentRecord → UnderwritingPacket        │
                │     → ClaimProposal (operator recommendation)│
                │   Routes: /api/incidents, /api/packets,      │
                │           /api/claim-proposals               │
                └──────────────────────────────────────────────┘
                                  │
                                  │ (Claim.proposal_id, optional)
                                  ▼
                ┌──────────────────────────────────────────────┐
                │ Broker platform layer (ADR-0004)             │
                │   Carrier · CoverageLine · Submission        │
                │     → CarrierQuote → Policy                  │
                │       → Endorsement                          │
                │       → CertificateOfInsurance               │
                │     → Claim (carrier-side)                   │
                │       → ClaimPayment · ReserveChange         │
                │   Routes: /api/submissions, /api/policies,   │
                │           /api/claims (carrier-side)         │
                └──────────────────────────────────────────────┘
```

The two layers can communicate but don't share lifecycles. The only structural FK across the boundary is `Claim.defense_package_id → UnderwritingPacket.id` with `ON DELETE RESTRICT` — once a claim references a packet, the packet's defense story is frozen for as long as the claim exists.

---

## 2. Cross-cutting conventions

These apply to all broker-platform code. They are non-negotiable for new modules in this layer.

### 2.1 Money is `Decimal`, never `float`

Helpers live in `backend/app/money.py`:

```python
from app.money import usd, usd_to_json, json_to_usd

annual_premium: Decimal = usd("5894.84")        # parse safely
breakdown_json: dict = { "total": usd_to_json(total) }   # storing in JSON column
total: Decimal = json_to_usd(breakdown_json["total"])    # reading back
```

- SQL columns: `sa_column=Column(Numeric(12, 2), nullable=False)`.
- JSON columns: money as **strings** so JSON round-trips don't drift through floats.
- Multiplication chains stay in Decimal end-to-end; cast back to float only at the legacy boundary in `pricing.py` via `app.money.cast_money_to_float`.

### 2.2 Timestamps are UTC

`from app.time import now_utc` for new tables. `default_factory=now_utc`. The legacy `datetime.utcnow` is deprecated everywhere in 3.12+ but is out of scope on legacy tables that already have it.

### 2.3 Lifecycle transitions are typed

Every entity with a status column has:

1. A `Literal[...]` type alias enumerating valid states.
2. A `TRANSITIONS: dict[str, set[str]]` matrix mapping each state to its allowed next states.
3. A service-layer `_transition_<entity>(session, row, *, to, actor_id, metadata)` helper that calls `assert_valid_transition(...)` before mutating.

See `backend/app/lifecycles.py`. The transition tables are also exposed via `GET /api/submissions/transitions` (etc.) so the frontend kanban can disable invalid drop targets client-side.

```python
from app.lifecycles import SUBMISSION_TRANSITIONS, assert_valid_transition

assert_valid_transition(
    SUBMISSION_TRANSITIONS, sub.status, "in_market", entity_name="Submission"
)
sub.status = "in_market"
```

### 2.4 Every state transition emits an `AuditEvent`

```python
from app.packet_core import _add_audit_event

_add_audit_event(
    session=session,
    actor_id=user_id, actor_type="user",
    entity_type="submission", entity_id=sub.id,
    event_type=f"submission.{to_state}",
    event_metadata={"from": from_state, "to": to_state, **extras},
)
```

The audit log is the canonical history. Lifecycle helpers do this automatically; ad-hoc service code emitting business events should follow the same shape.

### 2.5 Snapshot hashing anchors archival truth

`Policy.snapshot_hash` and `Claim.snapshot_hash` are SHA-256 over canonical JSON of the row's tamper-evident state:

```python
body = {
    "id": policy.id,
    "policy_number": policy.policy_number,
    "annual_premium": str(policy.annual_premium),
    "coverage_lines": sorted(policy.coverage_lines),   # sort list contents!
    "terms_snapshot": policy.terms_snapshot,
    ...
}
canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

**Re-compute timing:**

- `Policy.snapshot_hash`: bind, endorsement, policy-number assignment. **NOT** on status changes (cancel/expire/lapse). The hash anchors *what was agreed*; status is operational metadata.
- `Claim.snapshot_hash`: every money or status mutation. Claims don't get frozen — reopens mutate the hash again.

**Why sort list contents before hashing?** `json.dumps(sort_keys=True)` only sorts dict keys. Lists are order-preserving, so a future Postgres / SQLAlchemy upgrade that returns a JSON-stored list in different order would drift the hash without any data change. Sort before hashing. (`102d9c8` is the defensive commit.)

### 2.6 Atomic multi-step operations use savepoints

`bind_quote` is the canonical example — six effects in one transaction:

```python
def bind_quote(session, quote_id, *, ...):
    # 1. validate quote (raises QuoteNotBindableError)
    # 2. transition chosen quote → bound
    # 3. transition siblings → withdrawn
    # 4. transition submission → bound
    # 5. insert Policy with snapshot_hash
    # 6. emit policy.bound audit event
    # The whole thing is wrapped in the caller's session.begin() / commit
```

If any step raises, the caller's `session.rollback()` undoes the entire group. The service does **not** commit itself — the API layer (or test fixture) owns commit/rollback semantics.

### 2.7 FK ordering on Postgres requires explicit flush

SQLAlchemy/SQLModel's FK semantics: a child row with `foreign_key="parent.id"` *will* `session.flush()` parents before children on commit. But with **column-level** FKs declared via `sa_column=Column(ForeignKey(...))` (the pattern used for `ON DELETE RESTRICT`), the implicit flush ordering doesn't always fire. **Call `session.flush()` explicitly** after inserting parents whose IDs you'll FK to immediately. See memory: `project_postgres_fk_ordering`.

---

## 3. Phase 1 — Placement

### 3.1 Schema (`backend/app/models.py`)

| Table | Key shape |
|---|---|
| `Carrier` | `id`, `name`, `market_type` ("admitted" \| "e&s"), `naic_code`, `am_best_rating`, `appetite` (JSON: venue_types, max_capacity, coverage_lines) |
| `CoverageLine` | `id` ("gl", "liquor", "assault_battery", …), `display_name`, `default_per_occurrence`, `default_aggregate`, `default_deductible` |
| `Submission` | `id`, `venue_id`, `assigned_producer_id`, `status` (`SubmissionStatus`), `effective_date`, `coverage_lines` (JSON list), `requested_limits` (JSON dict, money as strings), `notes`, `prior_policy_id`, `submitted_at`, `bound_at`, `created_at`, `updated_at` |
| `CarrierQuote` | `id`, `submission_id`, `carrier_id`, `status` (`QuoteStatus`), `is_selected`, `premium_breakdown` (JSON, money as strings), `coverage_terms` (JSON), `expires_at`, `decline_reason`, `underwriter_name`, `requested_at`, `responded_at`, `quote_pdf_path` |

### 3.2 Lifecycles (`backend/app/lifecycles.py`)

```
SubmissionStatus:  open → in_market → quoting → {bound, lost, withdrawn}
                                              ↓
                                          declined (from in_market)

QuoteStatus:       requested → pending → quoted → {bound, expired, withdrawn}
                                                ↓
                                            declined
```

### 3.3 Service (`backend/app/services/submissions.py`)

```python
create_submission(session, *, venue_id, effective_date, coverage_lines,
                  requested_limits, producer_id, notes, actor_id) -> Submission

submit_to_market(session, submission_id, *, target_carriers,
                 submitted_by, allow_out_of_appetite=False) -> SubmitToMarketResult
    # Per-carrier appetite check via check_appetite(). Matches → CarrierQuote
    # (status='requested'); mismatches → rejected_carriers unless override.
    # Transitions Submission: open → in_market.

record_carrier_response(session, quote_id, *, status, premium_breakdown,
                        coverage_terms, decline_reason, expires_at,
                        underwriter_name, recorded_by) -> CarrierQuote
    # Validates premium_breakdown sum-check for status='quoted' (raises
    # PremiumBreakdownMismatchError on drift). First quoted/declined
    # response also transitions Submission: in_market → quoting.

select_quote(session, quote_id, *, selected_by) -> CarrierQuote
    # Sets is_selected=True. Clears is_selected on siblings on the same
    # submission. The selected quote is what bind_quote() acts on.

withdraw_submission(session, submission_id, *, reason, withdrawn_by) -> Submission
list_submissions(session, *, status_in, venue_id, producer_id) -> list[Submission]
```

### 3.4 Pricing (`backend/app/underwriting/pricing.py`)

`build_quote_for_carrier(*, venue, coverage_lines, carrier_id, market_type, risk_score, requested_limits)` produces a `FullQuote` with per-line breakdown, fees, surplus-lines tax (3.76% NY on E&S only), and commission. Each carrier has venue and line multipliers on top of shared `BASE_RATES` — see `CARRIER_RATES`. The result's `.to_json_dict()` is what `CarrierQuote.premium_breakdown` stores.

### 3.5 API (`backend/app/api/v1/placement.py`)

```
POST   /api/submissions                     create_submission
GET    /api/submissions                     list_submissions (filter: status, venue, producer)
GET    /api/submissions/{sid}               detail (with quotes)
POST   /api/submissions/{sid}/submit        submit_to_market (body: target_carriers)
POST   /api/submissions/{sid}/withdraw      withdraw_submission
GET    /api/submissions/transitions         transition matrix (for kanban gates)
POST   /api/quotes/{qid}/response           record_carrier_response
POST   /api/quotes/{qid}/select             select_quote
GET    /api/quotes/{qid}                    quote detail
GET    /api/carriers                        list seeded carriers
```

### 3.6 Frontend (`frontend/src/app/submissions/`)

- `/submissions` — kanban grouped by status with drag-to-transition.
- `/submissions/[sid]` — detail with carrier quotes table, select, and bind action.
- `/submissions/new` — wizard.

---

## 4. Phase 2 — Policy lifecycle

### 4.1 Schema additions

| Table | Key shape |
|---|---|
| `Policy` | `id`, `policy_number` (nullable until carrier issues it), `submission_id`, `bound_quote_id`, `venue_id`, `carrier_id`, `status` (`PolicyStatus`), `effective_date`, `expiration_date`, `annual_premium`, `commission_amount`, `commission_rate`, `coverage_lines` (JSON list), `terms_snapshot` (JSON), `snapshot_hash`, cancellation fields (`cancelled_at`, `cancellation_reason`, `cancellation_method`, `refund_amount`), `bound_at` |
| `Endorsement` | `id`, `policy_id`, `endorsement_type`, `effective_date`, `description`, `premium_change`, `tax_change`, `terms_diff` (JSON, Pydantic-validated discriminated union), `issued_at`, `created_by` |
| `CertificateOfInsurance` | `id`, `policy_id`, `certificate_holder`, `certificate_holder_address`, `additional_insured`, `additional_insured_scope` ("ongoing_operations" \| "completed_operations" \| "single_event"), `description_of_operations`, `status` (active/superseded/cancelled), `issued_at`, `expires_on`, `pdf_path`, `issued_by` |

### 4.2 Policy lifecycle

```
PolicyStatus:
   bound_pending_number → active → {cancelled, non_renewed, lapsed, expired}
                       │
                       └→ cancelled
   lapsed → active     (carrier reinstates after late premium payment)
```

### 4.3 Service (`backend/app/services/policies.py`)

```python
bind_quote(session, quote_id, *, policy_number=None, effective_date=None,
           term_length_days=365, bound_by) -> Policy
    # ATOMIC. 6 effects (see §2.6). Pulls money from quote.premium_breakdown.
    # status='active' if policy_number passed at bind time; else 'bound_pending_number'.

assign_policy_number(session, policy_id, *, policy_number, assigned_by) -> Policy
    # Transitions bound_pending_number → active. Re-hashes (number is part of snapshot).

issue_endorsement(session, policy_id, *, endorsement_type, effective_date,
                  terms_diff, premium_change, tax_change, description, issued_by) -> Endorsement
    # Validates terms_diff against a per-endorsement_type Pydantic schema in
    # app.schemas.policy. Appends to terms_snapshot.endorsement_history.
    # Adjusts annual_premium by premium_change. Re-hashes policy.

cancel_policy(session, policy_id, *, reason, method, cancellation_date,
              cancelled_by, short_rate_penalty=DEFAULT_SHORT_RATE_PENALTY) -> Policy
    # method='pro_rata' | 'short_rate'. compute_refund() is pure — see tests.
    # short_rate refund = pro_rata_refund * (1 - short_rate_penalty).
    # Status → cancelled. Hash unchanged (status mutation).

issue_certificate(session, policy_id, *, certificate_holder, ..., issued_by) -> COI
    # Supersedes any prior active COI to the same certificate_holder on the
    # same policy — audit-preserving (sets prior to 'superseded', never deletes).

list_policies / policy_for_venue (read helpers)
```

### 4.4 API (`backend/app/api/v1/policies.py`)

```
POST   /api/quotes/{qid}/bind                  bind_quote
GET    /api/policies                           list_policies (filter: status, venue, carrier)
GET    /api/policies/{pid}                     detail (with endorsements + certificates)
PATCH  /api/policies/{pid}/policy-number       assign_policy_number
POST   /api/policies/{pid}/cancel              cancel_policy
POST   /api/policies/{pid}/endorsements        issue_endorsement
GET    /api/policies/{pid}/endorsements        list endorsements
POST   /api/policies/{pid}/certificates        issue_certificate
GET    /api/policies/{pid}/certificates        list COIs (?include=superseded for history)
GET    /api/certificates/{coi_id}/pdf          PDF stub (real PDF is Phase 5)
```

Error mapping: `PoliciesError → 400`, `QuoteNotBindableError → 422`, `InvalidTransitionError → 422`, `EndorsementValidationError → 422` (all structured with `{error, message}`).

### 4.5 Frontend (`frontend/src/app/policies/`)

- `/policies` — list, filterable by status, with "Show all (incl. cancelled / expired)" toggle.
- `/policies/[pid]` — detail with endorsement history + COI list.
- `/policies/[pid]/endorse` — issue endorsement.
- `/policies/[pid]/certificates/new` — issue COI.

---

## 5. Phase 3 — Claims integration (carrier-side)

### 5.1 Schema additions

| Table | Key shape |
|---|---|
| `Claim` | `id`, `policy_id`, `incident_id` (optional FK to `IncidentRecord`), `proposal_id` (optional FK to `ClaimProposal`), `carrier_claim_number`, `coverage_line`, `status` (`ClaimStatus`), `date_of_loss`, `fnol_submitted_at`, denormalized running totals (`current_reserve`, `indemnity_paid_to_date`, `expense_paid_to_date`, `recoveries_to_date`), `final_indemnity`, `total_incurred`, `closed_at`, `reopened_at`, `reopen_count`, `adjuster_name`, `adjuster_email`, `defense_package_id` (FK to `UnderwritingPacket`, **`ON DELETE RESTRICT`**), `snapshot_hash` |
| `ClaimPayment` | `id`, `claim_id`, `payment_type` ("indemnity" \| "expense" \| "recovery"), `amount`, `paid_on`, `description`, `recorded_by`, `recorded_at` |
| `ReserveChange` | `id`, `claim_id`, `from_amount`, `to_amount`, `change_reason`, `received_from`, `received_at`, `recorded_by`, `recorded_at` |

### 5.2 Claim lifecycle

```
ClaimStatus:
   notified → acknowledged → under_investigation → reserved → settling
                                                            ↘
                                                              closed_paid / closed_denied / closed_dropped
                                                                          ↓
                                                                     reopened → {reserved, settling, closed_*}

  Closed claims are NEVER truly terminal — subrogation, late-discovered info,
  fraud investigations can reopen.
```

`CLAIM_TERMINAL_STATES = frozenset()` reflects this.

### 5.3 Service (`backend/app/services/claims.py`)

```python
file_fnol(session, *, policy_id, coverage_line, date_of_loss, filed_by,
          incident_id=None, proposal_id=None, defense_package_id=None,
          carrier_claim_number=None, adjuster_name=None, adjuster_email=None) -> Claim
    # Validates: policy not in {cancelled, expired, non_renewed, lapsed},
    # coverage_line on policy, date_of_loss within term, defense_package
    # exists. Status='notified'. Emits claim.fnol audit event.

record_carrier_reserve(session, claim_id, *, new_reserve, change_reason,
                       received_from, received_at, recorded_by) -> Claim
    # Broker RECORDS the carrier's reserve (carriers set reserves, not brokers).
    # Inserts ReserveChange row. Updates Claim.current_reserve.
    # First reserve auto-hops notified → acknowledged → reserved (a carrier
    # setting a reserve implicitly acknowledges the claim).

record_payment(session, claim_id, *, amount, payment_type, paid_on,
               description, recorded_by) -> ClaimPayment
    # payment_type: 'indemnity' | 'expense' | 'recovery'.
    # All amounts positive; recoveries are subtracted at close, not stored signed.
    # First indemnity auto-transitions reserved → settling.
    # Rejects on notified/acknowledged/closed_* — needs reserve posted, not closed.

close_claim(session, claim_id, *, disposition, final_indemnity=None, closed_by) -> Claim
    # disposition: 'paid' | 'denied' | 'dropped' → closed_paid | closed_denied | closed_dropped.
    # final_indemnity is REQUIRED when disposition='paid'.
    # Computes total_incurred = indemnity_paid + expense_paid - recoveries.

reopen_claim(session, claim_id, *, reason, reopened_by) -> Claim
    # closed_* → reopened. Sets reopened_at, increments reopen_count.
    # Does NOT clear final_indemnity / total_incurred — those are historical.

attach_defense_package_to_claim(session, claim_id, *, defense_package_id, attached_by) -> Claim
    # Post-FNOL packet attachment / replacement. Re-hashes (packet id is in snapshot).

claims_for_policy / payments_for_claim / reserve_history_for_claim (read helpers)
```

### 5.4 API (`backend/app/api/v1/claims.py`)

```
POST   /api/policies/{pid}/claims          file_fnol
GET    /api/policies/{pid}/claims          claims_for_policy (filter: status)
GET    /api/claims/{cid}                   detail (with payments + reserve_changes)
POST   /api/claims/{cid}/carrier-reserve   record_carrier_reserve
GET    /api/claims/{cid}/reserve-history   list ReserveChange rows
POST   /api/claims/{cid}/payments          record_payment
GET    /api/claims/{cid}/payments          list ClaimPayment rows
POST   /api/claims/{cid}/close             close_claim
POST   /api/claims/{cid}/reopen            reopen_claim
POST   /api/claims/{cid}/defense-package   attach_defense_package_to_claim
```

Error mapping: `ClaimsError → 400`, `InvalidTransitionError → 422`.

### 5.5 Frontend (shipped 2026-05-23)

Phase 3 frontend is built (commit `17b2e04`):

- **`/claims/[cid]`** — carrier-claim detail: total-incurred headline, `ClaimLifecycleStrip` + `ClaimStatusPill`, financial summary tiles (reserve / indemnity / expense / recoveries), and a broker-only `ClaimActionToolbar` with keyboard shortcuts (R/P/C/O/D) driving five action modals: record reserve, record payment, close, reopen, attach defense package.
- **Payment ledger + reserve history** render inline in `claims/[cid]/page.tsx` (the `PaymentLedger` function at the bottom of the file — *not* a standalone `PaymentLedger.tsx` component, despite earlier plan wording).
- **`/claims`** — carrier-side claims list across the broker's book, via a single cross-policy `GET /api/claims` call (`claimsApi.listClaims`, shipped slice 4 / commit `685d052`); policy metadata for the referenced policies is fetched in parallel for the table rows.
- `ClaimProposal` rows moved to **`/claim-proposals`** (renamed from the old `/claims`, commit `894fb45`). Don't reintroduce the old path.

---

## 6. Demo data

`backend/scripts/seed_demo_placements.py` produces:

- `sub-demo-open` — status=`open`, elsewhere-brooklyn
- `sub-demo-market` — status=`in_market`, brooklyn-mirage, sent to Brit + Atrium
- `sub-demo-quoting` — status=`quoting`, house-of-yes, two quoted responses, cheaper selected
- `sub-demo-bound` — status=`bound`, nowadays, bound through Burns & Wilcox
- `pol-...` — the resulting Policy (`BW-DEMO-2026-0001`, active)

Idempotent: skips if any `sub-demo-*` row already exists. Run:

```powershell
cd backend
python -m scripts.seed_demo_placements
```

Note: `Carrier.check_appetite` is case-sensitive on `venue_type`. The script uses `nowadays` ("outdoor bar and music venue") instead of `market-hotel` ("DIY music venue and bar", title-case) because Burns & Wilcox's appetite list has the latter lowercase. File a follow-up to normalize case in `check_appetite` if this trips up other paths.

---

## 7. Testing

- `backend/tests/test_submissions_service.py` — Phase 1 service unit tests
- `backend/tests/test_policies_service.py`, `test_policies_api.py` — Phase 2 service + HTTP
- `backend/tests/test_claims_service.py` — Phase 3 service unit tests
- `backend/tests/test_submission_carrierquote_schema.py`, `test_policy_schema.py` — schema characterization
- `backend/tests/test_phase_1.py` — pricing characterization tests (62 cases pinning every (venue × tier × billing) cell)

**As of 2026-05-24:** 573 backend tests pass (was 552 on 2026-05-21; +21 from the Phase A tenant-isolation suite and the Phase B v1-API migration).

---

## 8. What's next (Phases 4–7)

From `plans/sleepy-prancing-clover.md` — not yet shipped:

- **Phase 4 — Renewals.** No new tables (`Submission.prior_policy_id` covers it). `services/renewals.py` + `/api/renewals/*`.
- **Phase 5 — Defense package.** `Claim.defense_package_id` (additive, already on the schema). `services/defense_packages.py` with `reportlab` PDF generation.
- **Phase 6 — Loss runs + carrier reporting.** New `LossRun` table. `services/loss_runs.py` + CSV/PDF exports.
- **Phase 7 — Underwriting transparency.** `services/underwriting_breakdown.py` + `PremiumDerivationTree` frontend component.

The Phase 3 frontend shipped on 2026-05-23 (see §5.5), so **Phase 4 (Renewals) is the next open slice.**
