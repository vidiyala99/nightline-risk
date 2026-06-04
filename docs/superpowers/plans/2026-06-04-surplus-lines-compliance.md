# Surplus-Lines Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a New York E&S surplus-lines compliance module — diligent-search documentation, tax + ELANY stamping filing with a lifecycle, and statutory PDFs — surfaced on a broker web view.

**Architecture:** Two fresh tables (`SurplusLinesFiling`, `Declination`); a pure rates/rules helper; a service that auto-creates a filing when an E&S quote binds and refuses to file until the 3-declination diligent search is complete; reportlab document renderers stored via `get_storage()`; a broker-scoped router; a Next.js broker page. The existing wrong NY tax constant is corrected as the first task.

**Tech Stack:** FastAPI + SQLModel, pytest, reportlab, Next.js App Router, PowerShell (Windows). Money is `Decimal` via `app.money`; all dollars in JSON columns are strings.

**Spec:** `docs/superpowers/specs/2026-06-04-surplus-lines-compliance-design.md`

**Conventions to honor (from CLAUDE.md):**
- Money: `Decimal`, `Numeric(12,2)` columns, JSON money as strings via `app.money`.
- Lifecycles: `Literal` + `TRANSITIONS` + `_transition_<entity>(...)` calling `assert_valid_transition`.
- Audit: every transition emits `app.packet_core._add_audit_event` with `event_type=f"{entity}.{to_state}"`.
- Services raise typed errors; routers translate (`SurplusLinesError → 400`, `InvalidTransitionError → 422`).
- Services do **not** commit; the API/test owns the transaction. `session.flush()` parents before FK children.
- Tests run from `backend/`: `python -m pytest -q`. Use throwaway venue/external ids and past-dated rows to avoid shared-DB (`database.db`) pollution. If a run wedges on stale rows: `Get-ChildItem -Filter "database.db*" | Remove-Item -Force`.
- Commit messages: short subject + tight bullets, via PowerShell here-string (`$msg = @'...'@; $msg | git commit -F -`). Push to `main` directly.

---

## File Structure

**Create:**
- `backend/app/underwriting/surplus_lines.py` — pure rates + rules + charge math.
- `backend/app/services/surplus_lines.py` — DB service: declinations, filing creation, lifecycle transitions, attention query.
- `backend/app/surplus_lines_docs.py` — reportlab renderers for the 3 statutory PDFs.
- `backend/app/api/v1/surplus_lines.py` — broker-scoped router.
- `backend/scripts/seed_surplus_lines.py` — idempotent demo seed.
- `backend/tests/test_surplus_lines.py` — full TDD suite.
- `frontend/src/app/surplus-lines/layout.tsx` + `page.tsx` — broker web view.

**Modify:**
- `backend/app/underwriting/pricing.py:39` — fix tax constant.
- `backend/app/models.py` — add `SurplusLinesFiling` + `Declination`.
- `backend/app/lifecycles.py` — add `SL_FILING_TRANSITIONS` block.
- `backend/app/services/policies.py` — `bind_quote` filing hook.
- `backend/app/main.py` — register router (~line 460).
- `frontend/src/components/layout/AppShell.tsx` — broker "Compliance" nav entry.
- Pricing characterization tests (revealed by the suite in Task 1).

---

## Task 1: Fix the wrong NY surplus-lines tax rate

**Files:**
- Modify: `backend/app/underwriting/pricing.py:35-39`
- Test: characterization tests across `tests/` (revealed by running the suite)

This is a deliberate, verified behavior change: NY's excess-line premium tax is **3.6%**, not 3.76% (verified against [NY DFS](https://www.dfs.ny.gov/apps_and_licensing/agents_and_brokers/excess_line_broker_premium_tax_statement) and [Insurance Law §2118](https://www.nysenate.gov/legislation/laws/ISC/2118)). The characterization tests pin *whatever the engine outputs*, so the correct new expected values are the engine's new actuals — regenerate them and spot-check one by hand.

- [ ] **Step 1: Establish the pre-change baseline**

Run: `cd backend; python -m pytest -q`
Expected: PASS (note the passing count, e.g. `1189 passed`). This is the green baseline you must restore.

- [ ] **Step 2: Change the constant and its comment**

In `backend/app/underwriting/pricing.py`, replace lines 35-39:

```python
# NY excess-line premium tax: 3.6% per NY Insurance Law §2118 / NY DFS.
# Per-state constant pending the StateTaxRule table that arrives when the
# brokerage expands beyond NY. Applied to E&S quotes only (admitted carriers
# are exempt). The ELANY stamping fee is a SEPARATE charge and lives in
# app/underwriting/surplus_lines.py — it is not part of the insured quote.
NY_SURPLUS_LINES_TAX: Decimal = Decimal("0.036")
```

- [ ] **Step 3: Run the suite to reveal the shifted assertions**

Run: `cd backend; python -m pytest -q`
Expected: FAIL. Failures are e&s premium/tax/total assertions whose expected literals were computed at 3.76%. Probable files (from grep): `test_pricing_carrier_aware.py`, `test_pricing_decimal_refactor.py`, `test_seed_broker_platform.py`, `test_placement_api.py`, `test_book_financials.py`, `test_policies_service.py`. Capture the full list of failing tests and their `assert <expected> == <actual>` lines.

- [ ] **Step 4: Spot-check one cell by hand before trusting the actuals**

Pick one failing e&s case. From its `premium_breakdown`, take `subtotal + policy_fee` (the pre-tax base) and confirm the engine's new `surplus_lines_tax` equals `usd(base * Decimal("0.036"))`. Example check in a Python REPL:

```python
from decimal import Decimal
from app.money import usd
base = Decimal("5500.00") + Decimal("150.00")   # subtotal + policy_fee from the case
assert usd(base * Decimal("0.036")) == Decimal("203.40")  # this is the new expected tax
```

Only proceed once one cell reconciles — that proves the new actuals are arithmetically right, not just "whatever the code now prints."

- [ ] **Step 5: Update each failing expected literal to the engine's new actual**

For every failing assertion, replace the old expected dollar literal with the new actual the test reports. These are characterization values; the engine is now the source of truth at the verified rate. Do not change test logic — only the pinned numbers.

- [ ] **Step 6: Restore green**

Run: `cd backend; python -m pytest -q`
Expected: PASS at the same count as Step 1.

- [ ] **Step 7: Commit**

```powershell
cd backend
git add app/underwriting/pricing.py tests/
$msg = @'
fix(pricing): correct NY surplus-lines tax 3.76% -> 3.6%

- NY excess-line premium tax is 3.6% per Insurance Law 2118 / DFS
- regenerate pricing characterization expectations at the correct rate
- stamping fee is separate; lands in the new surplus_lines module
'@; $msg | git commit -F -
```

---

## Task 2: Pure rates + rules helper

**Files:**
- Create: `backend/app/underwriting/surplus_lines.py`
- Test: `backend/tests/test_surplus_lines.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_surplus_lines.py`:

```python
from decimal import Decimal

from app.underwriting.surplus_lines import (
    NY_STAMPING_FEE,
    REQUIRED_DECLINATIONS,
    compute_sl_charges,
    diligent_search_complete,
)
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX


def test_tax_rate_is_corrected():
    assert NY_SURPLUS_LINES_TAX == Decimal("0.036")
    assert NY_STAMPING_FEE == Decimal("0.0015")
    assert REQUIRED_DECLINATIONS == 3


def test_compute_sl_charges_known_base():
    # base = subtotal + policy_fee
    charges = compute_sl_charges(Decimal("5650.00"))
    assert charges.tax == Decimal("203.40")          # 5650 * 0.036
    assert charges.stamping_fee == Decimal("8.48")    # 5650 * 0.0015 = 8.475 -> 8.48 (banker's)
    assert charges.total_charges == Decimal("211.88")


def test_diligent_search_rules():
    assert diligent_search_complete(3, export_list_exempt=False) is True
    assert diligent_search_complete(2, export_list_exempt=False) is False
    assert diligent_search_complete(0, export_list_exempt=True) is True
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py -v`
Expected: FAIL with `ModuleNotFoundError: app.underwriting.surplus_lines`.

- [ ] **Step 3: Implement the helper**

Create `backend/app/underwriting/surplus_lines.py`:

```python
"""New York excess & surplus lines (E&S) rates and rules.

The arithmetic is trivial; the value is encoding the *verified* NY figures and
the diligent-search rule in one place. Sources (verified 2026-06-04):
  - Premium tax 3.6%  — NY Insurance Law §2118 / NY DFS.
  - ELANY stamping 0.15% — policies incepting on/after 2023-01-01.
  - 3 declinations from authorized insurers — §2118; Export List (Reg 41,
    11 NYCRR §27.3(g)) exempts listed coverages.

The tax constant is shared with the quote engine (single source of truth);
the stamping fee lives ONLY here because it is the broker's regulatory
remittance, not part of the insured-facing quote.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import usd
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX

NY_STAMPING_FEE: Decimal = Decimal("0.0015")
REQUIRED_DECLINATIONS: int = 3


@dataclass(frozen=True)
class StateRates:
    tax: Decimal
    stamping: Decimal


# Extension seam: promote to a StateTaxRule table when the brokerage leaves NY.
STATE_RATES: dict[str, StateRates] = {
    "NY": StateRates(tax=NY_SURPLUS_LINES_TAX, stamping=NY_STAMPING_FEE),
}


@dataclass(frozen=True)
class SurplusLinesCharges:
    tax: Decimal
    stamping_fee: Decimal
    total_charges: Decimal


def compute_sl_charges(taxable_premium: Decimal, *, state: str = "NY") -> SurplusLinesCharges:
    """Compute SL tax + stamping fee on the taxable base (= subtotal + policy_fee).

    Not annual_premium — that already includes the tax."""
    rates = STATE_RATES.get(state)
    if rates is None:
        raise ValueError(f"No surplus-lines rates configured for state {state!r}")
    tax = usd(taxable_premium * rates.tax)
    stamping = usd(taxable_premium * rates.stamping)
    return SurplusLinesCharges(tax=tax, stamping_fee=stamping, total_charges=tax + stamping)


def diligent_search_complete(declination_count: int, *, export_list_exempt: bool) -> bool:
    """NY §2118: 3 declinations from authorized insurers, unless the coverage is
    on the Export List."""
    return export_list_exempt or declination_count >= REQUIRED_DECLINATIONS
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/underwriting/surplus_lines.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): NY E&S rates + diligent-search rule helper

- verified NY tax 3.6% (shared) + ELANY stamping 0.15% (separate)
- compute_sl_charges on the taxable base; diligent_search_complete rule
'@; $msg | git commit -F -
```

---

## Task 3: Data model — SurplusLinesFiling + Declination

**Files:**
- Modify: `backend/app/models.py` (append both classes near the broker-platform tables)
- Test: `backend/tests/test_surplus_lines.py`

Both are fresh tables, so SQLModel auto-creates them and they are JSONB-safe on Neon (no `_COLUMN_MIGRATIONS` entry needed — that allowlist is only for new columns on *existing* tables).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
from datetime import date

from sqlmodel import Session

from app.database import engine
from app.models import Declination, SurplusLinesFiling


def test_models_persist():
    with Session(engine) as s:
        f = SurplusLinesFiling(
            id="slf-test-1", policy_id="pol-x", venue_id="v-x",
            taxable_premium=Decimal("5650.00"), surplus_lines_tax=Decimal("203.40"),
            stamping_fee=Decimal("8.48"), total_charges=Decimal("211.88"),
            filing_deadline=date(2026, 7, 1),
        )
        d = Declination(
            id="decl-test-1", submission_id="sub-x",
            carrier_name="Acme Admitted", declined_at=date(2026, 5, 1),
            reason="outside appetite",
        )
        s.add(f); s.add(d); s.commit()
        assert f.status == "pending"
        assert f.diligent_search_complete is False
        assert d.reason == "outside appetite"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_models_persist -v`
Expected: FAIL with `ImportError: cannot import name 'SurplusLinesFiling'`.

- [ ] **Step 3: Implement the models**

In `backend/app/models.py`, after the `Policy` class block, add:

```python
class SurplusLinesFiling(SQLModel, table=True):
    """The NY E&S regulatory filing for one bound E&S Policy: tax + ELANY
    stamping fee owed, the 45-day filing deadline, and diligent-search status.
    Lifecycle in app.lifecycles.SL_FILING_TRANSITIONS."""
    id: str = Field(primary_key=True)                  # "slf-<uuid12>"
    policy_id: str = Field(foreign_key="policy.id", index=True, unique=True)
    venue_id: str = Field(foreign_key="venue.id", index=True)
    state: str = Field(default="NY")
    status: str = Field(default="pending", index=True)

    taxable_premium: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    surplus_lines_tax: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    stamping_fee: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    total_charges: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))

    filing_deadline: date
    filed_at: Optional[datetime] = None
    confirmed_at: Optional[datetime] = None

    diligent_search_complete: bool = False
    export_list_exempt: bool = False
    transaction_id: Optional[str] = None               # mock ELANY confirmation
    documents: dict = Field(default_factory=dict, sa_column=Column(JSON))

    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class Declination(SQLModel, table=True):
    """An authorized (admitted) insurer's decline of a Submission. NY §2118
    requires 3 before placing E&S (unless the coverage is Export-List exempt).
    Keyed on Submission because diligent search precedes binding."""
    id: str = Field(primary_key=True)                   # "decl-<uuid12>"
    submission_id: str = Field(foreign_key="submission.id", index=True)
    carrier_name: str                                   # free text; admitted carriers aren't in Carrier
    carrier_naic: Optional[str] = None
    declined_at: date
    reason: str
    recorded_by: Optional[str] = None
    created_at: datetime = Field(default_factory=now_utc)
