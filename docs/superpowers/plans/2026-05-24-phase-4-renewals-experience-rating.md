# Phase 4 — Renewals + Experience Rating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a broker renew an expiring policy into a new Submission whose carrier quotes are re-priced by the prior term's actual claim experience.

**Architecture:** A pure loss-ratio banding function in `pricing.py` feeds the existing (currently dormant) `loss_adjustment` factor via an optional override on `build_quote_for_carrier` — so the 62 pricing characterization tests stay green. A new `services/renewals.py` computes loss experience from `Claim` rows and creates renewal Submissions (reusing `create_submission` + `prior_policy_id`). A new `/api/renewals` router exposes a due-list and a renew action. The renewal then flows through the existing submit→quote→bind pipeline; the quote path applies the override when `Submission.prior_policy_id` is set. Frontend adds a `/renewals` surface.

**Tech Stack:** Python 3.12, FastAPI, SQLModel, `Decimal` money (`app.money`), pytest; Next.js 16 App Router + TypeScript; Playwright.

**Spec:** [`docs/superpowers/specs/2026-05-24-phase-4-renewals-experience-rating-design.md`](../specs/2026-05-24-phase-4-renewals-experience-rating-design.md)

---

## File Structure

**Backend**
- Modify `backend/app/underwriting/pricing.py` — add `loss_adjustment_from_loss_ratio` (pure) + optional `loss_adjustment` param on `build_quote_for_carrier`.
- Create `backend/app/services/renewals.py` — `RenewalsError`, `LossExperience`, `compute_loss_experience`, `create_renewal`.
- Create `backend/app/api/v1/renewals.py` — `GET /api/renewals/due`, `POST /api/policies/{id}/renew`.
- Modify `backend/app/main.py` — mount the renewals router.
- Modify `backend/app/api/v1/placement.py` — apply the loss-adjustment override in the quote path when the submission is a renewal.
- Create `backend/tests/test_renewals_service.py`, `backend/tests/test_renewals_api.py`.
- Modify `backend/tests/test_phase_1.py` (or a new `test_pricing_loss_adjustment.py`) — assert the override path.

**Frontend**
- Create `frontend/src/lib/renewals.ts` — typed API client.
- Create `frontend/src/app/renewals/page.tsx` — renewals-due table + renew action + YoY result panel.
- Create `frontend/e2e/renewals.spec.ts` — Playwright journey.

---

### Task 1: Loss-ratio banding (pure function)

**Files:**
- Modify: `backend/app/underwriting/pricing.py` (add function near `_loss_adjustment_from_risk`, ~line 520)
- Test: `backend/tests/test_renewals_service.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_renewals_service.py
from decimal import Decimal

from app.underwriting.pricing import loss_adjustment_from_loss_ratio


def test_loss_adjustment_bands():
    assert loss_adjustment_from_loss_ratio(Decimal("0.0")) == Decimal("0.90")
    assert loss_adjustment_from_loss_ratio(Decimal("0.39")) == Decimal("0.90")
    assert loss_adjustment_from_loss_ratio(Decimal("0.40")) == Decimal("1.00")
    assert loss_adjustment_from_loss_ratio(Decimal("0.69")) == Decimal("1.00")
    assert loss_adjustment_from_loss_ratio(Decimal("0.70")) == Decimal("1.25")
    assert loss_adjustment_from_loss_ratio(Decimal("0.99")) == Decimal("1.25")
    assert loss_adjustment_from_loss_ratio(Decimal("1.00")) == Decimal("1.60")
    assert loss_adjustment_from_loss_ratio(Decimal("3.5")) == Decimal("1.60")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_renewals_service.py::test_loss_adjustment_bands -v`
