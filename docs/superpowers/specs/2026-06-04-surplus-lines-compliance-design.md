# Surplus-Lines Compliance — Design

**Date:** 2026-06-04
**Status:** Approved (brainstorming → spec)
**Scope:** Full module + documents, surfaced on backend + broker web view.

## Goal

Make the broker platform handle the regulatory mechanics that a New York
**excess & surplus lines (E&S)** placement actually requires: prove the
admitted market declined the risk (diligent search), compute and track the
surplus-lines tax + ELANY stamping-fee filing, and produce the statutory
documents. The value is **encoding the real E&S rules and refusing to file
when the diligent search is incomplete** — not the arithmetic, which is
incidental.

## Why this is worth building

A generic broker CRM models submissions → quotes → policies. It does **not**
model the E&S regulatory layer, which is exactly where nightlife/venue brokers
(the ThirdSpaceRisk problem space) live, because almost everything they place
is non-admitted. Getting this right signals domain competence; the most common
ways people get it wrong are encoded here as guardrails.

## Verified regulatory figures (NY)

All figures verified 2026-06-04 against primary sources, not memory:

| Figure | Value | Source |
|---|---|---|
| NY excess line premium tax | **3.6%** (`0.036`) on gross premium when NY is the insured's home state | [DFS Excess Lines Broker Premium Tax Statement](https://www.dfs.ny.gov/apps_and_licensing/agents_and_brokers/excess_line_broker_premium_tax_statement), [DFS OGC 02-10-07](https://www.dfs.ny.gov/insurance/ogco2002/rg021007.htm) |
| ELANY stamping fee | **0.15%** (`0.0015`) for policies incepting on/after Jan 1 2023 | [ELANY Fees / Procedures Manual](https://www.elany.org/procedures-manual?d=1213) |
| Diligent search | **3 declinations** from authorized insurers before placing E&S | [NY Insurance Law §2118](https://www.nysenate.gov/legislation/laws/ISC/2118) |
| Export List exemption | Reg 41, 11 NYCRR §27.3(g) — listed coverages need no declination | [DFS Circular Letter No. 18 (2009)](https://www.dfs.ny.gov/industry_guidance/circular_letters/cl2009_18) |
| Diligent-search affidavit | Submitted to ELANY affirming the diligent effort via the 3 declinations | [ELANY Affidavit Part A](https://ogs.ny.gov/system/files/documents/2021/09/elany-part-a.pdf) |
| Filing deadline | **45 days** from binding to submit binder/confirmation to ELANY | [ELANY Association Filing Procedures](https://www.elany.org/procedures-manual?d=1210) |

### Existing-code correction (in scope)

`app/underwriting/pricing.py` currently has `NY_SURPLUS_LINES_TAX = Decimal("0.0376")`,
which is **wrong** — NY's rate is 3.6%. It also conflates tax and stamping into
one constant, which is the wrong *model* (they are separate line items on
separate purposes). This work:

1. Corrects `NY_SURPLUS_LINES_TAX` to `Decimal("0.036")` in `pricing.py`. This
   is the **only** change to `pricing.py` — the tax rate.
2. Updates the 62 `tests/test_phase_1.py` characterization tests, whose expected
   premium cells (including `surplus_lines_tax`) pin the old rate.

The **stamping fee is NOT added to the quote engine**. It lives only in the new
`surplus_lines.py` module and appears on the *filing* (the broker's regulatory
remittance to ELANY), not on the insured-facing quote breakdown. This keeps the
pricing blast radius to the single tax-rate cell, and keeps a clean boundary:
the quote shows the premium + tax the insured pays; the filing adds the broker's
separate stamping obligation.

**Reconciliation is tax-only**: the filing's `surplus_lines_tax` (computed in
`surplus_lines.py` at `0.036`) must equal the quote breakdown's
`surplus_lines_tax` (computed in `pricing.py` at `0.036` after the fix) — one
correct source of truth for the tax, verified by a test.

## Architecture

Ten units, each with one responsibility. Net-new files isolate the feature;
the only existing-file touches are the rate fix, the bind hook, the lifecycle
block, the model additions, and router registration.

### 1. Rates + rules helper — `app/underwriting/surplus_lines.py` (new)

Pure, no DB. Holds verified NY figures and the diligent-search rule.

- Import `NY_SURPLUS_LINES_TAX` from `pricing.py` (single source of truth after
  the fix); define `NY_STAMPING_FEE = Decimal("0.0015")` and
  `REQUIRED_DECLINATIONS = 3`.
- `STATE_RATES: dict[str, StateRates]` keyed by state code, `"NY"` only today —
  the extension seam the existing `pricing.py` comment anticipates (promote to a
  `StateTaxRule` table when the brokerage leaves NY).
- `@dataclass SurplusLinesCharges`: `tax`, `stamping_fee`, `total_charges`
  (all `Decimal`).
- `compute_sl_charges(taxable_premium: Decimal, *, state: str = "NY") -> SurplusLinesCharges`
  — `tax = usd(taxable_premium * rate)`, `stamping_fee = usd(taxable_premium * stamping)`,
  `total_charges = tax + stamping_fee`. Uses `app.money.usd` for rounding.
- `diligent_search_complete(declination_count: int, *, export_list_exempt: bool) -> bool`
  — `export_list_exempt or declination_count >= REQUIRED_DECLINATIONS`.

**Taxable base** is `subtotal + policy_fee` from the policy's frozen
`terms_snapshot["premium_breakdown"]` — *not* `annual_premium` (which already
includes the tax), matching how `pricing.py` applies the tax.

### 2. Models — `app/models.py` (two fresh tables → JSONB-safe on Neon)

`SurplusLinesFiling` (one per bound E&S policy):
- `id: str` (`"slf-<uuid12>"`), `policy_id` (FK `policy.id`, unique index),
  `venue_id` (FK `venue.id`, index), `state: str = "NY"`.
- `status: str = "pending"` (see lifecycle).
- Money (`Numeric(12,2)`): `taxable_premium`, `surplus_lines_tax`,
  `stamping_fee`, `total_charges`.
- `filing_deadline: date` (= bind date + 45 days).
- `filed_at`, `confirmed_at` (Optional `datetime`).
- `diligent_search_complete: bool = False`, `export_list_exempt: bool = False`.
- `transaction_id: Optional[str]` — mock ELANY confirmation id, set on confirm.
- `documents: dict` (JSON) — `{kind: storage_path}` for the 3 PDFs.
- `created_at`, `updated_at` (`default_factory=now_utc`).

`Declination` (keyed on **submission** — diligent search precedes binding):
- `id: str` (`"decl-<uuid12>"`), `submission_id` (FK `submission.id`, index).
- `carrier_name: str` (free text — admitted carriers aren't in our `Carrier`
  table), `carrier_naic: Optional[str]`.
- `declined_at: date`, `reason: str`, `recorded_by: Optional[str]`, `created_at`.

### 3. Lifecycle — `app/lifecycles.py` (new block)

```python
SurplusLinesFilingStatus = Literal["pending", "filed", "confirmed", "void"]

SL_FILING_TRANSITIONS: dict[str, set[str]] = {
    "pending":   {"filed", "void"},
    "filed":     {"confirmed", "void"},
    "confirmed": {"void"},   # void allowed for corrections; otherwise terminal
    "void":      set(),
}

SL_FILING_TERMINAL_STATES = frozenset(
    s for s, n in SL_FILING_TRANSITIONS.items() if not n
)
```

Exposed via `transition_table_to_json` for the UI, like every other entity.

### 4. Service — `app/services/surplus_lines.py` (new)

Raises `SurplusLinesError` (→ 400) and `InvalidTransitionError` (→ 422). No
commits inside the service (API/test owns the transaction).

- `record_declination(session, submission_id, *, carrier_name, reason, declined_at, carrier_naic=None, recorded_by=None) -> Declination`.
- `create_filing_for_policy(session, policy, *, actor_id) -> SurplusLinesFiling`
  — reads the taxable base from `terms_snapshot`, calls `compute_sl_charges`,
  sets `filing_deadline`, derives `diligent_search_complete` from the
  submission's declinations, emits audit `surplus_lines_filing.pending`.
  **Idempotent** (returns the existing filing if one exists for the policy).
- `_transition_filing(session, row, *, to, actor_id, metadata)` —
  `assert_valid_transition(SL_FILING_TRANSITIONS, ...)` + `_add_audit_event`,
  stamps `filed_at` / `confirmed_at`, sets `transaction_id` on confirm.
- `file_filing(session, filing_id, *, actor_id)` — **guard**: raises
  `SurplusLinesError` unless `diligent_search_complete`. On success generates +
  stores the 3 documents and records their paths, then transitions
  `pending → filed`.
- `confirm_filing(session, filing_id, *, transaction_id, actor_id)` —
  `filed → confirmed`.
- `void_filing(session, filing_id, *, reason, actor_id)`.
- `recompute_diligent_search(session, filing) -> SurplusLinesFiling` —
  recounts the submission's declinations and updates the flag.
- `filings_needing_attention(session) -> list[...]` — derived query: bound E&S
  policies with no filing, or an unfiled filing past `filing_deadline`. **A
  derived read, not a persisted `ComplianceSignal`** — deliberately, to avoid
  coupling to the signal-count invariants that have caused test fragility.

### 5. Documents — `app/surplus_lines_docs.py` (new)

Three `render_*(...) -> bytes` functions using the **same lazy-`reportlab`
pattern as `defense_package.render_defense_pdf`**:
- `render_diligent_search_affidavit(filing, declinations, venue)`.
- `render_sl_tax_statement(filing, policy, venue)`.
- `render_nonadmitted_disclosure(filing, policy, venue, carrier)`.

All bytes are stored through `app.storage.get_storage()` — never raw `open()`.

### 6. API — `app/api/v1/surplus_lines.py` (new, broker-scoped)

`require_broker`; operators scoped to their own venue via `can_access_venue`.
Router translates service errors with the existing `_map_service_error` pattern.

- `GET /surplus-lines/filings` — list (broker: all; optional `?status=`,
  `?venue=`).
- `GET /surplus-lines/filings/{id}` — detail: charge breakdown, declinations,
  deadline, document availability.
- `POST /surplus-lines/filings/{id}/file`
- `POST /surplus-lines/filings/{id}/confirm` (body: `transaction_id`)
- `POST /surplus-lines/filings/{id}/void` (body: `reason`)
- `POST /surplus-lines/declinations` (body: `submission_id`, `carrier_name`,
  `reason`, `declined_at`, optional `carrier_naic`)
- `GET /surplus-lines/filings/{id}/documents/{kind}` —
  `kind ∈ {affidavit, tax_statement, disclosure}`, streams the stored PDF.
- `GET /surplus-lines/transitions` — lifecycle matrix for the UI.

### 7. Bind integration — `app/services/policies.py` (modify `bind_quote`)

After the `Policy` is created, if the bound carrier's `market_type == "e&s"`,
call `create_filing_for_policy(...)` — **atomic within the bind**, no separate
commit. Admitted policies get no filing.

### 8. Web — `frontend/src/app/surplus-lines/` (new route)

- Own `layout.tsx` (AppShell is a per-page-dir layout) + `page.tsx`.
- Broker nav entry under a **"Compliance"** grouping in `AppShell.tsx`.
- **List**: venue · policy # · status badge · total charges · deadline (overdue
  highlighted).
- **Detail**: charge breakdown (tax + stamping + total), diligent-search
  checklist (declinations vs. `REQUIRED_DECLINATIONS`, export-exempt note),
  File / Confirm / Void actions, document download links.
- All fetches use `authHeaders()`; check `res.ok`. Route guard allows broker +
  venue-scoped operator.

### 9. Seed — `scripts/seed_surplus_lines.py` (new, idempotent)

- `pol-demo-1` (nowadays, E&S Burns & Wilcox) → filing **+ 3 declinations →
  diligent search complete → fileable**.
- `EB-DEMO-2026-0001` (operator's in-force policy) → filing with **only 2
  declinations → incomplete**, so the demo shows the file-guard *blocking* a
  premature filing and the "needs attention" surface working.

## Data flow

```
submission ──(broker records admitted declines)──▶ Declination[] (≥3)
   │
   ▼  bind_quote (E&S carrier)
Policy ──(auto)──▶ SurplusLinesFiling[pending]
   │                 charges = compute_sl_charges(taxable_base)
   │                 deadline = bind_date + 45d
   │                 diligent_search_complete = (≥3 declines or exempt)
   ▼  file_filing  (REFUSED if diligent search incomplete)
[filed] ──▶ generate + store {affidavit, tax_statement, disclosure}
   │
   ▼  confirm_filing(transaction_id)
[confirmed]
```

## Error handling

- File without complete diligent search → `SurplusLinesError` → **400**.
- Illegal lifecycle transition → `InvalidTransitionError` → **422**.
- Unknown filing / document kind → **404**.
- Operator accessing another venue's filing → **403** via `can_access_venue`.
- All transitions emit `app.packet_core._add_audit_event` with
  `event_type=f"surplus_lines_filing.{to_state}"`.

## Testing (TDD)

- **Charges** (`tests/test_surplus_lines.py`): characterization — known
  taxable base → exact tax (`× 0.036`), stamping (`× 0.0015`), total; the
  filing's tax equals the quote breakdown's `surplus_lines_tax` (reconciliation).
- **Diligent search**: 3 → complete; 2 → incomplete; 0 + exempt → complete.
- **Lifecycle**: every valid transition; each illegal one raises.
- **File guard**: refuses (`SurplusLinesError`) when diligent search incomplete;
  succeeds + stores 3 docs when complete.
- **Bind hook**: E&S bind auto-creates a filing; admitted bind does not.
- **Documents**: each renderer returns non-empty bytes; path recorded in
  `filing.documents`.
- **API**: list/detail/file/confirm/void; broker sees all, operator scoped
  (403 cross-venue); error mapping.
- **Pricing fix**: `tests/test_phase_1.py` expected premium cells updated for
  `0.036`; suite stays green.
- **Isolation**: throwaway venue ids + unique external ids per the standing
  shared-DB-pollution lesson; past-dated where a policy must be in force.

## Out of scope (YAGNI)

- Multi-state rate tables (NY only; seam left for later).
- Endorsement-driven amended filings (no `amended` state).
- Real ELANY electronic submission (transaction id is mocked).
- The annual aggregate premium-tax statement (per-transaction filing only).
- Mobile surface (SL filing is a back-office desk task).
