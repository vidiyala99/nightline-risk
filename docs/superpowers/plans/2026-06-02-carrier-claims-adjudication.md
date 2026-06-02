# Carrier Claims Adjudication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the carrier an adjuster desk that *owns* claims adjudication — a coverage decision (covered/denied/RoR, gating indemnity) + carrier-owned reserve/payment/close stamped `carrier_desk`, an adjuster queue, a deterministic advisory reserve hint, operator visibility of the outcome — all on the existing claim machinery.

**Architecture:** Thread a `decision_source` param through the existing claim services (default `broker_relay`, so broker behavior is unchanged); add a thin `app/services/adjusting.py` (coverage decision + carrier-owned wrappers + queue + reserve hint) + a carrier-gated `app/api/v1/adjusting.py`; reuse all existing claim lifecycle/audit/UI. Web + mobile get a carrier "Claims" desk; the operator sees the coverage outcome.

**Tech Stack:** FastAPI + SQLModel + SQLite/Postgres (Neon); Next.js App Router (web); React Native/Expo (mobile). TDD with pytest; money as Decimal/strings via `app.money`.

**Spec:** `docs/superpowers/specs/2026-06-02-carrier-claims-adjudication-design.md`

---

## File structure

**Backend:**
- Modify `app/models.py` — 4 scalar coverage fields on `Claim`.
- Modify `app/database.py` — `_COLUMN_MIGRATIONS` rows for `claim`.
- Modify `app/services/claims.py` — `decision_source` param on `record_carrier_reserve` / `record_payment` / `close_claim` (default `broker_relay`), stamped into each audit event.
- Create `app/services/adjusting.py` — `decide_coverage`, `adjust_reserve`/`approve_payment`/`close_claim_as_carrier`, indemnity gate, `adjuster_queue`, `reserve_hint`.
- Create `app/api/v1/adjusting.py` — carrier-gated routes; register it where the underwriting router is registered.
- Modify `app/api/v1/claims.py` — include coverage fields in the venue-scoped claim reads (`_claim_to_dict` / venue list).
- Tests: `tests/test_claim_coverage.py`, `tests/test_adjusting.py`, `tests/test_adjusting_api.py` (new); extend `tests/test_claims.py` for the `decision_source` regression guard.

**Web:**
- Create `frontend/src/lib/adjusting.ts` — adjuster client types + calls.
- Modify `frontend/src/components/layout/AppShell.tsx` — carrier nav gains "Claims".
- Create `frontend/src/app/adjusting/layout.tsx`, `page.tsx` (queue), `[cid]/page.tsx` (detail).
- Modify the operator claim tracker (`frontend/src/app/claims/page.tsx` `OperatorClaimsTracker`) — coverage badge + rationale.

**Mobile:**
- Create `mobile/src/api/adjusting.ts`.
- Modify `mobile/src/navigation/TabNavigator.tsx` — `CarrierTabs` gains a Claims tab.
- Create `mobile/src/navigation/AdjustingStack.tsx`, `mobile/src/screens/AdjusterQueueScreen.tsx`, `mobile/src/screens/AdjusterClaimDetailScreen.tsx`.
- Modify the operator claim view to show the coverage badge + rationale.

---

## Task 1: Claim coverage columns + migrations

**Files:** Modify `app/models.py` (Claim ~581-643), `app/database.py` (`_COLUMN_MIGRATIONS`). Test: `tests/test_claim_coverage.py` (new).

- [ ] **Step 1: Write the failing test**

Create `tests/test_claim_coverage.py`:
```python
from sqlmodel import Session, SQLModel, create_engine
from app.models import Claim


def test_claim_has_coverage_fields():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        c = Claim(
            id="clm-x", policy_id="pol-x", coverage_line="gl",
            date_of_loss=__import__("datetime").date(2026, 5, 1), snapshot_hash="",
            coverage_decision="covered", coverage_rationale="ok",
            coverage_decided_by="u-carrier", coverage_decided_at="2026-06-02T00:00:00Z",
        )
        s.add(c); s.commit(); s.refresh(c)
        assert c.coverage_decision == "covered"
        assert c.coverage_decided_at == "2026-06-02T00:00:00Z"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_coverage.py -q`
Expected: FAIL — `TypeError: 'coverage_decision' is an invalid keyword argument`.

- [ ] **Step 3: Add the fields**

In `app/models.py` `Claim`, add after `adjuster_email`:
```python
    coverage_decision: Optional[str] = None      # null | "covered" | "denied" | "reservation_of_rights"
    coverage_rationale: Optional[str] = None
    coverage_decided_by: Optional[str] = None
    coverage_decided_at: Optional[str] = None     # ISO string (TEXT column — not datetime; avoids Postgres TEXT/datetime mismatch)
```