Expected: FAIL with `ImportError: cannot import name 'loss_adjustment_from_loss_ratio'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/underwriting/pricing.py  (add after _loss_adjustment_from_risk)
def loss_adjustment_from_loss_ratio(loss_ratio: Decimal) -> Decimal:
    """Map a prior-term loss ratio (incurred / earned premium) to the
    renewal loss_adjustment multiplier. Bands per the Phase 4 spec:
      <0.40 → 0.90 (credit), 0.40–0.70 → 1.00, 0.70–1.00 → 1.25, ≥1.00 → 1.60.
    Pure: no DB, no I/O — the renewals service computes the ratio and calls this."""
    if loss_ratio < Decimal("0.40"):
        return Decimal("0.90")
    if loss_ratio < Decimal("0.70"):
        return Decimal("1.00")
    if loss_ratio < Decimal("1.00"):
        return Decimal("1.25")
    return Decimal("1.60")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_renewals_service.py::test_loss_adjustment_bands -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/pricing.py backend/tests/test_renewals_service.py
git commit -m "feat(pricing): loss-ratio banding for renewal experience rating"
```

---

### Task 2: Optional `loss_adjustment` override on `build_quote_for_carrier`

**Files:**
- Modify: `backend/app/underwriting/pricing.py:522-560` (`build_quote_for_carrier` signature + `loss_adj` line)
- Test: `backend/tests/test_pricing_loss_adjustment.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_pricing_loss_adjustment.py
from decimal import Decimal

from app.underwriting.pricing import build_quote_for_carrier


def _venue():
    return {"id": "v1", "venue_type": "music_venue"}


def test_override_scales_line_premium():
    """With an explicit loss_adjustment override, each line premium is the
    no-override premium times the override / the implicit 1.00 it replaces."""
    base = build_quote_for_carrier(
        venue=_venue(), coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score={"tier": "B", "total_score": 80},
        requested_limits={},
    )
    surcharged = build_quote_for_carrier(
        venue=_venue(), coverage_lines=["gl"], carrier_id="markel-specialty",
        market_type="admitted", risk_score={"tier": "B", "total_score": 80},
        requested_limits={}, loss_adjustment=Decimal("1.60"),
    )
    base_line = base.lines[0]
    sur_line = surcharged.lines[0]
    assert base_line.loss_adjustment == Decimal("1.00")
    assert sur_line.loss_adjustment == Decimal("1.60")
    # 1.60 / 1.00 scaling on the line premium (cent-quantized)
    assert sur_line.premium == (base_line.premium * Decimal("1.60")).quantize(Decimal("0.01"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_pricing_loss_adjustment.py -v`
Expected: FAIL with `TypeError: build_quote_for_carrier() got an unexpected keyword argument 'loss_adjustment'`

- [ ] **Step 3: Write minimal implementation**

In `build_quote_for_carrier`, add the keyword-only param to the signature (after `requested_limits`):

```python
    requested_limits: dict,
    loss_adjustment: Optional[Decimal] = None,
) -> FullQuote:
```

Then replace the `loss_adj` assignment (currently `loss_adj = _loss_adjustment_from_risk(risk_score)`):

```python
    # Renewal path passes an experience-based override; new business passes
    # None and falls back to the risk-score heuristic (unchanged behavior —
    # this is what keeps the 62 test_phase_1.py characterization cases green).
    loss_adj = (
        loss_adjustment
        if loss_adjustment is not None
        else _loss_adjustment_from_risk(risk_score)
    )
```

- [ ] **Step 4: Run tests to verify pass + no regression**

Run: `cd backend && python -m pytest tests/test_pricing_loss_adjustment.py tests/test_phase_1.py -v`
Expected: new test PASS; all 62 `test_phase_1.py` cases still PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/pricing.py backend/tests/test_pricing_loss_adjustment.py
git commit -m "feat(pricing): optional loss_adjustment override (keeps characterization tests green)"
```

---

### Task 3: `compute_loss_experience` + `LossExperience` + `RenewalsError`

**Files:**
- Create: `backend/app/services/renewals.py`
- Test: `backend/tests/test_renewals_service.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_renewals_service.py  (append; add imports at top of file)
from datetime import date

from app.models import Claim, Policy
from app.services.renewals import (
    LossExperience,
    RenewalsError,
    compute_loss_experience,
)