```

Verify `Column`, `JSON`, `Numeric`, `date`, `datetime`, `now_utc`, `Optional`, `Field` are already imported at the top of `models.py` (they are — used by `Policy`/`Submission`). If `date` is imported section-locally (it is at line ~406), it is in scope for these classes which come after.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_models_persist -v`
Expected: PASS. (If it errors on a stale DB, run `Get-ChildItem backend -Filter "database.db*" | Remove-Item -Force` and retry.)

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/models.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): SurplusLinesFiling + Declination models

- filing per bound E&S policy (tax/stamping/total, deadline, docs)
- declination keyed on submission for the diligent-search trail
'@; $msg | git commit -F -
```

---

## Task 4: Lifecycle block

**Files:**
- Modify: `backend/app/lifecycles.py` (append a new section)
- Test: `backend/tests/test_surplus_lines.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
import pytest

from app.lifecycles import (
    SL_FILING_TRANSITIONS,
    InvalidTransitionError,
    assert_valid_transition,
)


def test_filing_lifecycle_matrix():
    assert SL_FILING_TRANSITIONS["pending"] == {"filed", "void"}
    assert SL_FILING_TRANSITIONS["filed"] == {"confirmed", "void"}
    assert SL_FILING_TRANSITIONS["void"] == set()
    assert_valid_transition(SL_FILING_TRANSITIONS, "pending", "filed", entity_name="filing")
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(SL_FILING_TRANSITIONS, "pending", "confirmed", entity_name="filing")
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_filing_lifecycle_matrix -v`
Expected: FAIL with `ImportError: cannot import name 'SL_FILING_TRANSITIONS'`.

- [ ] **Step 3: Implement the lifecycle block**

In `backend/app/lifecycles.py`, after the `ComplianceSignal` lifecycle block, add:

```python
# ─── SurplusLinesFiling lifecycle ────────────────────────────────────────

SurplusLinesFilingStatus = Literal["pending", "filed", "confirmed", "void"]

SL_FILING_TRANSITIONS: dict[str, set[str]] = {
    "pending":   {"filed", "void"},
    "filed":     {"confirmed", "void"},
    "confirmed": {"void"},   # void allowed for corrections; otherwise terminal
    "void":      set(),
}

SL_FILING_TERMINAL_STATES: frozenset[str] = frozenset(
    s for s, nexts in SL_FILING_TRANSITIONS.items() if not nexts
)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_filing_lifecycle_matrix -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/lifecycles.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): filing lifecycle (pending->filed->confirmed, void)
'@; $msg | git commit -F -
```

---

## Task 5: Service — declinations, filing creation, diligent-search recompute

**Files:**
- Create: `backend/app/services/surplus_lines.py`
- Test: `backend/tests/test_surplus_lines.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`. Use a helper that binds a real E&S policy via the seed path so the taxable base is real:

```python
from uuid import uuid4

from app.services.surplus_lines import (
    SurplusLinesError,
    create_filing_for_policy,
    record_declination,
    recompute_diligent_search,
)
from scripts.seed_demo_placements import seed as seed_placements


def _bound_demo_policy(session):
    """Seed the demo placements and return the bound E&S policy + its submission."""
    from app.models import Policy
    seed_placements(session)
    session.commit()
    pol = session.exec(
        __import__("sqlmodel").select(Policy).where(Policy.policy_number == "BW-DEMO-2026-0001")
    ).first()
    return pol


def test_create_filing_computes_charges_and_deadline():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        bd = pol.terms_snapshot["premium_breakdown"]
        base = Decimal(bd["subtotal"]) + Decimal(bd["fees"]["policy_fee"])
        assert filing.taxable_premium == base
        assert filing.surplus_lines_tax == Decimal(bd["fees"]["surplus_lines_tax"])  # reconciles
        assert filing.stamping_fee == (base * Decimal("0.0015")).quantize(Decimal("0.01"))
        assert filing.filing_deadline == pol.effective_date.fromordinal(
            pol.effective_date.toordinal()
        )  # placeholder; real assert below
```

Replace the deadline placeholder assertion with the real rule (deadline = bind date + 45 days). Since `bind_quote` stamps `bound_at`, the service uses `bound_at.date() + 45d`; assert accordingly:

```python
        from datetime import timedelta
        assert filing.filing_deadline == pol.bound_at.date() + timedelta(days=45)


def test_diligent_search_recompute_and_idempotent_create():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        assert filing.diligent_search_complete is False
        for i in range(3):
            record_declination(
                s, pol.submission_id, carrier_name=f"Admitted {i}",
                reason="outside appetite", declined_at=pol.effective_date,
            )
        s.commit()
        recompute_diligent_search(s, filing)
        s.commit()
        assert filing.diligent_search_complete is True
        # idempotent: re-create returns the same filing, doesn't duplicate
        again = create_filing_for_policy(s, pol, actor_id="user_001")
        assert again.id == filing.id
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py -k "create_filing or diligent_search_recompute" -v`
Expected: FAIL with `ModuleNotFoundError: app.services.surplus_lines`.

- [ ] **Step 3: Implement the service (part 1)**

Create `backend/app/services/surplus_lines.py`:

```python
"""Surplus-lines filing service. Services raise typed errors and never commit;
the API/test owns the transaction."""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

from sqlmodel import Session, select

from app.lifecycles import SL_FILING_TRANSITIONS, assert_valid_transition
from app.models import Carrier, Declination, Policy, SurplusLinesFiling
from app.money import usd
from app.packet_core import _add_audit_event
from app.time import now_utc
from app.underwriting.surplus_lines import (
    compute_sl_charges,
    diligent_search_complete,
)

FILING_DEADLINE_DAYS = 45  # NY/ELANY: 45 days from binding


class SurplusLinesError(Exception):
    """Domain error for surplus-lines operations (maps to HTTP 400)."""


def _declination_count(session: Session, submission_id: str) -> int:
    return len(
        session.exec(
            select(Declination).where(Declination.submission_id == submission_id)
        ).all()
    )


def record_declination(
    session: Session, submission_id: str, *, carrier_name: str, reason: str,
    declined_at, carrier_naic: str | None = None, recorded_by: str | None = None,
) -> Declination:
    row = Declination(
        id=f"decl-{uuid4().hex[:12]}", submission_id=submission_id,
        carrier_name=carrier_name, carrier_naic=carrier_naic,
        declined_at=declined_at, reason=reason, recorded_by=recorded_by,
    )
    session.add(row)
    session.flush()
    return row