In `app/database.py` `_COLUMN_MIGRATIONS`, add (table is `claim`, lowercase):
```python
    # Carrier claims adjudication — coverage decision. Added 2026-06-02.
    ("claim", "coverage_decision", "TEXT", ""),
    ("claim", "coverage_rationale", "TEXT", ""),
    ("claim", "coverage_decided_by", "TEXT", ""),
    ("claim", "coverage_decided_at", "TEXT", ""),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_claim_coverage.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/app/database.py backend/tests/test_claim_coverage.py
git commit -F - <<'EOF'
feat(carrier): add coverage-decision columns to Claim

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Thread `decision_source` through claim services

**Files:** Modify `app/services/claims.py`. Test: extend `tests/test_claims.py`.

**Context:** `record_carrier_reserve` (lines ~204-275), `record_payment` (~284-360), `close_claim` (~373-436). Each builds an `event_metadata` dict on an `_add_audit_event` (reserve/payment) or `_transition_claim` (close). Add a `decision_source: str = "broker_relay"` param and put `"decision_source": decision_source` into that metadata dict. Default preserves broker behavior.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_claims.py` (it has fixtures that build a policy + claim; if not, use the `_session`/seed pattern from `tests/test_carrier_book.py` plus `file_fnol` to get a claim. Read the file's existing helpers first and reuse them):
```python
from sqlmodel import select
from app.models import AuditEvent


def _last_event(s, claim_id, event_type):
    return s.exec(
        select(AuditEvent).where(AuditEvent.entity_type == "claim")
        .where(AuditEvent.entity_id == claim_id).where(AuditEvent.event_type == event_type)
    ).all()[-1]


def test_reserve_defaults_to_broker_relay(make_claim_session):
    # make_claim_session: a helper/fixture yielding (session, claim) with an active policy.
    s, claim = make_claim_session
    from datetime import datetime
    from decimal import Decimal
    from app.services.claims import record_carrier_reserve
    record_carrier_reserve(s, claim.id, new_reserve=Decimal("1000"), change_reason="init",
                           received_from="adjuster", received_at=datetime(2026, 6, 1), recorded_by="u-brk")
    s.commit()
    evt = _last_event(s, claim.id, "claim.reserve_recorded")
    assert evt.event_metadata["decision_source"] == "broker_relay"


def test_reserve_can_be_carrier_desk(make_claim_session):
    s, claim = make_claim_session
    from datetime import datetime
    from decimal import Decimal
    from app.services.claims import record_carrier_reserve
    record_carrier_reserve(s, claim.id, new_reserve=Decimal("1000"), change_reason="init",
                           received_from="adjuster", received_at=datetime(2026, 6, 1),
                           recorded_by="u-carrier", decision_source="carrier_desk")
    s.commit()
    evt = _last_event(s, claim.id, "claim.reserve_recorded")
    assert evt.event_metadata["decision_source"] == "carrier_desk"
```
**Note:** if `tests/test_claims.py` has no reusable claim fixture, add a small module-level fixture `make_claim_session` that: creates an in-memory engine, seeds a venue + `seed_broker_platform_data`, creates+binds a policy (reuse the helpers in `tests/test_claims.py` or `seed_demo_placements`), then `file_fnol(...)` to get a `notified` claim. Read the existing test file to find the established helper before writing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_claims.py -q -k "broker_relay or carrier_desk"`
Expected: FAIL — `record_carrier_reserve() got an unexpected keyword argument 'decision_source'`.

- [ ] **Step 3: Add the param + stamp the metadata (3 functions)**

`record_carrier_reserve` — add to signature (after `recorded_by`): `decision_source: str = "broker_relay",` and add the key to its `event_metadata` (the `claim.reserve_recorded` dict, ~line 267):
```python
        event_metadata={
            "from_amount": str(prior),
            "to_amount": str(claim.current_reserve),
            "change_reason": change_reason,
            "received_from": received_from,
            "decision_source": decision_source,
            "snapshot_hash": claim.snapshot_hash,
        },
```
`record_payment` — add `decision_source: str = "broker_relay",` to the signature and to its `claim.payment_recorded` metadata (~line 352):
```python
        event_metadata={
            "payment_id": payment.id,
            "payment_type": payment_type,
            "amount": str(amount),
            "paid_on": paid_on.isoformat(),
            "decision_source": decision_source,
            "snapshot_hash": claim.snapshot_hash,
        },
```
`close_claim` — add `decision_source: str = "broker_relay",` to the signature and into the `_transition_claim(... metadata={...})` dict (~line 416):
```python
        metadata={
            "disposition": disposition,
            "final_indemnity": str(final_indemnity) if final_indemnity is not None else None,
            "total_incurred": str(total_incurred),
            "decision_source": decision_source,
        },
```

- [ ] **Step 4: Run test to verify it passes + no regression**

Run: `python -m pytest tests/test_claims.py -q`
Expected: PASS (the 2 new + all existing claims tests — the default keeps broker behavior).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/claims.py backend/tests/test_claims.py
git commit -F - <<'EOF'
feat(carrier): thread decision_source through claim reserve/payment/close

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `decide_coverage` service

**Files:** Create `app/services/adjusting.py`. Test: `tests/test_adjusting.py` (new).

**Context:** `app/services/claims.py` exports `_transition_claim(session, claim, *, to, actor_id, metadata=None)`, `close_claim(...)`, `ClaimsError`, `_compute_claim_snapshot_hash(claim)`, `_add_audit_event` (from `app.packet_core`). `Claim` is in `app.models`. `now_utc` in `app.time`. Lifecycle from `notified`: `notified→acknowledged→under_investigation` are valid hops; from `under_investigation`, `closed_denied` is valid.

- [ ] **Step 1: Write the failing test**

Create `tests/test_adjusting.py` (reuse the claim-session helper; mirror `tests/test_claims.py` setup — read it first):
```python
import pytest
from app.services.adjusting import decide_coverage
from app.services.claims import ClaimsError


def test_covered_sets_decision_and_advances(make_claim_session):
    s, claim = make_claim_session          # claim is 'notified'
    out = decide_coverage(s, claim.id, decision="covered", rationale="policy responds", adjuster_id="u-carrier")
    s.commit()
    assert out.coverage_decision == "covered"
    assert out.status == "under_investigation"   # auto-advanced from notified
    assert out.coverage_rationale == "policy responds"


def test_denied_closes_the_claim(make_claim_session):
    s, claim = make_claim_session
    out = decide_coverage(s, claim.id, decision="denied", rationale="A&B exclusion applies", adjuster_id="u-carrier")
    s.commit()
    assert out.coverage_decision == "denied"
    assert out.status == "closed_denied"


def test_rationale_required(make_claim_session):
    s, claim = make_claim_session
    with pytest.raises(ClaimsError):
        decide_coverage(s, claim.id, decision="covered", rationale="  ", adjuster_id="u-carrier")


def test_bad_decision_rejected(make_claim_session):
    s, claim = make_claim_session
    with pytest.raises(ClaimsError):
        decide_coverage(s, claim.id, decision="maybe", rationale="x", adjuster_id="u-carrier")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_adjusting.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.adjusting'`.

- [ ] **Step 3: Implement**

Create `app/services/adjusting.py`:
```python
"""Carrier claims adjudication — the adjuster's seat.

Thin layer over the existing claim services: a coverage decision, carrier-owned
(carrier_desk-stamped) reserve/payment/close wrappers, an adjuster queue, and a
deterministic advisory reserve hint. The carrier OWNS these decisions; the
broker's existing relay path (broker_relay) is untouched.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlmodel import Session

from app.models import Claim, Policy
from app.packet_core import _add_audit_event
from app.services.claims import (
    ClaimsError,
    _compute_claim_snapshot_hash,
    _transition_claim,
    close_claim,
    record_carrier_reserve,
    record_payment,
)
from app.time import now_utc

_COVERAGE_DECISIONS = {"covered", "denied", "reservation_of_rights"}


def decide_coverage(session: Session, claim_id: str, *, decision: str, rationale: str, adjuster_id: str) -> Claim:
    """The adjuster's 'do we owe?' determination. covered/RoR open the claim for
    reserve+payment; denied closes it as closed_denied. Carrier-owned (carrier_desk)."""
    if decision not in _COVERAGE_DECISIONS:
        raise ClaimsError(f"coverage decision {decision!r} invalid; must be one of {sorted(_COVERAGE_DECISIONS)}")
    rationale = (rationale or "").strip()
    if not rationale:
        raise ClaimsError("a coverage rationale is required")
    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if claim.status in {"closed_paid", "closed_denied", "closed_dropped"}:
        raise ClaimsError(f"Claim {claim_id!r} is {claim.status!r}; reopen before deciding coverage")

    # Move a freshly-notified claim into an investigating state so the coverage
    # call is made from a legitimate lifecycle position.
    if claim.status == "notified":
        _transition_claim(session, claim, to="acknowledged", actor_id=adjuster_id,
                          metadata={"implicit": "adjuster_opened", "decision_source": "carrier_desk"})
    if claim.status == "acknowledged":
        _transition_claim(session, claim, to="under_investigation", actor_id=adjuster_id,
                          metadata={"implicit": "coverage_review", "decision_source": "carrier_desk"})

    claim.coverage_decision = decision
    claim.coverage_rationale = rationale
    claim.coverage_decided_by = adjuster_id
    claim.coverage_decided_at = now_utc().isoformat()
    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session, actor_id=adjuster_id, actor_type="user",
        entity_type="claim", entity_id=claim.id, event_type="claim.coverage_decided",
        event_metadata={"coverage_decision": decision, "rationale": rationale, "decision_source": "carrier_desk"},
    )

    if decision == "denied":
        # No payment owed — close as denied (carrier_desk provenance).
        return close_claim(session, claim.id, disposition="denied", closed_by=adjuster_id,
                           decision_source="carrier_desk")
    return claim
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_adjusting.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/adjusting.py backend/tests/test_adjusting.py
git commit -F - <<'EOF'
feat(carrier): decide_coverage adjuster action (covered/denied/RoR, denial closes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Carrier-owned wrappers + indemnity gate + adjuster queue

**Files:** Modify `app/services/adjusting.py`. Test: extend `tests/test_adjusting.py`.

**Context:** `list_claims(session, *, status_in=None, venue_id=None, carrier_id=None, open_only=False)` and `claims_for_policy` are in `claims.py`. `Policy.venue_id` links a claim to its venue (claim.policy_id → policy.venue_id). Closed statuses: `{closed_paid, closed_denied, closed_dropped}`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_adjusting.py`:
```python
from datetime import date, datetime
from decimal import Decimal
from app.services.adjusting import approve_payment, adjust_reserve, adjuster_queue


def test_indemnity_blocked_until_coverage(make_claim_session):
    s, claim = make_claim_session
    decide_coverage(s, claim.id, decision="reservation_of_rights", rationale="investigating", adjuster_id="u-carrier")
    adjust_reserve(s, claim.id, new_reserve=Decimal("5000"), change_reason="init", adjuster_id="u-carrier")
    s.commit()
    # expense is allowed under RoR
    approve_payment(s, claim.id, amount=Decimal("500"), payment_type="expense",
                    paid_on=date(2026, 6, 1), description="defense", adjuster_id="u-carrier")
    s.commit()
    # indemnity allowed under covered/RoR
    approve_payment(s, claim.id, amount=Decimal("1000"), payment_type="indemnity",
                    paid_on=date(2026, 6, 2), description="settlement", adjuster_id="u-carrier")
    s.commit()


def test_indemnity_rejected_with_no_coverage(make_claim_session):
    s, claim = make_claim_session
    # move to a payable state WITHOUT a coverage decision via the broker relay reserve
    from app.services.claims import record_carrier_reserve
    record_carrier_reserve(s, claim.id, new_reserve=Decimal("5000"), change_reason="init",
                           received_from="x", received_at=datetime(2026, 6, 1), recorded_by="u-brk")
    s.commit()
    import pytest
    with pytest.raises(ClaimsError):
        approve_payment(s, claim.id, amount=Decimal("1000"), payment_type="indemnity",
                        paid_on=date(2026, 6, 2), description="settlement", adjuster_id="u-carrier")


def test_adjuster_queue_lists_open_claims(make_claim_session):
    s, claim = make_claim_session
    rows = adjuster_queue(s)
    row = next((r for r in rows if r["claim_id"] == claim.id), None)
    assert row is not None
    assert "coverage_decision" in row and "current_reserve" in row and "venue_id" in row
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_adjusting.py -q -k "indemnity or queue"`
Expected: FAIL — `cannot import name 'approve_payment'`.

- [ ] **Step 3: Implement the wrappers + gate + queue**

Append to `app/services/adjusting.py`:
```python
_COVERAGE_OK = {"covered", "reservation_of_rights"}


def adjust_reserve(session: Session, claim_id: str, *, new_reserve: Decimal, change_reason: str, adjuster_id: str) -> Claim:
    """Carrier sets/adjusts the reserve (carrier_desk)."""
    return record_carrier_reserve(
        session, claim_id, new_reserve=new_reserve, change_reason=change_reason,
        received_from=adjuster_id, received_at=now_utc(), recorded_by=adjuster_id,
        decision_source="carrier_desk",
    )


def approve_payment(session: Session, claim_id: str, *, amount: Decimal, payment_type: str,
                    paid_on, description: str, adjuster_id: str):
    """Carrier approves a payment (carrier_desk). Indemnity requires coverage
    affirmed (covered / reservation_of_rights); expense + recovery are allowed
    regardless (defense costs run during investigation/RoR)."""
    if payment_type == "indemnity":
        claim = session.get(Claim, claim_id)
        if claim is None:
            raise ClaimsError(f"Unknown Claim {claim_id!r}")
        if claim.coverage_decision not in _COVERAGE_OK:
            raise ClaimsError("cannot approve an indemnity payment before coverage is affirmed (covered / reservation of rights)")
    return record_payment(
        session, claim_id, amount=amount, payment_type=payment_type, paid_on=paid_on,
        description=description, recorded_by=adjuster_id, decision_source="carrier_desk",
    )


def close_claim_as_carrier(session: Session, claim_id: str, *, disposition: str,
                           final_indemnity: Decimal | None = None, adjuster_id: str) -> Claim:
    return close_claim(session, claim_id, disposition=disposition, final_indemnity=final_indemnity,
                       closed_by=adjuster_id, decision_source="carrier_desk")


def adjuster_queue(session: Session) -> list[dict]:
    """Open (non-closed) claims awaiting carrier adjudication, enriched."""
    from app.services.claims import list_claims
    from app.seed_data import VENUES
    rows: list[dict] = []
    for c in list_claims(session, open_only=True):
        policy = session.get(Policy, c.policy_id)
        venue_id = policy.venue_id if policy else None
        venue_name = VENUES.get(venue_id, {}).get("name", venue_id) if venue_id else None
        total_paid = (c.indemnity_paid_to_date + c.expense_paid_to_date - c.recoveries_to_date)
        rows.append({
            "claim_id": c.id,
            "carrier_claim_number": c.carrier_claim_number,
            "venue_id": venue_id,
            "venue_name": venue_name,
            "coverage_line": c.coverage_line,
            "status": c.status,
            "coverage_decision": c.coverage_decision,
            "current_reserve": str(c.current_reserve),
            "total_paid": str(total_paid.quantize(Decimal("0.01"))),
        })
    rows.sort(key=lambda r: r["claim_id"])
    return rows
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_adjusting.py -q`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/adjusting.py backend/tests/test_adjusting.py
git commit -F - <<'EOF'
feat(carrier): carrier-owned reserve/payment/close wrappers + indemnity gate + adjuster queue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Advisory reserve/severity hint

**Files:** Modify `app/services/adjusting.py`. Test: extend `tests/test_adjusting.py`.

**Context:** `venue_loss_run(session, venue_id)` (`app/services/loss_run.py`) returns `{"by_coverage_line": [{"coverage_line", "claim_count", "reserve", "paid", "incurred"}], "summary": {...}}` (money strings). `IncidentRecord` has `injury_observed`, `police_called`, `weapon_involved`. The claim's incident is `claim.incident_id`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_adjusting.py`:
```python
from app.services.adjusting import reserve_hint


def test_reserve_hint_degrades_without_history(make_claim_session):
    s, claim = make_claim_session
    # Fresh venue with no prior losses → no comparable history → None (no raise).
    hint = reserve_hint(s, claim)
    assert hint is None or ("low" in hint and "severity_band" in hint)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_adjusting.py -q -k reserve_hint`
Expected: FAIL — `cannot import name 'reserve_hint'`.

- [ ] **Step 3: Implement**

Append to `app/services/adjusting.py`:
```python
def reserve_hint(session: Session, claim: Claim) -> dict | None:
    """Advisory reserve range + severity band from the venue's prior losses for
    this coverage line + the linked incident's severity. Deterministic,
    failure-isolated (returns None on no history / any error). NEVER auto-sets."""
    try:
        from app.services.loss_run import venue_loss_run
        from app.models import IncidentRecord
        policy = session.get(Policy, claim.policy_id)
        if policy is None:
            return None
        lr = venue_loss_run(session, policy.venue_id)
        line = next((r for r in lr.get("by_coverage_line", []) if r["coverage_line"] == claim.coverage_line), None)
        if not line or int(line.get("claim_count", 0)) <= 0:
            return None
        mean = Decimal(line["incurred"]) / Decimal(max(int(line["claim_count"]), 1))
        low = (mean * Decimal("0.6")).quantize(Decimal("1"))
        high = (mean * Decimal("1.6")).quantize(Decimal("1"))

        band, signals = "moderate", []
        inc = session.get(IncidentRecord, claim.incident_id) if claim.incident_id else None
        if inc is not None:
            if getattr(inc, "weapon_involved", None):
                band, _ = "severe", signals.append("weapon involved")
            elif getattr(inc, "injury_observed", False):
                band, _ = "elevated", signals.append("injury observed")
            if getattr(inc, "police_called", False):
                signals.append("police called")
        basis = f"{line['claim_count']} prior {claim.coverage_line} loss(es)"
        if signals:
            basis += "; " + ", ".join(signals)
        return {"low": str(low), "high": str(high), "severity_band": band, "basis": basis}
    except Exception:  # noqa: BLE001 — advisory only, never block the desk
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_adjusting.py -q`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/adjusting.py backend/tests/test_adjusting.py
git commit -F - <<'EOF'
feat(carrier): advisory reserve/severity hint from loss-run + incident severity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Carrier-gated adjuster API + register router

**Files:** Create `app/api/v1/adjusting.py`. Modify wherever the underwriting router is registered. Test: `tests/test_adjusting_api.py` (new).

**Context:** Read `app/api/v1/underwriting.py` for the exact carrier-route pattern (`require_carrier`, `get_session`, `error_response`, `Depends`). Read `app/api/v1/claims.py` for `_claim_to_dict` shape + `claim_detail`/`list_payments`/`reserve_history` service fns to reuse for the dossier. Find where `underwriting.router` is registered (`rg -n "underwriting" app/main.py app/api/v1/__init__.py`) and register `adjusting.router` the same way (same `/api` prefix).

- [ ] **Step 1: Write the failing test**

Create `tests/test_adjusting_api.py` (mirror `tests/test_underwriting_desk_api.py` fixture style: monkeypatch engine, seed venue + broker-platform + a bound policy + a `notified` claim via `file_fnol`; `_carrier_headers`/`_broker_headers` via `create_token`). Read `test_underwriting_desk_api.py` + `test_claims_api.py` to assemble the fixture:
```python
def test_decide_coverage_carrier_only(client_claim):
    client, cid = client_claim
    r = client.post(f"/api/adjusting/claims/{cid}/decide-coverage", headers=_carrier_headers(),
                    json={"decision": "covered", "rationale": "policy responds"})
    assert r.status_code == 200, r.text
    assert r.json()["coverage_decision"] == "covered"
    denied = client.post(f"/api/adjusting/claims/{cid}/decide-coverage", headers=_broker_headers(),
                         json={"decision": "covered", "rationale": "x"})
    assert denied.status_code == 403


def test_adjuster_queue_carrier_only(client_claim):
    client, cid = client_claim
    ok = client.get("/api/adjusting/queue", headers=_carrier_headers())
    assert ok.status_code == 200
    assert any(row["claim_id"] == cid for row in ok.json())
    assert client.get("/api/adjusting/queue", headers=_broker_headers()).status_code == 403


def test_indemnity_gate_returns_400(client_claim):
    client, cid = client_claim
    # reserve without coverage, then indemnity → 400
    client.post(f"/api/adjusting/claims/{cid}/reserve", headers=_carrier_headers(),
                json={"new_reserve": "5000", "change_reason": "init"})
    r = client.post(f"/api/adjusting/claims/{cid}/payment", headers=_carrier_headers(),
                    json={"amount": "1000", "payment_type": "indemnity", "paid_on": "2026-06-02", "description": "x"})
    assert r.status_code == 400, r.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_adjusting_api.py -q`
Expected: FAIL — 404 (routes don't exist).

- [ ] **Step 3: Implement the router**

Create `app/api/v1/adjusting.py`:
```python
"""Carrier claims adjudication — adjuster desk (carrier persona, Phase 2).
All routes carrier-gated. The broker's /api/claims/* relay routes are untouched."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from sqlmodel import select

from app.auth import require_carrier
from app.database import get_session
from app.schemas.errors import error_response
from app.services.claims import ClaimsError
from app.services.adjusting import (
    adjuster_queue, adjust_reserve, approve_payment, close_claim_as_carrier,
    decide_coverage, reserve_hint,
)
from app.lifecycles import InvalidTransitionError
from app.models import Claim, ClaimPayment, Policy, ReserveChange

router = APIRouter()


def _claim_out(c: Claim) -> dict:
    return {
        "id": c.id, "status": c.status, "coverage_line": c.coverage_line,
        "coverage_decision": c.coverage_decision, "coverage_rationale": c.coverage_rationale,
        "current_reserve": str(c.current_reserve),
        "indemnity_paid_to_date": str(c.indemnity_paid_to_date),
        "expense_paid_to_date": str(c.expense_paid_to_date),
        "recoveries_to_date": str(c.recoveries_to_date),
    }


@router.get("/adjusting/queue")
def get_adjuster_queue(_u: dict = Depends(require_carrier), session: Session = Depends(get_session)) -> list[dict]:
    return adjuster_queue(session)


@router.get("/adjusting/claims/{cid}")
def get_adjuster_claim(cid: str, _u: dict = Depends(require_carrier), session: Session = Depends(get_session)) -> dict:
    c = session.get(Claim, cid)
    if c is None:
        raise HTTPException(status_code=404, detail=f"Claim {cid} not found")
    payments = session.exec(select(ClaimPayment).where(ClaimPayment.claim_id == cid)).all()
    reserves = session.exec(select(ReserveChange).where(ReserveChange.claim_id == cid)).all()
    return {
        "claim": _claim_out(c),
        "venue_id": (session.get(Policy, c.policy_id).venue_id if c.policy_id and session.get(Policy, c.policy_id) else None),
        "date_of_loss": c.date_of_loss.isoformat() if c.date_of_loss else None,
        "payments": [
            {"id": p.id, "payment_type": p.payment_type, "amount": str(p.amount),
             "paid_on": p.paid_on.isoformat(), "description": p.description} for p in payments
        ],
        "reserve_history": [
            {"id": r.id, "from_amount": str(r.from_amount), "to_amount": str(r.to_amount),
             "change_reason": r.change_reason, "received_at": r.received_at.isoformat()} for r in reserves
        ],
        "reserve_hint": reserve_hint(session, c),
    }


def _act(fn):
    try:
        return fn()
    except InvalidTransitionError as e:
        raise error_response("invalid_transition", str(e), status_code=422)
    except ClaimsError as e:
        raise error_response("claims_invalid", str(e), status_code=400)


@router.post("/adjusting/claims/{cid}/decide-coverage")
def post_decide_coverage(cid: str, payload: dict, user: dict = Depends(require_carrier),
                         session: Session = Depends(get_session)) -> dict:
    c = _act(lambda: decide_coverage(session, cid, decision=str(payload.get("decision", "")),
                                     rationale=str(payload.get("rationale", "")), adjuster_id=str(user.get("sub"))))
    session.commit(); session.refresh(c)
    return _claim_out(c)


@router.post("/adjusting/claims/{cid}/reserve")
def post_reserve(cid: str, payload: dict, user: dict = Depends(require_carrier),
                 session: Session = Depends(get_session)) -> dict:
    c = _act(lambda: adjust_reserve(session, cid, new_reserve=Decimal(str(payload.get("new_reserve", "0"))),
                                    change_reason=str(payload.get("change_reason", "")), adjuster_id=str(user.get("sub"))))
    session.commit(); session.refresh(c)
    return _claim_out(c)


@router.post("/adjusting/claims/{cid}/payment")
def post_payment(cid: str, payload: dict, user: dict = Depends(require_carrier),
                 session: Session = Depends(get_session)) -> dict:
    _act(lambda: approve_payment(session, cid, amount=Decimal(str(payload.get("amount", "0"))),
                                 payment_type=str(payload.get("payment_type", "")),
                                 paid_on=date.fromisoformat(str(payload.get("paid_on"))),
                                 description=str(payload.get("description", "")), adjuster_id=str(user.get("sub"))))
    session.commit()
    return _claim_out(session.get(Claim, cid))


@router.post("/adjusting/claims/{cid}/close")
def post_close(cid: str, payload: dict, user: dict = Depends(require_carrier),
               session: Session = Depends(get_session)) -> dict:
    fi = payload.get("final_indemnity")
    c = _act(lambda: close_claim_as_carrier(session, cid, disposition=str(payload.get("disposition", "")),
                                            final_indemnity=Decimal(str(fi)) if fi is not None else None,
                                            adjuster_id=str(user.get("sub"))))
    session.commit(); session.refresh(c)
    return _claim_out(c)
```
**Verify** `claim_detail` exists in `claims.py` with that name; if the broker detail composer is named differently (e.g. `api_claim_detail` is the route, the service is elsewhere), reuse whatever the broker `GET /api/claims/{cid}` calls, or compose `{claim, payments, reserve_history}` from `list_payments`/`reserve_history` service fns. Then register the router (mirror underwriting): in the file that does `app.include_router(...underwriting.router..., prefix="/api")`, add the same for `adjusting.router`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_adjusting_api.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/adjusting.py backend/tests/test_adjusting_api.py
# plus the file where the router is registered
git commit -F - <<'EOF'
feat(carrier): carrier-gated adjuster API (queue, dossier+hint, coverage/reserve/payment/close)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Operator visibility — coverage fields in venue-scoped claim reads

**Files:** Modify `app/api/v1/claims.py`. Test: extend `tests/test_claims_api.py`.

**Context:** `GET /api/venues/{venue_id}/claims` (`require_venue_access`) and the claim detail serialize claims via a `_claim_to_dict` (or inline dict) in `claims.py`. Add the coverage fields so the operator's tracker can render them. Read `claims.py` to find the serializer.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_claims_api.py` (reuse its fixtures + an operator token with venue access; set a coverage decision via the carrier path or directly on the claim before reading):
```python
def test_venue_claims_include_coverage(client_with_claim_and_operator):
    client, cid, venue_id, op_headers = client_with_claim_and_operator
    # adjuster decides coverage first (carrier), then operator reads
    client.post(f"/api/adjusting/claims/{cid}/decide-coverage", headers=_carrier_headers(),
                json={"decision": "denied", "rationale": "excluded cause"})
    rows = client.get(f"/api/venues/{venue_id}/claims", headers=op_headers).json()
    row = next(r for r in rows if r["id"] == cid)
    assert row["coverage_decision"] == "denied"
    assert "excluded cause" in (row["coverage_rationale"] or "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_claims_api.py -q -k coverage`
Expected: FAIL — `KeyError: 'coverage_decision'`.

- [ ] **Step 3: Add the fields to the serializer**

In `app/services/claims.py` or `app/api/v1/claims.py` `_claim_to_dict` (the function that serializes a Claim for the API), add:
```python
        "coverage_decision": claim.coverage_decision,
        "coverage_rationale": claim.coverage_rationale,
```
(Apply to the dict used by both `GET /api/venues/{id}/claims` and the claim detail.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_claims_api.py -q -k coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/claims.py backend/app/services/claims.py backend/tests/test_claims_api.py
git commit -F - <<'EOF'
feat(operator): surface coverage decision + rationale on venue-scoped claim reads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: Backend regression gate (controller runs this)**

Run: `rm -f backend/database.db && cd backend && python -m pytest -q`
Expected: all pass (≥ prior baseline + new tests).

---

## Task 8: Web client lib + carrier "Claims" nav

**Files:** Create `frontend/src/lib/adjusting.ts`; modify `frontend/src/components/layout/AppShell.tsx`.

- [ ] **Step 1: Add the client lib** — `frontend/src/lib/adjusting.ts`, mirroring `src/lib/underwriting.ts` conventions (`authHeaders`, `API_URL`, throw-with-server-message on non-ok):
```typescript
import { authHeaders } from "@/lib/authFetch";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type CoverageDecision = "covered" | "denied" | "reservation_of_rights";
export interface AdjusterQueueRow {
  claim_id: string; carrier_claim_number: string | null; venue_id: string | null;
  venue_name: string | null; coverage_line: string; status: string;
  coverage_decision: CoverageDecision | null; current_reserve: string; total_paid: string;
}
export interface ReserveHint { low: string; high: string; severity_band: string; basis: string }

export async function fetchAdjusterQueue(): Promise<AdjusterQueueRow[]> {
  const r = await fetch(`${API_URL}/api/adjusting/queue`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Queue load failed (${r.status})`);
  return r.json();
}
export async function fetchAdjusterClaim(cid: string): Promise<any> {
  const r = await fetch(`${API_URL}/api/adjusting/claims/${cid}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Claim load failed (${r.status})`);
  return r.json();   // { ...claim detail, reserve_hint }
}
async function post(path: string, body: unknown) {
  const r = await fetch(`${API_URL}/api/adjusting/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.detail?.message ?? e?.detail ?? `Request failed (${r.status})`); }
  return r.json();
}
export const decideCoverage = (cid: string, decision: CoverageDecision, rationale: string) =>
  post(`claims/${cid}/decide-coverage`, { decision, rationale });
export const adjustReserve = (cid: string, new_reserve: string, change_reason: string) =>
  post(`claims/${cid}/reserve`, { new_reserve, change_reason });
export const approvePayment = (cid: string, amount: string, payment_type: string, paid_on: string, description: string) =>
  post(`claims/${cid}/payment`, { amount, payment_type, paid_on, description });
export const closeClaim = (cid: string, disposition: string, final_indemnity?: string) =>
  post(`claims/${cid}/close`, { disposition, final_indemnity });
```

- [ ] **Step 2: Add the nav item** — In `AppShell.tsx`, the carrier nav group (`isCarrierNav`) currently has only the Desk. Add Claims:
```tsx
  const groups: Group[] = (isCarrierNav
    ? [
        { label: "", items: [
          { href: "/underwriting", label: "Underwriting Desk", icon: Inbox },
          { href: "/adjusting", label: "Claims", icon: FileSpreadsheet },
        ] },
      ]
    : isBrokerNav ? [ ... ] : [ ... ]);
```
(Use an already-imported icon — `FileSpreadsheet` is imported. Don't add a new import unless needed.)

- [ ] **Step 3: Verify** — `cd frontend && npx tsc --noEmit 2>&1 | grep -E "lib/adjusting|layout/AppShell" || echo clean` (expect `clean`).

- [ ] **Step 4: Commit**
```bash
git add frontend/src/lib/adjusting.ts frontend/src/components/layout/AppShell.tsx
git commit -F - <<'EOF'
feat(carrier-web): adjuster client lib + Claims nav item
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Web carrier Claims queue (`/adjusting`)

**Files:** Create `frontend/src/app/adjusting/layout.tsx` (copy `frontend/src/app/underwriting/layout.tsx` — AppShell wrapper), `frontend/src/app/adjusting/page.tsx`.

**Run `ui-ux-pro-max` for the visual build (match `lc-*`; status + coverage chips color-not-only; tabular money; carrier guard via `useIsCarrier`, bounce non-carrier to `/dashboard`; loading spinner + error/retry).**

- [ ] **Step 1:** Build the queue page mirroring `frontend/src/app/underwriting/page.tsx` structure: carrier guard, `fetchAdjusterQueue()`, `lc-hero` with a KPI strip (Awaiting adjudication = count; Coverage-pending = count where `coverage_decision == null`; Open reserves = Σ`current_reserve`), and rows (claim# · venue · coverage · status chip · **coverage chip** [Covered/Denied/RoR/—, color+text] · reserve · paid) linking to `/adjusting/{claim_id}`. Reuse `frontend/src/lib/claim-tokens.ts` for status labels/tones.

- [ ] **Step 2: Verify** — `npx tsc --noEmit 2>&1 | grep "app/adjusting/page" || echo clean`.

- [ ] **Step 3: Commit**
```bash
git add frontend/src/app/adjusting/layout.tsx frontend/src/app/adjusting/page.tsx
git commit -F - <<'EOF'
feat(carrier-web): adjuster queue page
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10: Web carrier claim detail (`/adjusting/[cid]`) — decide-coverage-first

**Files:** Create `frontend/src/app/adjusting/[cid]/page.tsx`.

**Run `ui-ux-pro-max`. Decision-first hierarchy (consistent with the reframed underwriting desk).**

- [ ] **Step 1:** Build the detail page driven by `fetchAdjusterClaim(cid)`. Carrier guard. Layout:
  - Header (back to `/adjusting`), claim# + venue + coverage; KPI band (status, coverage, reserve, incurred).
  - **Hero = Decide coverage** when `coverage_decision` is null: three choices (Covered / Reservation of rights / Denied) + a required rationale → `decideCoverage(...)`; once decided, show the determination + rationale as a chip/banner.
  - Then **Set reserve** (with the advisory `reserve_hint` rendered next to it: "suggested $low–$high · {severity_band} · {basis}" — clearly advisory, never auto-fills), **Approve payment** (type + amount; indemnity disabled until coverage ∈ {covered, RoR} with a tooltip), **Close** (disposition + final_indemnity when paid).
  - Reuse the lifecycle strip + payment ledger + reserve-history presentation from the broker claim detail (`frontend/src/app/claims/[cid]/page.tsx`) where practical; calls go to `/api/adjusting/*`. Single `formError`, `role="alert"`; 44px targets; disabled-while-submitting.

- [ ] **Step 2: Verify** — `npx tsc --noEmit 2>&1 | grep "app/adjusting/\[cid\]" || echo clean`. Manual: as carrier, open a claim → decide coverage → reserve (see hint) → pay → close.

- [ ] **Step 3: Commit**
```bash
git add "frontend/src/app/adjusting/[cid]/page.tsx"
git commit -F - <<'EOF'
feat(carrier-web): adjuster claim detail (decide-coverage-first + reserve hint)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 11: Operator coverage badge + rationale (web)

**Files:** Modify the operator claim tracker in `frontend/src/app/claims/page.tsx` (`OperatorClaimsTracker`).

- [ ] **Step 1:** Where each operator claim is rendered, read `coverage_decision`/`coverage_rationale` (now in the venue-scoped claim payload) and render a **coverage badge** (Covered = success, Reservation of rights = warning, Denied = danger — color **and** text) plus the rationale text, surfaced especially on denial ("Coverage: Denied — {rationale}"). Reuse a status-pill style already in that file.

- [ ] **Step 2: Verify** — `npx tsc --noEmit 2>&1 | grep "app/claims/page" || echo clean`.

- [ ] **Step 3: Commit**
```bash
git add frontend/src/app/claims/page.tsx
git commit -F - <<'EOF'
feat(operator-web): show carrier coverage decision + rationale on the claim tracker
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 12: Mobile — adjuster desk + Claims tab + operator coverage badge

**Files:** Create `mobile/src/api/adjusting.ts`, `mobile/src/navigation/AdjustingStack.tsx`, `mobile/src/screens/AdjusterQueueScreen.tsx`, `mobile/src/screens/AdjusterClaimDetailScreen.tsx`; modify `mobile/src/navigation/TabNavigator.tsx` (CarrierTabs); modify the operator claim view for the coverage badge.

**Run `ui-ux-pro-max`. Reuse the `Field` primitive, theme tokens, `tierColor`/claim-token tables; accordions with `accessibilityState={{expanded}}`; 44pt targets.**

- [ ] **Step 1:** `mobile/src/api/adjusting.ts` — mirror the web lib (use `api.request` for GETs; custom `fetch` + `getToken` for POSTs, like `mobile/src/api/underwriting.ts`).
- [ ] **Step 2:** `CarrierTabs` (in `TabNavigator.tsx`) gains a 2nd tab **Claims** → `AdjustingStack` (with `AdjusterQueueScreen` + `AdjusterClaimDetailScreen`). Add an icon to `ICONS`/`TAB_LABELS` (reuse `FileSpreadsheet`).
- [ ] **Step 3:** `AdjusterQueueScreen` — FlatList mirroring `UnderwritingDeskScreen`, rows with status + coverage chips (color+text). `AdjusterClaimDetailScreen` — decide-coverage-first (chips for covered/RoR/denied + rationale Field) → reserve (Field + advisory hint line) → payment → close; reuse `CarrierClaimDetailScreen` presentation where practical; calls `/api/adjusting/*`.
- [ ] **Step 4:** Operator claim view (mobile tracker) shows the coverage badge + rationale (mirror web Task 11).
- [ ] **Step 5: Verify** — `cd mobile && npx tsc --noEmit 2>&1 | tail -3` (exit 0).
- [ ] **Step 6: Commit**
```bash
git add mobile/src/api/adjusting.ts mobile/src/navigation/AdjustingStack.tsx mobile/src/navigation/TabNavigator.tsx mobile/src/screens/AdjusterQueueScreen.tsx mobile/src/screens/AdjusterClaimDetailScreen.tsx
git commit -F - <<'EOF'
feat(carrier-mobile): adjuster desk (Claims tab, queue + decide-coverage-first detail) + operator coverage badge
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 13: Full verification

- [ ] **Step 1:** `rm -f backend/database.db && cd backend && python -m pytest -q` → all pass.
- [ ] **Step 2:** `cd frontend && npx tsc --noEmit 2>&1 | grep "^src/" || echo "web clean"`; `cd mobile && npx tsc --noEmit 2>&1 | tail -3` (exit 0).
- [ ] **Step 3: Manual loop** (carrier + operator demo users): operator-filed claim → carrier adjuster queue → decide coverage (try a denial) → reserve (see hint) → pay → close → operator sees the coverage outcome + rationale.
- [ ] **Step 4:** `git push`.

---

## Landmines (carry from spec §6)
- New `claim` columns need the `_COLUMN_MIGRATIONS` rows (Task 1) or existing-table SELECTs fail "no such column" on Postgres.
- `coverage_decided_at` is an ISO **string** (TEXT column), not a datetime.
- The indemnity coverage gate lives in the **adjuster wrapper** (`approve_payment`), NOT `record_payment` — keeps the broker relay path + its tests green.
- Every status mutation goes through `_transition_claim`; re-hash `snapshot_hash` on coverage mutations (decide_coverage does).
- `decision_source` defaults to `broker_relay` everywhere — the explicit regression guard for existing broker-claims tests.
- Reset `backend/database.db` before any full-suite run (API tests seed into it).
```