def _make_active_policy(session, *, premium="10000.00", pid="pol-exp1"):
    pol = Policy(
        id=pid, submission_id="sub-x", bound_quote_id="q-x", venue_id="v1",
        carrier_id="markel-specialty", status="active",
        effective_date=date(2025, 1, 1), expiration_date=date(2026, 1, 1),
        annual_premium=Decimal(premium), commission_amount=Decimal("1500.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
    )
    session.add(pol)
    session.flush()
    return pol


def test_loss_experience_zero_claims(session):
    _make_active_policy(session)
    exp = compute_loss_experience(session, "pol-exp1")
    assert exp.claim_count == 0
    assert exp.incurred == Decimal("0.00")
    assert exp.loss_ratio == Decimal("0")


def test_loss_experience_open_and_closed_claims(session):
    _make_active_policy(session, premium="10000.00")
    # Open claim: no total_incurred → reserve + paid - recoveries = 3000
    session.add(Claim(
        id="clm-1", policy_id="pol-exp1", coverage_line="gl",
        date_of_loss=date(2025, 6, 1), status="reserved",
        current_reserve=Decimal("2000.00"), indemnity_paid_to_date=Decimal("1000.00"),
        expense_paid_to_date=Decimal("0.00"), recoveries_to_date=Decimal("0.00"),
    ))
    # Closed claim: total_incurred short-circuits the running totals = 4000
    session.add(Claim(
        id="clm-2", policy_id="pol-exp1", coverage_line="gl",
        date_of_loss=date(2025, 7, 1), status="closed_paid",
        total_incurred=Decimal("4000.00"),
    ))
    session.flush()
    exp = compute_loss_experience(session, "pol-exp1")
    assert exp.claim_count == 2
    assert exp.incurred == Decimal("7000.00")           # 3000 + 4000
    assert exp.loss_ratio == Decimal("0.7")             # 7000 / 10000


def test_loss_experience_unknown_policy(session):
    with pytest.raises(RenewalsError):
        compute_loss_experience(session, "pol-missing")
```

Add `import pytest` and `from decimal import Decimal` to the test file header if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_renewals_service.py -k loss_experience -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.renewals'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/renewals.py
"""Renewals service — experience-rated re-placement of expiring policies.

A renewal is a new Submission (status='open') that points at the expiring
policy via prior_policy_id and carries forward its coverage terms. The
prior term's actual claims are aggregated into a loss ratio (see
compute_loss_experience) which, via pricing.loss_adjustment_from_loss_ratio,
re-prices the renewal's carrier quotes.

Conventions match the broker-platform services: keyword-only args, no
commit inside the service (caller owns the transaction), audit event on
state creation, typed RenewalsError mapped to HTTP 400 by the router."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from app.models import Claim, Policy, Submission
from app.money import usd
from app.packet_core import _add_audit_event
from app.services.submissions import create_submission


class RenewalsError(Exception):
    """Base error for the renewals service (router maps → HTTP 400)."""


@dataclass(frozen=True)
class LossExperience:
    incurred: Decimal
    earned_premium: Decimal
    loss_ratio: Decimal
    claim_count: int


def compute_loss_experience(session: Session, policy_id: str) -> LossExperience:
    """Aggregate the prior term's realized losses for one policy.

    incurred per claim = total_incurred (if the claim is closed and it's set)
    else current_reserve + indemnity_paid + expense_paid - recoveries.
    loss_ratio = incurred / annual_premium; 0 when premium is 0 (no crash)."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise RenewalsError(f"Policy {policy_id} not found")

    claims = list(session.exec(select(Claim).where(Claim.policy_id == policy_id)))
    incurred = Decimal("0.00")
    for c in claims:
        if c.total_incurred is not None:
            incurred += c.total_incurred
        else:
            incurred += (
                c.current_reserve
                + c.indemnity_paid_to_date
                + c.expense_paid_to_date
                - c.recoveries_to_date
            )

    earned = policy.annual_premium
    loss_ratio = (incurred / earned) if earned and earned > 0 else Decimal("0")
    return LossExperience(
        incurred=usd(incurred),
        earned_premium=earned,
        loss_ratio=loss_ratio,
        claim_count=len(claims),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_renewals_service.py -k loss_experience -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/renewals.py backend/tests/test_renewals_service.py
git commit -m "feat(renewals): compute_loss_experience from prior-term claims"
```

---

### Task 4: `create_renewal`

**Files:**
- Modify: `backend/app/services/renewals.py` (append `create_renewal`)
- Test: `backend/tests/test_renewals_service.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_renewals_service.py  (append)
from app.services.renewals import create_renewal
from app.models import AuditEvent


def _seed_prior_submission(session):
    sub = Submission(
        id="sub-prior", venue_id="v1", status="bound",
        effective_date=date(2025, 1, 1), coverage_lines=["gl", "liquor"],
        requested_limits={"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
        assigned_producer_id="user-broker",
    )
    session.add(sub)
    session.flush()
    return sub


def test_create_renewal_carries_forward_terms(session):
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-renew1")
    pol.submission_id = "sub-prior"
    session.add(pol)
    session.flush()

    renewal = create_renewal(
        session, "pol-renew1", effective_date=date(2026, 1, 1), actor_id="user-broker",
    )
    assert renewal.status == "open"
    assert renewal.prior_policy_id == "pol-renew1"
    assert renewal.coverage_lines == ["gl", "liquor"]
    assert renewal.requested_limits == {"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}}
    assert renewal.venue_id == "v1"
    events = list(session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == renewal.id)
    ))
    assert any(e.event_type == "submission.renewal_created" for e in events)


def test_create_renewal_rejects_non_active_policy(session):
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-cancelled")
    pol.submission_id = "sub-prior"
    pol.status = "cancelled"
    session.add(pol)
    session.flush()
    with pytest.raises(RenewalsError):
        create_renewal(session, "pol-cancelled", effective_date=date(2026, 1, 1))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_renewals_service.py -k create_renewal -v`
Expected: FAIL with `ImportError: cannot import name 'create_renewal'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/renewals.py  (append)
def create_renewal(
    session: Session,
    policy_id: str,
    *,
    effective_date: date,
    actor_id: str = "system",
) -> Submission:
    """Create a renewal Submission (status='open') from an active policy.

    Carries forward coverage_lines + requested_limits from the prior
    submission, links prior_policy_id, emits an audit event. Does NOT
    auto-submit and does NOT change the prior policy's status (that is a
    separate explicit broker action — a renewal term may overlap the old
    one). Caller owns commit/rollback."""
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise RenewalsError(f"Policy {policy_id} not found")
    if policy.status != "active":
        raise RenewalsError(
            f"Can only renew an active policy; {policy_id} is {policy.status!r}"
        )
    prior_sub = session.get(Submission, policy.submission_id)
    if prior_sub is None:
        raise RenewalsError(f"Prior submission {policy.submission_id} missing")

    sub = create_submission(
        session,
        venue_id=policy.venue_id,
        effective_date=effective_date,
        coverage_lines=prior_sub.coverage_lines,
        requested_limits=prior_sub.requested_limits,
        producer_id=prior_sub.assigned_producer_id,
        notes=f"Renewal of {policy_id}",
        actor_id=actor_id,
    )
    sub.prior_policy_id = policy_id
    session.add(sub)
    session.flush()
    _add_audit_event(
        session=session,
        actor_id=actor_id,
        actor_type="user",
        entity_type="submission",
        entity_id=sub.id,
        event_type="submission.renewal_created",
        event_metadata={"prior_policy_id": policy_id, "venue_id": policy.venue_id},
    )
    return sub
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_renewals_service.py -k create_renewal -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/renewals.py backend/tests/test_renewals_service.py
git commit -m "feat(renewals): create_renewal carries forward terms + links prior_policy_id"
```

---

### Task 5: Renewals API router (`/api/renewals/due`, `/api/policies/{id}/renew`)

**Files:**
- Create: `backend/app/api/v1/renewals.py`
- Modify: `backend/app/main.py` (mount router near the other `include_router` calls, ~line 294)
- Test: `backend/tests/test_renewals_api.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_renewals_api.py
from datetime import date, timedelta
from decimal import Decimal

from app.models import Policy, Submission


def _seed_renewable(session):
    session.add(Submission(
        id="sub-prior", venue_id="v1", status="bound",
        effective_date=date(2025, 1, 1), coverage_lines=["gl"],
        requested_limits={"gl": {"per_occurrence": "1000000"}},
    ))
    soon = date.today() + timedelta(days=30)
    session.add(Policy(
        id="pol-due", submission_id="sub-prior", bound_quote_id="q-x", venue_id="v1",
        carrier_id="markel-specialty", status="active",
        effective_date=soon - timedelta(days=335), expiration_date=soon,
        annual_premium=Decimal("10000.00"), commission_amount=Decimal("1500.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
    ))
    session.commit()


def test_renewals_due_lists_expiring_policy(broker_client, session):
    _seed_renewable(session)
    r = broker_client.get("/api/renewals/due?within_days=60")
    assert r.status_code == 200
    ids = [row["policy_id"] for row in r.json()]
    assert "pol-due" in ids
    row = next(row for row in r.json() if row["policy_id"] == "pol-due")
    assert "loss_ratio" in row and "projected_loss_adjustment" in row


def test_renew_creates_submission_with_yoy(broker_client, session):
    _seed_renewable(session)
    r = broker_client.post(
        "/api/policies/pol-due/renew",
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["submission"]["prior_policy_id"] == "pol-due"
    assert body["yoy_context"]["prior_annual_premium"] == "10000.00"
    assert "loss_adjustment" in body["yoy_context"]


def test_renew_non_active_policy_returns_400(broker_client, session):
    _seed_renewable(session)
    session.get(Policy, "pol-due").status = "cancelled"
    session.commit()
    r = broker_client.post(
        "/api/policies/pol-due/renew",
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 400
```

> **Note:** reuse the existing broker-authenticated test client fixture. Grep `backend/tests/test_claims_api.py` (or `test_policies_api.py`) for the fixture name — it is `broker_client` in the claims/policies API tests; use the same fixture and `session` fixture here.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_renewals_api.py -v`
Expected: FAIL (404 on the routes — router not mounted yet)

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/api/v1/renewals.py
"""FastAPI endpoints for Phase 4 renewals. Mounted at /api by main.py.
Broker-gated. Error mapping mirrors the claims/policies routers:
  RenewalsError → 400, InvalidTransitionError → 422."""
from __future__ import annotations

from datetime import date, timedelta
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.api.v1.placement import _broker_user_id
from app.auth import require_broker
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import Policy
from app.money import usd_to_json
from app.services.renewals import (
    RenewalsError,
    compute_loss_experience,
    create_renewal,
)
from app.underwriting.pricing import loss_adjustment_from_loss_ratio

router = APIRouter()


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(status_code=422, detail={"error": "invalid_transition", "message": str(e)})
    if isinstance(e, RenewalsError):
        raise HTTPException(status_code=400, detail={"error": "renewals_error", "message": str(e)})
    raise e


class RenewBody(BaseModel):
    effective_date: date


@router.get("/renewals/due", dependencies=[Depends(require_broker)])
def renewals_due(within_days: int = 60, session: Session = Depends(get_session)) -> list[dict]:
    cutoff = date.today() + timedelta(days=within_days)
    rows = session.exec(
        select(Policy)
        .where(Policy.status == "active")
        .where(Policy.expiration_date <= cutoff)
        .order_by(Policy.expiration_date)
    )
    out: list[dict] = []
    for pol in rows:
        exp = compute_loss_experience(session, pol.id)
        out.append({
            "policy_id": pol.id,
            "policy_number": pol.policy_number,
            "venue_id": pol.venue_id,
            "expiration_date": pol.expiration_date.isoformat(),
            "annual_premium": usd_to_json(pol.annual_premium),
            "loss_ratio": str(exp.loss_ratio),
            "claim_count": exp.claim_count,
            "projected_loss_adjustment": str(loss_adjustment_from_loss_ratio(exp.loss_ratio)),
        })
    return out


@router.post("/policies/{policy_id}/renew", status_code=201, dependencies=[Depends(require_broker)])
def renew_policy(
    policy_id: str,
    body: RenewBody,
    session: Session = Depends(get_session),
    actor_id: str = Depends(_broker_user_id),
) -> dict:
    try:
        prior = session.get(Policy, policy_id)
        if prior is None:
            raise HTTPException(status_code=404, detail=f"Policy {policy_id} not found")
        exp = compute_loss_experience(session, policy_id)
        sub = create_renewal(session, policy_id, effective_date=body.effective_date, actor_id=actor_id)
        session.commit()
        session.refresh(sub)
    except (RenewalsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)

    return {
        "submission": {
            "id": sub.id,
            "venue_id": sub.venue_id,
            "status": sub.status,
            "prior_policy_id": sub.prior_policy_id,
            "coverage_lines": sub.coverage_lines,
            "requested_limits": sub.requested_limits,
            "effective_date": sub.effective_date.isoformat(),
        },
        "yoy_context": {
            "prior_policy_id": policy_id,
            "prior_annual_premium": usd_to_json(prior.annual_premium),
            "prior_coverage_lines": prior.coverage_lines,
            "loss_ratio": str(exp.loss_ratio),
            "claim_count": exp.claim_count,
            "loss_adjustment": str(loss_adjustment_from_loss_ratio(exp.loss_ratio)),
        },
    }
```

Then mount it in `backend/app/main.py` (next to the other v1 routers, ~line 294):

```python
from app.api.v1.renewals import router as renewals_router
app.include_router(renewals_router, prefix="/api", tags=["renewals"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_renewals_api.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/renewals.py backend/app/main.py backend/tests/test_renewals_api.py
git commit -m "feat(api): /api/renewals/due + /api/policies/{id}/renew with YoY context"
```

---

### Task 6: Apply the override in the renewal quote path

**Files:**
- Modify: `backend/app/api/v1/placement.py:341-350` (the `build_quote_for_carrier` call in the quote-preview endpoint)
- Test: `backend/tests/test_renewals_api.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_renewals_api.py  (append)
def test_renewal_quote_applies_loss_adjustment(broker_client, session):
    """A renewal submission (prior_policy_id set) with a loss-heavy prior
    term produces a quote whose line loss_adjustment reflects the bands,
    not the default 1.00."""
    from app.models import Claim, Submission, CarrierQuote
    _seed_renewable(session)
    # Loss ratio 1.2 → band 1.60
    session.add(Claim(
        id="clm-big", policy_id="pol-due", coverage_line="gl",
        date_of_loss=date.today() - timedelta(days=100), status="closed_paid",
        total_incurred=Decimal("12000.00"),
    ))
    renewal = Submission(
        id="sub-renew", venue_id="v1", status="quoting", effective_date=date.today(),
        coverage_lines=["gl"], requested_limits={}, prior_policy_id="pol-due",
    )
    session.add(renewal)
    session.add(CarrierQuote(
        id="q-renew", submission_id="sub-renew", carrier_id="markel-specialty",
        status="requested",
    ))
    session.commit()

    r = broker_client.post("/api/quotes/q-renew/preview")
    assert r.status_code == 200, r.text
    line = r.json()["lines"]["gl"]
    assert line["loss_adjustment"] == "1.60"
```

> **Note:** confirm the preview route path/verb by grepping `placement.py` for the function around line 320 (`api_preview_quote`). If the path differs, use the actual one. The assertion (line `loss_adjustment == "1.60"`) is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_renewals_api.py::test_renewal_quote_applies_loss_adjustment -v`
Expected: FAIL — `loss_adjustment` is `"1.00"` (override not wired yet).

- [ ] **Step 3: Write minimal implementation**

In `placement.py`, replace the `build_quote_for_carrier(...)` call (~line 343) with override logic:

```python
    risk = get_risk_score(sub.venue_id, VENUES, session=session)

    # Renewal pricing: if this submission renews a prior policy, re-price
    # using that term's realized losses (Phase 4 experience rating).
    loss_adjustment = None
    if sub.prior_policy_id:
        from app.services.renewals import compute_loss_experience
        from app.underwriting.pricing import loss_adjustment_from_loss_ratio
        exp = compute_loss_experience(session, sub.prior_policy_id)
        loss_adjustment = loss_adjustment_from_loss_ratio(exp.loss_ratio)

    full_quote = build_quote_for_carrier(
        venue=venue,
        coverage_lines=sub.coverage_lines,
        carrier_id=carrier.id,
        market_type=carrier.market_type,
        risk_score=risk,
        requested_limits=sub.requested_limits,
        loss_adjustment=loss_adjustment,
    )
    return full_quote.to_json_dict()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_renewals_api.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Full backend regression + commit**

Run: `cd backend && python -m pytest -q`
Expected: all tests PASS (573 prior + the new renewals tests).

```bash
git add backend/app/api/v1/placement.py backend/tests/test_renewals_api.py
git commit -m "feat(renewals): experience-rate renewal quotes via loss_adjustment override"
```

---

### Task 7: Frontend API client

**Files:**
- Create: `frontend/src/lib/renewals.ts`

- [ ] **Step 1: Write the client**

```typescript
// frontend/src/lib/renewals.ts
import { authFetch } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface RenewalDue {
  policy_id: string;
  policy_number: string | null;
  venue_id: string;
  expiration_date: string;
  annual_premium: string;
  loss_ratio: string;
  claim_count: number;
  projected_loss_adjustment: string;
}

export interface RenewResult {
  submission: {
    id: string;
    venue_id: string;
    status: string;
    prior_policy_id: string;
    coverage_lines: string[];
    requested_limits: Record<string, unknown>;
    effective_date: string;
  };
  yoy_context: {
    prior_policy_id: string;
    prior_annual_premium: string;
    prior_coverage_lines: string[];
    loss_ratio: string;
    claim_count: number;
    loss_adjustment: string;
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.detail?.message ?? body?.detail ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const renewalsApi = {
  due: (withinDays = 60) =>
    call<RenewalDue[]>(`/api/renewals/due?within_days=${withinDays}`),
  renew: (policyId: string, effectiveDate: string) =>
    call<RenewResult>(`/api/policies/${policyId}/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effective_date: effectiveDate }),
    }),
};
```

> **Note:** confirm the auth seam — grep `frontend/src/lib/` for how `claims.ts` imports auth (it uses an `authFetch`/`authHeaders` helper in `@/lib/authFetch`). Match whatever `claims.ts` does exactly so gating headers are sent.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors in `renewals.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/renewals.ts
git commit -m "feat(web): renewals API client"
```

---

### Task 8: `/renewals` page (due list + renew action + YoY result)

**Files:**
- Create: `frontend/src/app/renewals/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// frontend/src/app/renewals/page.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import { renewalsApi, type RenewalDue, type RenewResult } from "@/lib/renewals";