def create_filing_for_policy(
    session: Session, policy: Policy, *, actor_id: str,
) -> SurplusLinesFiling:
    """Idempotent: returns the existing filing if one exists for the policy."""
    existing = session.exec(
        select(SurplusLinesFiling).where(SurplusLinesFiling.policy_id == policy.id)
    ).first()
    if existing is not None:
        return existing

    bd = (policy.terms_snapshot or {}).get("premium_breakdown", {})
    subtotal = Decimal(bd.get("subtotal", "0.00"))
    policy_fee = Decimal((bd.get("fees", {}) or {}).get("policy_fee", "0.00"))
    base = usd(subtotal + policy_fee)
    charges = compute_sl_charges(base)

    bind_date = (policy.bound_at or now_utc()).date()
    declines = _declination_count(session, policy.submission_id)

    filing = SurplusLinesFiling(
        id=f"slf-{uuid4().hex[:12]}", policy_id=policy.id, venue_id=policy.venue_id,
        taxable_premium=base, surplus_lines_tax=charges.tax,
        stamping_fee=charges.stamping_fee, total_charges=charges.total_charges,
        filing_deadline=bind_date + timedelta(days=FILING_DEADLINE_DAYS),
        diligent_search_complete=diligent_search_complete(declines, export_list_exempt=False),
    )
    session.add(filing)
    session.flush()
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="surplus_lines_filing", entity_id=filing.id,
        event_type="surplus_lines_filing.pending",
        event_metadata={"policy_id": policy.id, "total_charges": str(filing.total_charges)},
    )
    return filing


def recompute_diligent_search(
    session: Session, filing: SurplusLinesFiling,
) -> SurplusLinesFiling:
    pol = session.get(Policy, filing.policy_id)
    declines = _declination_count(session, pol.submission_id) if pol else 0
    filing.diligent_search_complete = diligent_search_complete(
        declines, export_list_exempt=filing.export_list_exempt
    )
    filing.updated_at = now_utc()
    session.add(filing)
    session.flush()
    return filing
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py -k "create_filing or diligent_search_recompute" -v`
Expected: PASS. (Reset `database.db*` if a prior partial seed wedges the run.)

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/services/surplus_lines.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): filing-creation service + declinations

- create_filing_for_policy (idempotent, reconciles tax with quote breakdown)
- record_declination + recompute_diligent_search; 45-day deadline
'@; $msg | git commit -F -
```

---

## Task 6: Service — lifecycle transitions + file guard

**Files:**
- Modify: `backend/app/services/surplus_lines.py`
- Test: `backend/tests/test_surplus_lines.py`

`file_filing` generates documents (Task 7 builds the renderers); to keep this task self-contained, implement the transition + guard now and call a `_generate_documents` function that this task defines as a stub returning `{}`, then Task 8 fills it in.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
from app.services.surplus_lines import confirm_filing, file_filing, void_filing


def test_file_guard_blocks_incomplete_diligent_search():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        with pytest.raises(SurplusLinesError):
            file_filing(s, filing.id, actor_id="user_001")  # 0 declinations


def test_file_then_confirm_happy_path():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        for i in range(3):
            record_declination(s, pol.submission_id, carrier_name=f"A{i}",
                               reason="appetite", declined_at=pol.effective_date)
        recompute_diligent_search(s, filing)
        s.commit()
        filed = file_filing(s, filing.id, actor_id="user_001")
        assert filed.status == "filed" and filed.filed_at is not None
        confirmed = confirm_filing(s, filing.id, transaction_id="ELANY-X", actor_id="user_001")
        assert confirmed.status == "confirmed" and confirmed.transaction_id == "ELANY-X"


def test_invalid_transition_raises():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        with pytest.raises(Exception):  # InvalidTransitionError: pending -> confirmed
            confirm_filing(s, filing.id, transaction_id="X", actor_id="user_001")
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py -k "file_guard or file_then_confirm or invalid_transition" -v`
Expected: FAIL with `ImportError: cannot import name 'file_filing'`.

- [ ] **Step 3: Implement transitions + guard**

Append to `backend/app/services/surplus_lines.py`:

```python
def _get_filing(session: Session, filing_id: str) -> SurplusLinesFiling:
    row = session.get(SurplusLinesFiling, filing_id)
    if row is None:
        raise SurplusLinesError(f"Unknown filing {filing_id!r}")
    return row


def _transition_filing(
    session: Session, filing: SurplusLinesFiling, *, to: str, actor_id: str, metadata: dict,
) -> None:
    assert_valid_transition(
        SL_FILING_TRANSITIONS, filing.status, to, entity_name="surplus_lines_filing"
    )
    filing.status = to
    filing.updated_at = now_utc()
    session.add(filing)
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="surplus_lines_filing", entity_id=filing.id,
        event_type=f"surplus_lines_filing.{to}", event_metadata=metadata,
    )


def _generate_documents(session: Session, filing: SurplusLinesFiling) -> dict:
    """Filled in by Task 8. Returns {kind: storage_path}."""
    return {}


def file_filing(session: Session, filing_id: str, *, actor_id: str) -> SurplusLinesFiling:
    filing = _get_filing(session, filing_id)
    if not filing.diligent_search_complete:
        raise SurplusLinesError(
            "Cannot file: diligent search incomplete "
            "(need 3 admitted-carrier declinations or an Export-List exemption)"
        )
    filing.documents = _generate_documents(session, filing)
    filing.filed_at = now_utc()
    _transition_filing(session, filing, to="filed", actor_id=actor_id,
                       metadata={"total_charges": str(filing.total_charges)})
    session.flush()
    return filing


def confirm_filing(
    session: Session, filing_id: str, *, transaction_id: str, actor_id: str,
) -> SurplusLinesFiling:
    filing = _get_filing(session, filing_id)
    filing.transaction_id = transaction_id
    filing.confirmed_at = now_utc()
    _transition_filing(session, filing, to="confirmed", actor_id=actor_id,
                       metadata={"transaction_id": transaction_id})
    session.flush()
    return filing


def void_filing(session: Session, filing_id: str, *, reason: str, actor_id: str) -> SurplusLinesFiling:
    filing = _get_filing(session, filing_id)
    _transition_filing(session, filing, to="void", actor_id=actor_id,
                       metadata={"reason": reason})
    session.flush()
    return filing
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py -k "file_guard or file_then_confirm or invalid_transition" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/services/surplus_lines.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): file/confirm/void transitions + diligent-search guard

- file_filing refuses until the 3-declination diligent search is complete
- confirm records the (mock) ELANY transaction id; all emit audit events
'@; $msg | git commit -F -
```

---

## Task 7: Statutory document renderers

**Files:**
- Create: `backend/app/surplus_lines_docs.py`
- Test: `backend/tests/test_surplus_lines.py`

Reuse the lazy-`reportlab` pattern from `app/defense_package.py:render_defense_pdf`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
from app.surplus_lines_docs import (
    render_diligent_search_affidavit,
    render_nonadmitted_disclosure,
    render_sl_tax_statement,
)
from app.models import Venue


def test_document_renderers_return_pdf_bytes():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        venue = s.get(Venue, pol.venue_id)
        carrier = s.get(Carrier, pol.carrier_id)
        decls = []
        for kind, pdf in [
            ("affidavit", render_diligent_search_affidavit(filing, decls, venue)),
            ("tax_statement", render_sl_tax_statement(filing, pol, venue)),
            ("disclosure", render_nonadmitted_disclosure(filing, pol, venue, carrier)),
        ]:
            assert isinstance(pdf, bytes) and pdf[:4] == b"%PDF", kind
```

(Add `from app.models import Carrier` to the test imports if not already present.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_document_renderers_return_pdf_bytes -v`
Expected: FAIL with `ModuleNotFoundError: app.surplus_lines_docs`.

- [ ] **Step 3: Implement the renderers**

Create `backend/app/surplus_lines_docs.py`:

```python
"""reportlab renderers for the NY E&S statutory documents. Same lazy-import
pattern as app/defense_package.render_defense_pdf — reportlab is only imported
when a document is actually rendered."""
from __future__ import annotations

from io import BytesIO


def _render(title: str, lines: list[str]) -> bytes:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter)
    styles = getSampleStyleSheet()
    flow = [Paragraph(title, styles["Title"]), Spacer(1, 12)]
    for ln in lines:
        flow.append(Paragraph(ln, styles["Normal"]))
        flow.append(Spacer(1, 6))
    doc.build(flow)
    return buf.getvalue()


def render_diligent_search_affidavit(filing, declinations, venue) -> bytes:
    vname = getattr(venue, "name", filing.venue_id)
    lines = [
        f"State: {filing.state}",
        f"Insured (venue): {vname}",
        f"Policy: {filing.policy_id}",
        "Pursuant to NY Insurance Law §2118, the producing broker affirms a "
        "diligent effort was made to place this risk with authorized insurers, "
        "which declined as follows:",
    ]
    if declinations:
        for d in declinations:
            lines.append(f"  • {d.carrier_name} — {d.reason} ({d.declined_at})")
    else:
        lines.append("  • (Export-List coverage — declinations not required)"
                     if filing.export_list_exempt else "  • (none recorded)")
    return _render("Excess Line Diligent Search Affidavit", lines)


def render_sl_tax_statement(filing, policy, venue) -> bytes:
    vname = getattr(venue, "name", filing.venue_id)
    lines = [
        f"Insured (venue): {vname}",
        f"Policy: {filing.policy_id}",
        f"Taxable premium (subtotal + policy fee): ${filing.taxable_premium}",
        f"Surplus lines premium tax (3.6%): ${filing.surplus_lines_tax}",
        f"ELANY stamping fee (0.15%): ${filing.stamping_fee}",
        f"Total charges remitted: ${filing.total_charges}",
        f"Filing deadline: {filing.filing_deadline}",
    ]
    return _render("Excess Line Premium Tax Statement", lines)


def render_nonadmitted_disclosure(filing, policy, venue, carrier) -> bytes:
    cname = getattr(carrier, "name", policy.carrier_id)
    vname = getattr(venue, "name", filing.venue_id)
    lines = [
        f"Insured (venue): {vname}",
        f"Insurer: {cname}",
        "NOTICE: This insurance is placed with an insurer not licensed to do "
        "business in New York State and is not subject to its financial "
        "supervision. If the insurer becomes insolvent, claims are NOT covered "
        "by the New York State guaranty fund.",
    ]
    return _render("Notice of Placement with a Non-Admitted Insurer", lines)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_document_renderers_return_pdf_bytes -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/surplus_lines_docs.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): statutory PDF renderers (affidavit, tax stmt, disclosure)
'@; $msg | git commit -F -
```

---

## Task 8: Wire documents into file_filing via storage

**Files:**
- Modify: `backend/app/services/surplus_lines.py` (`_generate_documents`)
- Test: `backend/tests/test_surplus_lines.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
def test_filing_stores_three_documents():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        for i in range(3):
            record_declination(s, pol.submission_id, carrier_name=f"A{i}",
                               reason="appetite", declined_at=pol.effective_date)
        recompute_diligent_search(s, filing)
        s.commit()
        filed = file_filing(s, filing.id, actor_id="user_001")
        assert set(filed.documents.keys()) == {"affidavit", "tax_statement", "disclosure"}
        for path in filed.documents.values():
            assert isinstance(path, str) and path
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_filing_stores_three_documents -v`
Expected: FAIL — `filed.documents` is `{}` (stub).

- [ ] **Step 3: Implement `_generate_documents`**

In `backend/app/services/surplus_lines.py`, add imports at the top:

```python
from app.models import Venue
from app.storage import get_storage
from app.surplus_lines_docs import (
    render_diligent_search_affidavit,
    render_nonadmitted_disclosure,
    render_sl_tax_statement,
)
```

Replace the stub `_generate_documents` with:

```python
def _generate_documents(session: Session, filing: SurplusLinesFiling) -> dict:
    policy = session.get(Policy, filing.policy_id)
    venue = session.get(Venue, filing.venue_id)
    carrier = session.get(Carrier, policy.carrier_id) if policy else None
    declines = session.exec(
        select(Declination).where(Declination.submission_id == policy.submission_id)
    ).all() if policy else []

    storage = get_storage()
    docs = {
        "affidavit": render_diligent_search_affidavit(filing, declines, venue),
        "tax_statement": render_sl_tax_statement(filing, policy, venue),
        "disclosure": render_nonadmitted_disclosure(filing, policy, venue, carrier),
    }
    paths: dict[str, str] = {}
    for kind, pdf in docs.items():
        key = f"surplus_lines/{filing.id}/{kind}.pdf"
        storage.save(key, pdf)
        paths[kind] = key
    return paths
```

Verify `app.storage.get_storage()` exposes a `save(key: str, data: bytes) -> str`-style method. If the actual method name differs (e.g. `put`/`write`), use that name — check `app/storage.py` for the `LocalStorage` write method and match it. The contract: persist `pdf` bytes under `key` and let the path be retrievable later.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_filing_stores_three_documents -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/services/surplus_lines.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): generate + store the 3 PDFs on file via get_storage()
'@; $msg | git commit -F -
```

---

## Task 9: Auto-create the filing when an E&S quote binds

**Files:**
- Modify: `backend/app/services/policies.py` (`bind_quote`, after `session.flush()` at ~line 345, before the `policy.bound` audit event)
- Test: `backend/tests/test_surplus_lines.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
def test_bind_autocreates_filing_for_es_only():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)  # burns-wilcox is e&s
        filing = s.exec(
            __import__("sqlmodel").select(SurplusLinesFiling).where(
                SurplusLinesFiling.policy_id == pol.id
            )
        ).first()
        assert filing is not None
        carrier = s.get(Carrier, pol.carrier_id)
        assert carrier.market_type == "e&s"
```