export default function RenewalsPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [rows, setRows] = useState<RenewalDue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<RenewResult | null>(null);

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    renewalsApi
      .due(60)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load renewals"));
  }, [isLoaded, isBroker]);

  if (!isLoaded) return null;
  if (!isBroker) {
    return (
      <div className="page page-empty">
        <h3>Renewals are a broker surface.</h3>
      </div>
    );
  }

  async function onRenew(policyId: string) {
    setBusyId(policyId);
    setError(null);
    try {
      const today = new Date();
      const eff = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
        .toISOString()
        .slice(0, 10);
      const res = await renewalsApi.renew(policyId, eff);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Renew failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="renewals">
      <PageHeader
        eyebrow="BROKER · RENEWALS"
        title="Renewals due"
        subtitle="Expiring policies, re-priced by last term's loss experience."
      />

      {error && <div className="policies-empty" role="alert">{error}</div>}

      {result && (
        <section className="renewals__yoy" aria-label="Renewal created">
          <h3>Renewal created for {result.yoy_context.prior_policy_id}</h3>
          <dl className="renewals__yoy-list">
            <div><dt>Prior annual premium</dt><dd>${result.yoy_context.prior_annual_premium}</dd></div>
            <div><dt>Prior loss ratio</dt><dd>{result.yoy_context.loss_ratio}</dd></div>
            <div><dt>Experience adjustment</dt><dd>×{result.yoy_context.loss_adjustment}</dd></div>
          </dl>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => router.push(`/submissions/${result.submission.id}`)}
          >
            Go to renewal submission
          </button>
        </section>
      )}

      {rows === null ? (
        <div className="claims-section__skeleton" aria-busy="true"><div /><div /><div /></div>
      ) : rows.length === 0 ? (
        <div className="policies-empty">No policies expiring in the next 60 days.</div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" aria-label="Renewals due">
            <thead>
              <tr>
                <th scope="col">Policy</th>
                <th scope="col">Venue</th>
                <th scope="col">Expires</th>
                <th scope="col" style={{ textAlign: "right" }}>Loss ratio</th>
                <th scope="col" style={{ textAlign: "right" }}>Adj.</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.policy_id}>
                  <td className="policies-table__mono">{r.policy_number ?? r.policy_id}</td>
                  <td>{r.venue_id}</td>
                  <td className="policies-table__mono">{r.expiration_date}</td>
                  <td className="policies-table__mono" style={{ textAlign: "right" }}>{r.loss_ratio}</td>
                  <td className="policies-table__mono" style={{ textAlign: "right" }}>×{r.projected_loss_adjustment}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyId === r.policy_id}
                      onClick={() => onRenew(r.policy_id)}
                    >
                      {busyId === r.policy_id ? "Renewing…" : "Renew"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

> **Note:** `PageHeader` and `useAuth` import paths are copied from `frontend/src/app/claims/page.tsx`. Confirm they match; reuse the same `.policies-table` / `.claims-section__skeleton` classes (already styled). The `result` panel uses new `.renewals__*` classes — either add minimal CSS to the global stylesheet the other pages use, or reuse existing utility classes if you prefer to skip new CSS.

- [ ] **Step 2: Typecheck + build**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: compiles; `/renewals` route emitted.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/renewals/page.tsx
git commit -m "feat(web): /renewals due-list + renew action + YoY result panel"
```

---

### Task 9: Playwright journey

**Files:**
- Create: `frontend/e2e/renewals.spec.ts`

- [ ] **Step 1: Write the journey**

```typescript
// frontend/e2e/renewals.spec.ts
import { test, expect } from "@playwright/test";
import { loginAsBroker } from "./helpers";   // reuse existing broker-login helper

test("broker can see renewals due and create a renewal", async ({ page }) => {
  await loginAsBroker(page);
  await page.goto("/renewals");
  await expect(page.getByRole("heading", { name: "Renewals due" })).toBeVisible();

  const firstRenew = page.getByRole("button", { name: "Renew" }).first();
  if (await firstRenew.isVisible()) {
    await firstRenew.click();
    await expect(page.getByText(/Renewal created for/)).toBeVisible();
    await expect(page.getByText(/Experience adjustment/)).toBeVisible();
  }
});
```

> **Note:** confirm the broker-login helper name/location — grep `frontend/e2e/` for the existing login helper used by `claims`/`policies` specs and import the same one. Seed at least one expiring active policy via `scripts/seed_demo_placements.py` (or extend it) so the due-list is non-empty against the demo backend.

- [ ] **Step 2: Run the journey**

Run: `cd frontend && npx playwright test renewals.spec.ts`
Expected: PASS (or graceful skip of the renew branch if the demo book has nothing expiring).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/renewals.spec.ts
git commit -m "test(e2e): renewals due-list + renew journey"
```

---

## Self-Review

**Spec coverage:**
- §2 banding → Task 1. §3 override seam → Task 2. §4.1 loss experience + create_renewal → Tasks 3–4. §4.3 quote wiring → Task 6. §4.4 API → Task 5. §4.5 frontend → Tasks 7–9. §7 tests → embedded per task; full regression in Task 6 Step 5.
- §4.2 prior-policy transition (`active → expired/non_renewed`): the helper `_transition_policy` already exists (`services/policies.py:192`) and `POLICY_TRANSITIONS` already allows it; the design makes it a *separate* broker action, so it is intentionally **not** a new task here — it's exercised through the existing policies router. If a dedicated endpoint is wanted, add it as a follow-up; it is not required for the renewal feature to work end-to-end.

**Placeholder scan:** No TBD/TODO. The "Note" callouts ask the engineer to confirm one fixture/helper/path name against existing sibling files (`broker_client`, `authFetch`, `loginAsBroker`, the preview-quote route) rather than inventing them — these are verification cues, not missing content.

**Type consistency:** `loss_adjustment_from_loss_ratio(Decimal) -> Decimal` used identically in Tasks 1, 5, 6. `LossExperience` fields (`incurred`, `earned_premium`, `loss_ratio`, `claim_count`) consistent across Tasks 3, 5, 6. `create_renewal(session, policy_id, *, effective_date, actor_id)` consistent in Tasks 4, 5. The `build_quote_for_carrier` keyword `loss_adjustment` consistent in Tasks 2, 6.