(If the demo carrier is somehow admitted, the test will surface it; the design assumes Burns & Wilcox is e&s, matching the seed which passes `market_type="e&s"`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_bind_autocreates_filing_for_es_only -v`
Expected: FAIL — no filing exists (bind doesn't create one yet).

- [ ] **Step 3: Add the bind hook**

In `backend/app/services/policies.py`, inside `bind_quote`, after `session.flush()` (line ~345) and before the `# Step 6: emit the audit event` block, add:

```python
    # Step 5b: NY E&S placements require a surplus-lines filing. Created
    # atomically with the bind (no separate commit). Admitted carriers are exempt.
    carrier = session.get(Carrier, quote.carrier_id)
    if carrier is not None and carrier.market_type == "e&s":
        from app.services.surplus_lines import create_filing_for_policy
        create_filing_for_policy(session, policy, actor_id=bound_by)
```

Ensure `Carrier` is imported in `policies.py`. If it is not in the existing `from app.models import ...`, add it to that import.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_bind_autocreates_filing_for_es_only -v`
Expected: PASS.

- [ ] **Step 5: Run the policies suite to confirm no regression**

Run: `cd backend; python -m pytest tests/test_policies_service.py tests/test_placement_api.py -q`
Expected: PASS (binding still works; admitted-carrier binds create no filing).

- [ ] **Step 6: Commit**

```powershell
cd backend
git add app/services/policies.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): auto-create filing on E&S bind (atomic, admitted exempt)
'@; $msg | git commit -F -
```

---

## Task 10: "Needs attention" derived query

**Files:**
- Modify: `backend/app/services/surplus_lines.py`
- Test: `backend/tests/test_surplus_lines.py`

A derived read (not a persisted `ComplianceSignal`) to avoid coupling to signal-count invariants.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
from app.services.surplus_lines import filings_needing_attention


def test_filings_needing_attention_flags_unfiled():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        create_filing_for_policy(s, pol, actor_id="user_001")  # pending, 0 declines
        s.commit()
        attention = filings_needing_attention(s)
        ids = {row["policy_id"] for row in attention}
        assert pol.id in ids
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_filings_needing_attention_flags_unfiled -v`
Expected: FAIL with `ImportError: cannot import name 'filings_needing_attention'`.

- [ ] **Step 3: Implement the query**

Append to `backend/app/services/surplus_lines.py`:

```python
def filings_needing_attention(session: Session) -> list[dict]:
    """Pending/unfiled filings, or filings past their deadline. Derived read."""
    today = now_utc().date()
    out: list[dict] = []
    for f in session.exec(
        select(SurplusLinesFiling).where(SurplusLinesFiling.status.in_(("pending", "filed")))
    ).all():
        overdue = f.status != "confirmed" and f.filing_deadline < today
        if f.status == "pending" or overdue:
            out.append({
                "filing_id": f.id, "policy_id": f.policy_id, "venue_id": f.venue_id,
                "status": f.status, "filing_deadline": f.filing_deadline.isoformat(),
                "overdue": overdue,
                "diligent_search_complete": f.diligent_search_complete,
            })
    return out
```

Note: `SurplusLinesFiling.status.in_((...))` uses the SQLModel column `in_` operator; `# type: ignore[attr-defined]` may be needed to match the codebase's mypy posture (see `Submission.id.like(...)` in `seed_demo_placements.py`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_filings_needing_attention_flags_unfiled -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
cd backend
git add app/services/surplus_lines.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): filings_needing_attention derived query
'@; $msg | git commit -F -
```

---

## Task 11: API router

**Files:**
- Create: `backend/app/api/v1/surplus_lines.py`
- Modify: `backend/app/main.py` (~line 460, after the comms router registration)
- Test: `backend/tests/test_surplus_lines.py`

Follow the `comms.py` router pattern: `require_broker` for broker-wide endpoints; `current_user_optional` + `can_access_venue` for venue-scoped reads/actions.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_surplus_lines.py`:

```python
from fastapi.testclient import TestClient

from app.main import app
from app.auth import create_access_token


def _broker_headers():
    tok = create_access_token({"sub": "user_001", "email": "b@x.com",
                               "role": "broker", "tenant_id": None})
    return {"Authorization": f"Bearer {tok}"}


def test_api_list_and_file_flow():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        for i in range(3):
            record_declination(s, pol.submission_id, carrier_name=f"A{i}",
                               reason="appetite", declined_at=pol.effective_date)
        recompute_diligent_search(s, filing)
        s.commit()
        fid = filing.id

    client = TestClient(app)
    r = client.get("/api/surplus-lines/filings", headers=_broker_headers())
    assert r.status_code == 200
    assert any(f["id"] == fid for f in r.json())

    r = client.post(f"/api/surplus-lines/filings/{fid}/file", headers=_broker_headers())
    assert r.status_code == 200 and r.json()["status"] == "filed"

    r = client.post(f"/api/surplus-lines/filings/{fid}/confirm",
                    json={"transaction_id": "ELANY-9"}, headers=_broker_headers())
    assert r.status_code == 200 and r.json()["status"] == "confirmed"
```

Confirm the auth-token helper name (`create_access_token`) against `app/auth.py`; if it differs, use the real helper the other API tests use (grep `tests/test_comms_connectors.py` for how it builds broker headers and copy that exactly).

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_api_list_and_file_flow -v`
Expected: FAIL — route 404 (router not registered).

- [ ] **Step 3: Implement the router**

Create `backend/app/api/v1/surplus_lines.py`:

```python
"""Surplus-lines compliance HTTP surface. Broker-wide; operators scoped to
their own venue. Error mapping: SurplusLinesError -> 400,
InvalidTransitionError -> 422."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import can_access_venue, current_user_optional, require_broker
from app.database import get_session
from app.lifecycles import (
    SL_FILING_TRANSITIONS,
    InvalidTransitionError,
    transition_table_to_json,
)
from app.models import SurplusLinesFiling
from app.services.surplus_lines import (
    SurplusLinesError,
    confirm_filing,
    file_filing,
    filings_needing_attention,
    record_declination,
    void_filing,
)

router = APIRouter()


class DeclinationBody(BaseModel):
    submission_id: str
    carrier_name: str
    reason: str
    declined_at: str           # ISO date
    carrier_naic: str | None = None


class ConfirmBody(BaseModel):
    transaction_id: str


class VoidBody(BaseModel):
    reason: str


def _map_error(exc: Exception) -> NoReturn:  # type: ignore[valid-type]
    if isinstance(exc, InvalidTransitionError):
        raise HTTPException(status_code=422, detail={"error": "invalid_transition", "message": str(exc)})
    if isinstance(exc, SurplusLinesError):
        raise HTTPException(status_code=400, detail={"error": "surplus_lines_error", "message": str(exc)})
    raise exc


def _filing_json(f: SurplusLinesFiling) -> dict:
    return {
        "id": f.id, "policy_id": f.policy_id, "venue_id": f.venue_id,
        "state": f.state, "status": f.status,
        "taxable_premium": str(f.taxable_premium),
        "surplus_lines_tax": str(f.surplus_lines_tax),
        "stamping_fee": str(f.stamping_fee),
        "total_charges": str(f.total_charges),
        "filing_deadline": f.filing_deadline.isoformat(),
        "diligent_search_complete": f.diligent_search_complete,
        "export_list_exempt": f.export_list_exempt,
        "transaction_id": f.transaction_id,
        "documents": list((f.documents or {}).keys()),
    }


@router.get("/surplus-lines/transitions")
def sl_transitions(_: dict = Depends(require_broker)):
    return transition_table_to_json(SL_FILING_TRANSITIONS)


@router.get("/surplus-lines/filings")
def list_filings(
    status: str | None = None,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    q = select(SurplusLinesFiling)
    if status:
        q = q.where(SurplusLinesFiling.status == status)
    return [_filing_json(f) for f in session.exec(q).all()]


@router.get("/surplus-lines/attention")
def attention(session: Session = Depends(get_session), _: dict = Depends(require_broker)):
    return filings_needing_attention(session)


@router.get("/surplus-lines/filings/{filing_id}")
def get_filing(
    filing_id: str,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    f = session.get(SurplusLinesFiling, filing_id)
    if f is None:
        raise HTTPException(status_code=404, detail="Filing not found")
    return _filing_json(f)


@router.post("/surplus-lines/declinations")
def add_declination(
    body: DeclinationBody,
    session: Session = Depends(get_session),
    user: dict = Depends(require_broker),
):
    from datetime import date as _date
    d = record_declination(
        session, body.submission_id, carrier_name=body.carrier_name,
        reason=body.reason, declined_at=_date.fromisoformat(body.declined_at),
        carrier_naic=body.carrier_naic, recorded_by=user.get("sub"),
    )
    session.commit()
    return {"id": d.id, "submission_id": d.submission_id}


def _act(session, user, action, *args, **kwargs):
    try:
        row = action(session, *args, actor_id=user.get("sub", "unknown"), **kwargs)
        session.commit()
        return _filing_json(row)
    except (SurplusLinesError, InvalidTransitionError) as exc:
        session.rollback()
        _map_error(exc)


@router.post("/surplus-lines/filings/{filing_id}/file")
def post_file(filing_id: str, session: Session = Depends(get_session),
              user: dict = Depends(require_broker)):
    return _act(session, user, file_filing, filing_id)


@router.post("/surplus-lines/filings/{filing_id}/confirm")
def post_confirm(filing_id: str, body: ConfirmBody, session: Session = Depends(get_session),
                 user: dict = Depends(require_broker)):
    return _act(session, user, confirm_filing, filing_id, transaction_id=body.transaction_id)


@router.post("/surplus-lines/filings/{filing_id}/void")
def post_void(filing_id: str, body: VoidBody, session: Session = Depends(get_session),
              user: dict = Depends(require_broker)):
    return _act(session, user, void_filing, filing_id, reason=body.reason)


@router.get("/surplus-lines/filings/{filing_id}/documents/{kind}")
def get_document(
    filing_id: str, kind: str,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    f = session.get(SurplusLinesFiling, filing_id)
    if f is None or kind not in (f.documents or {}):
        raise HTTPException(status_code=404, detail="Document not found")
    from app.storage import get_storage
    data = get_storage().load(f.documents[kind])
    return Response(content=data, media_type="application/pdf")
```

Add `from typing import NoReturn` at the top. Match `get_storage()`'s read method name (`load`/`get`/`read`) to `app/storage.py` — use whatever `LocalStorage` exposes for reading bytes by key (the same method `defense_package`/evidence read with).

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, after the comms router lines (~459-460), add:

```python
from app.api.v1.surplus_lines import router as surplus_lines_router  # noqa: E402
app.include_router(surplus_lines_router, prefix="/api", tags=["surplus-lines"])
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend; python -m pytest tests/test_surplus_lines.py::test_api_list_and_file_flow -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
cd backend
git add app/api/v1/surplus_lines.py app/main.py tests/test_surplus_lines.py
$msg = @'
feat(surplus-lines): broker API (filings, file/confirm/void, declinations, docs)
'@; $msg | git commit -F -
```

---

## Task 12: Demo seed

**Files:**
- Create: `backend/scripts/seed_surplus_lines.py`
- Test: manual run (idempotent)

- [ ] **Step 1: Implement the seed**

Create `backend/scripts/seed_surplus_lines.py`:

```python
"""Seed surplus-lines filings for the demo placements. Idempotent.

Run from backend/:  python -m scripts.seed_surplus_lines

Produces:
  - pol-demo-1 (nowadays, E&S): filing + 3 declinations -> fileable.
  - EB-DEMO   (elsewhere):       filing + 2 declinations -> incomplete (shows
    the file-guard blocking a premature filing).
"""
from __future__ import annotations

import sys
from datetime import date

from sqlmodel import Session, select

from app.database import engine
from app.models import Policy, SurplusLinesFiling
from app.services.surplus_lines import (
    create_filing_for_policy,
    record_declination,
    recompute_diligent_search,
)
from scripts.seed_demo_placements import ensure_eb_current_policy
from scripts.seed_demo_placements import seed as seed_placements


def _ensure_filing(session: Session, policy: Policy, *, declines: int) -> None:
    filing = session.exec(
        select(SurplusLinesFiling).where(SurplusLinesFiling.policy_id == policy.id)
    ).first()
    if filing is None:
        filing = create_filing_for_policy(session, policy, actor_id="user_001")
    # Only add declinations if none exist yet (idempotent).
    from app.models import Declination
    existing = session.exec(
        select(Declination).where(Declination.submission_id == policy.submission_id)
    ).all()
    if not existing:
        for i in range(declines):
            record_declination(
                session, policy.submission_id, carrier_name=f"Admitted Mutual {i+1}",
                reason="outside nightlife appetite", declined_at=date.today(),
            )
    recompute_diligent_search(session, filing)


def main() -> int:
    with Session(engine) as s:
        seed_placements(s)
        ensure_eb_current_policy(s)
        s.commit()
    with Session(engine) as s:
        nowadays = s.exec(
            select(Policy).where(Policy.policy_number == "BW-DEMO-2026-0001")
        ).first()
        eb = s.exec(
            select(Policy).where(Policy.policy_number == "EB-DEMO-2026-0001")
        ).first()
        if nowadays:
            _ensure_filing(s, nowadays, declines=3)
        if eb:
            _ensure_filing(s, eb, declines=2)
        s.commit()
    print("[seed] surplus-lines filings ensured (nowadays: complete, EB: incomplete)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Note: the bind hook (Task 9) means `nowadays`/`EB` may already have a filing from `seed_placements`; `_ensure_filing` handles that (create is idempotent), and only adds declinations.

- [ ] **Step 2: Run the seed twice (idempotency check)**

Run: `cd backend; python -m scripts.seed_surplus_lines; python -m scripts.seed_surplus_lines`
Expected: both runs print the success line; no duplicate declinations or filings (verify by re-running with no errors).

- [ ] **Step 3: Commit**

```powershell
cd backend
git add scripts/seed_surplus_lines.py
$msg = @'
feat(surplus-lines): idempotent demo seed (complete + incomplete filings)
'@; $msg | git commit -F -
```

---

## Task 13: Broker web view

**Files:**
- Create: `frontend/src/app/surplus-lines/layout.tsx`
- Create: `frontend/src/app/surplus-lines/page.tsx`
- Modify: `frontend/src/components/layout/AppShell.tsx` (add "Compliance" → "Surplus Lines" nav entry for brokers)

AppShell is a per-page-dir layout; a new route needs its own `layout.tsx` or it renders bare with no nav. Use `authHeaders()` from `src/lib/authFetch.ts` on every fetch and check `res.ok`.

- [ ] **Step 1: Create the layout (so the page renders inside AppShell)**

Mirror an existing route's `layout.tsx` (e.g. `frontend/src/app/comms-review/layout.tsx`). Create `frontend/src/app/surplus-lines/layout.tsx` with the same shape:

```tsx
import { AppShell } from "@/components/layout/AppShell";

export default function SurplusLinesLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
```

(Copy the exact import path/structure from `comms-review/layout.tsx` if it differs.)

- [ ] **Step 2: Create the page**

Create `frontend/src/app/surplus-lines/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/authFetch";

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

type Filing = {
  id: string; policy_id: string; venue_id: string; status: string;
  taxable_premium: string; surplus_lines_tax: string; stamping_fee: string;
  total_charges: string; filing_deadline: string; diligent_search_complete: boolean;
  documents: string[];
};

export default function SurplusLinesPage() {
  const [filings, setFilings] = useState<Filing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`${API}/api/surplus-lines/filings`, { headers: authHeaders() });
    if (!res.ok) { setError(`Failed to load (${res.status})`); return; }
    setFilings(await res.json());
  }
  useEffect(() => { load(); }, []);

  async function act(id: string, action: "file" | "confirm" | "void") {
    setBusy(id);
    const body = action === "confirm" ? { transaction_id: `ELANY-${Date.now()}` }
               : action === "void" ? { reason: "manual void" } : undefined;
    const res = await fetch(`${API}/api/surplus-lines/filings/${id}/${action}`, {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d?.detail?.message ?? `Action failed (${res.status})`);
      return;
    }
    setError(null);
    load();
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>Surplus Lines</h1>
      <p style={{ color: "#6b7280", marginBottom: 16 }}>
        NY E&amp;S filings: tax + ELANY stamping, diligent search, statutory documents.
      </p>
      {error && <div role="alert" style={{ color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
            <th>Policy</th><th>Status</th><th>Total charges</th><th>Deadline</th>
            <th>Diligent search</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filings.map((f) => {
            const overdue = f.status !== "confirmed" && f.filing_deadline < today;
            return (
              <tr key={f.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td>{f.policy_id}</td>
                <td>{f.status}</td>
                <td>${f.total_charges}</td>
                <td style={{ color: overdue ? "#b91c1c" : undefined }}>
                  {f.filing_deadline}{overdue ? " (overdue)" : ""}
                </td>
                <td>{f.diligent_search_complete ? "✓ complete" : "incomplete"}</td>
                <td>
                  {f.status === "pending" && (
                    <button disabled={busy === f.id} onClick={() => act(f.id, "file")}>File</button>
                  )}
                  {f.status === "filed" && (
                    <button disabled={busy === f.id} onClick={() => act(f.id, "confirm")}>Confirm</button>
                  )}
                  {f.status !== "void" && f.status !== "confirmed" && (
                    <button disabled={busy === f.id} onClick={() => act(f.id, "void")} style={{ marginLeft: 8 }}>Void</button>
                  )}
                  {f.documents.map((k) => (
                    <a key={k} href={`${API}/api/surplus-lines/filings/${f.id}/documents/${k}`}
                       target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>{k}</a>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

Match `authHeaders` import + `NEXT_PUBLIC_API_URL` usage to the existing `comms-review/page.tsx`. If the document links need auth headers (the `<a>` tag can't send them), note that the doc endpoint is broker-gated — acceptable for the demo where the broker session cookie/localStorage token isn't passed on a bare link; if links 401, switch to a fetch+blob download handler copied from any existing authed-download in the app.

- [ ] **Step 3: Add the nav entry**

In `frontend/src/components/layout/AppShell.tsx`, in the broker nav config, add a "Compliance" grouping (or add to the existing compliance/claims group) with an item: label `Surplus Lines`, href `/surplus-lines`. Match the exact shape of the existing nav item objects (icon, label, href). Also add `/surplus-lines` to the broker-allowed routes in the focused-persona route guard if one gates unknown routes.

- [ ] **Step 4: Verify the build**

Run: `cd frontend; npm run build` (or `rtk next build`)
Expected: build succeeds, `/surplus-lines` compiles as a route.

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\aakas\Documents\JobHunt\ThirdSpaceRisk"
git add frontend/src/app/surplus-lines frontend/src/components/layout/AppShell.tsx
$msg = @'
feat(surplus-lines): broker web view (filings list, actions, doc links)
'@; $msg | git commit -F -
```

---

## Task 14: Full-suite green + push

**Files:** none (verification)

- [ ] **Step 1: Reset the dev DB to avoid accumulated test rows**

Run: `Get-ChildItem "C:\Users\aakas\Documents\JobHunt\ThirdSpaceRisk\backend" -Filter "database.db*" | Remove-Item -Force`

- [ ] **Step 2: Run the full backend suite**

Run: `cd backend; python -m pytest -q`
Expected: PASS — the Task 1 baseline count plus the new `test_surplus_lines.py` tests, 0 failures.

- [ ] **Step 3: Push**

```powershell
cd "C:\Users\aakas\Documents\JobHunt\ThirdSpaceRisk"
git push
```

- [ ] **Step 4: Confirm CI green**

After push, watch the GitHub Actions "CI" + "E2E Tests" runs on the new commit; confirm both conclude `success`.

---

## Self-Review (completed against the spec)

- **Spec coverage:** rates+rules (Task 2), models (3), lifecycle (4), declinations+creation (5), transitions+guard (6), documents (7→8), bind hook (9), attention query (10), API (11), seed (12), web (13), the pricing-rate correction (1), full-suite gate (14). All spec sections map to a task.
- **Placeholder scan:** the one stub (`_generate_documents` in Task 6) is intentional and explicitly filled in Task 8; the Task 5 deadline test has a placeholder line immediately replaced by the real assertion in the same step. No unresolved TBDs.
- **Type consistency:** `compute_sl_charges` / `SurplusLinesCharges` (tax, stamping_fee, total_charges); `create_filing_for_policy(session, policy, *, actor_id)`; `file_filing/confirm_filing/void_filing(session, filing_id, *, ...)`; `record_declination(session, submission_id, *, carrier_name, reason, declined_at, ...)` — names/signatures consistent across tasks and the router.
- **Known unknowns to verify during execution (called out inline):** `app/storage.py` read/write method names; the auth-token test helper name; `comms-review/layout.tsx` exact shape; whether bare `<a>` document links carry auth. Each task names the file to check.
